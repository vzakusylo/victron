#!/usr/bin/env python3
# Test GX emulator: fake Victron D-Bus services with simple physics, controlled over HTTP.
# Runs inside the venus-docker container (needs velib_python and dbus-python from there).
#
#   com.victronenergy.system/0       Ac/Grid/L1/Power, Ac/Consumption/L1/Power, Dc/System/Power, Dc/Pv/Power, Notifications/Inject
#   com.victronenergy.vebus/276      Ac/In/1/CurrentLimit (written by the flow), State, Soc, ...
#   com.victronenergy.battery/289    Dc/0/Voltage, Dc/0/Current, Dc/0/Power, ConsumedAmphours, Soc
#   com.victronenergy.settings       left to localsettings; the flow's writes to it are recorded
#
# HTTP API (port 8081):
#   GET  /state                       inputs, computed values, faults
#   GET  /writes?since=<ts>           what the flow wrote (D-Bus outputs): [{ts, service, path, value}]
#   POST /set   {"path": "soc", "value": 35}       input (pv_w, load_w, soc, ...) or forced output (grid_w, batt_v, batt_a)
#   POST /stale {"path": "battery", "seconds": 900} freeze a service, or use "battery./Dc/0/Voltage" for one property
#   POST /fail  {"path": "battery", "mode": "invalid"|"offline"|"ok"}   invalid values / service disappears / back to normal
#   POST /reset                       defaults, no faults, no writes
#   POST /mqtt {"topic": "qingping/<fake mac>/up", "payload": {...}}  QoS 1 to the internal test broker
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from mqtt_publish import publish_message, validate_message
from tuya_devices import TuyaDevices
from forecast_fixture import forecast_fixture

sys.path.insert(1, '/opt/victronenergy/dbus-systemcalc-py/ext/velib_python')
import dbus  # noqa: E402
from dbus.mainloop.glib import DBusGMainLoop  # noqa: E402
from gi.repository import GLib  # noqa: E402
from vedbus import VeDbusService  # noqa: E402

DBusGMainLoop(set_as_default=True)

DEFAULTS = dict(pv_w=0.0, load_w=800.0, soc=60.0, cap_ah=280.0, bms_max_charge_a=100.0, bms_max_discharge_a=200.0,
                grid_max_w=20000.0, time_scale=1.0)
FORCEABLE = ('grid_w', 'batt_v', 'batt_a', 'consumed_ah')
SERVICES = ('system', 'vebus', 'battery')
BMS_DEFAULTS = dict(present=False, connected=False, active=False, instance=-1, passthru=False)

lock = threading.Lock()
state = dict(DEFAULTS)
bms = dict(BMS_DEFAULTS)
forced = {}
stale_until = {}      # service or service.property -> unix time
failed = {}           # service -> 'invalid' | 'offline'
writes = []
ready = False         # API answers 200 only after all services are registered and the startup write is dropped
computed = dict(grid_w=0.0, batt_w=0.0, batt_a=0.0, batt_v=51.2, consumed_ah=0.0)
services = {}
buses = {}
mqtt_client = None


def tuya_publish(topic, payload):
    # Retain only status: replaying old retained data after an offline event could make a fresh proxy look online.
    if mqtt_client is None or not mqtt_client.is_connected():
        raise RuntimeError('Tuya MQTT broker unavailable')
    info = mqtt_client.publish(topic, json.dumps(payload, allow_nan=False), qos=1, retain=topic.endswith('/state'))
    if info.rc != 0:
        raise RuntimeError('Tuya MQTT publication failed: ' + str(info.rc))


def tuya_record(item):
    writes.append(dict(ts=time.time(), **item))   # caller already holds lock


tuya = TuyaDevices(tuya_publish, tuya_record)


def record(service, path, value):
    if isinstance(value, dbus.Array) and not len(value):
        value = None
    with lock:
        writes.append(dict(ts=time.time(), service=service, path=path, value=value))


def build(name):
    """Create one fake service on its own bus connection, so that closing the connection removes it from D-Bus."""
    bus = dbus.SystemBus(private=True)
    bus.set_exit_on_disconnect(False)   # closing the connection on purpose must not terminate the process
    info = dict(system=('com.victronenergy.system', 0, 'Venus emulator'),
                vebus=('com.victronenergy.vebus.emulator', 276, 'MultiPlus-II 48/5000 (emulated)'),
                battery=('com.victronenergy.battery.emulator', 289, 'SmartShunt (emulated)'))[name]
    svc = VeDbusService(info[0], bus=bus, register=False)
    svc.add_mandatory_paths('test-gx-emulator', '1.0', 'emulated', info[1], 0, info[2], 0x0510, '1', 1)
    # fake identity for the Devices page; never a real serial number
    svc.add_path('/CustomName', {'system': 'Test GX', 'vebus': 'MultiPlus (emu)', 'battery': 'SmartShunt (emu)'}[name])
    svc.add_path('/Serial', 'HQEMU0001')

    def writer(path, value):
        record(name, path, value)
        return True
    if name == 'system':
        for p in ('/Ac/Grid/L1/Power', '/Ac/Consumption/L1/Power', '/Dc/System/Power', '/Dc/Pv/Power', '/Dc/Battery/Soc',
                  '/Dc/Battery/Voltage', '/Dc/Battery/Current', '/Dc/Battery/Power'):
            svc.add_path(p, 0.0)
        svc.add_path('/Notifications/Inject', '', writeable=True, onchangecallback=writer)
    elif name == 'vebus':
        svc.add_path('/Ac/In/1/CurrentLimit', 25.0, writeable=True, onchangecallback=writer)
        for p, v in (('/State', 3), ('/Mode', 3), ('/Soc', 60.0), ('/Ac/ActiveIn/Connected', 1),
                     ('/Ac/ActiveIn/L1/P', 0.0), ('/Ac/Out/L1/P', 0.0), ('/Dc/0/Voltage', 51.2), ('/Dc/0/Current', 0.0), ('/VebusError', 0)):
            svc.add_path(p, v)
    else:
        for p, v in (('/Dc/0/Voltage', 51.2), ('/Dc/0/Current', 0.0), ('/Dc/0/Power', 0.0), ('/ConsumedAmphours', 0.0),
                     ('/Soc', 60.0), ('/Info/MaxChargeCurrent', 100.0), ('/Info/MaxDischargeCurrent', 200.0), ('/Dc/0/Temperature', 20.0)):
            svc.add_path(p, v)
    svc.register()
    buses[name], services[name] = bus, svc


def drop(name):
    if name in buses:
        services.pop(name, None)
        buses.pop(name).close()


def settings_value(path, fallback, strict=False):
    try:
        obj = dbus.SystemBus().get_object('com.victronenergy.settings', path)
        return float(obj.GetValue(dbus_interface='com.victronenergy.BusItem'))
    except Exception:
        if strict:
            raise
        return fallback


def vebus_limit_a():
    svc = services.get('vebus')
    value = svc['/Ac/In/1/CurrentLimit'] if svc else None
    return 25.0 if value is None else float(value)


class ActuatorResetError(RuntimeError):
    pass


def actuator_outputs():
    outputs = []
    for service, path in (('settings', '/Settings/SystemSetup/MaxChargeCurrent'),
                          ('settings', '/Settings/CGwacs/AcPowerSetPoint'),
                          ('vebus', '/Ac/In/1/CurrentLimit')):
        item = dict(service=service, path=path)
        try:
            if service == 'settings':
                value = settings_value(path, None, strict=True)
            else:
                if 'vebus' not in services:
                    raise ValueError('VE.Bus service is unavailable')
                value = services['vebus'][path]
            item['value'] = float(value)
        except (dbus.DBusException, TypeError, ValueError) as error:
            item.update(value=None, error=str(error))
        outputs.append(item)
    return outputs


def reset_outputs():
    if 'vebus' not in services:
        raise ActuatorResetError('VE.Bus service is unavailable')
    bus = dbus.SystemBus()
    for path, number in (('/Settings/SystemSetup/MaxChargeCurrent', -1.0),
                         ('/Settings/CGwacs/AcPowerSetPoint', 0.0)):
        obj = bus.get_object('com.victronenergy.settings', path)
        result = obj.SetValue(dbus.Double(number), dbus_interface='com.victronenergy.BusItem')
        if result != 0:
            raise ActuatorResetError('Could not reset emulator output ' + path + ': ' + str(result))
    services['vebus']['/Ac/In/1/CurrentLimit'] = 25.0


def physics(dt):
    """Battery power = PV - loads + grid. The ESS setpoint decides the grid; the input current limit and the BMS clip it."""
    s = state
    setpoint = settings_value('/Settings/CGwacs/AcPowerSetPoint', 0.0)
    max_charge = settings_value('/Settings/SystemSetup/MaxChargeCurrent', -1.0)
    volts = forced.get('batt_v', 44.0 + 0.1 * s['soc'])
    charge_a = s['bms_max_charge_a'] if max_charge < 0 else min(s['bms_max_charge_a'], max_charge)
    grid_cap = min(vebus_limit_a() * 230.0, s['grid_max_w'])
    grid = max(-s['grid_max_w'], min(setpoint, grid_cap))
    batt_w = s['pv_w'] - s['load_w'] + grid
    batt_w = min(batt_w, charge_a * volts)
    batt_w = max(batt_w, -s['bms_max_discharge_a'] * volts)
    if (s['soc'] >= 100 and batt_w > 0) or (s['soc'] <= 0 and batt_w < 0):
        batt_w = 0
    grid = min(s['load_w'] - s['pv_w'] + batt_w, grid_cap)
    amps = batt_w / volts
    s['soc'] = max(0.0, min(100.0, s['soc'] + amps * dt * s['time_scale'] / 3600.0 / s['cap_ah'] * 100.0))
    computed.update(grid_w=grid, batt_w=batt_w, batt_a=amps, batt_v=volts, consumed_ah=-(100.0 - s['soc']) / 100.0 * s['cap_ah'])
    computed.update(forced)


def publish(name):
    c, s = computed, state
    kind = failed.get(name)
    svc = services.get(name)
    if not svc or (name in stale_until and stale_until[name] > time.time()):
        return
    def update(path, value):
        if stale_until.get(f'{name}.{path}', 0) <= time.time():
            svc[path] = None if kind == 'invalid' else value
    if name == 'system':
        update('/Ac/Grid/L1/Power', round(c['grid_w'], 1))
        update('/Ac/Consumption/L1/Power', round(s['load_w'], 1))
        update('/Dc/System/Power', 0.0)
        update('/Dc/Pv/Power', round(s['pv_w'], 1))
        update('/Dc/Battery/Soc', round(s['soc'], 1))
        update('/Dc/Battery/Voltage', round(c['batt_v'], 2))
        update('/Dc/Battery/Current', round(c['batt_a'], 2))
        update('/Dc/Battery/Power', round(c['batt_w'], 1))
    elif name == 'vebus':
        update('/Soc', round(s['soc'], 1))
        update('/Ac/ActiveIn/L1/P', round(c['grid_w'], 1))
        update('/Ac/Out/L1/P', round(s['load_w'], 1))
        update('/Dc/0/Voltage', round(c['batt_v'], 2))
        update('/Dc/0/Current', round(c['batt_a'], 2))
    else:
        update('/Dc/0/Voltage', round(c['batt_v'], 2))
        update('/Dc/0/Current', round(c['batt_a'], 2))
        update('/Dc/0/Power', round(c['batt_w'], 1))
        update('/ConsumedAmphours', round(c['consumed_ah'], 2))
        update('/Soc', round(s['soc'], 1))
        update('/Info/MaxChargeCurrent', s['bms_max_charge_a'])
        update('/Info/MaxDischargeCurrent', s['bms_max_discharge_a'])


last = [time.time()]


def tick():
    now = time.time()
    dt, last[0] = now - last[0], now
    try:
        with lock:
            physics(dt)
            for name in SERVICES:
                if failed.get(name) == 'offline':
                    drop(name)
                elif name not in services:
                    build(name)
                publish(name)
            tuya.tick(dt)
    except Exception as error:
        print('tick failed:', repr(error), flush=True)
    return True


MAX_CHARGE = '/Settings/SystemSetup/MaxChargeCurrent'
startup_write_pending = False   # our own SetValue(-1) is in flight; its signal is not a flow write
signal_seen = False
timed_out = False


# test hook: hold the API in 503 for this many seconds after start so the not-ready answers can be checked
READY_DELAY = float(os.environ.get('EMU_READY_DELAY', '0'))
STARTED = time.time()


def mark_ready(by_timeout=False):
    global ready
    wait = STARTED + READY_DELAY - time.time()
    if wait > 0:
        GLib.timeout_add(int(wait * 1000) + 50, mark_ready, by_timeout)
        return False
    with lock:
        if ready:
            return False
        ready = True
    if by_timeout and not signal_seen:
        print('ready by timeout, startup write signal not seen', flush=True)
    print('emulator up: system/0, vebus/276, battery/289, api :8081', flush=True)
    return False


def ready_by_timeout():
    # no startup signal came: later MaxChargeCurrent writes are the flow's and must be recorded
    global startup_write_pending, timed_out
    startup_write_pending = False
    timed_out = True
    return mark_ready(True)


def on_settings_change(changes, path=None):
    # PropertiesChanged of a settings item: the flow wrote it
    global startup_write_pending, signal_seen
    if startup_write_pending and str(path) == MAX_CHARGE:
        startup_write_pending = False
        signal_seen = True
        mark_ready()
        return
    value = changes.get('Value') if hasattr(changes, 'get') else None
    if isinstance(value, dbus.Array):
        value = None
    elif isinstance(value, (dbus.Double, dbus.Int32, dbus.Int64, int, float)):
        value = float(value)
    elif value is not None:
        value = str(value)
    if timed_out and not signal_seen and str(path) == MAX_CHARGE and value == -1.0:
        signal_seen = True
        print('late startup signal recorded as write', flush=True)
    record('settings', str(path), value)


def apply_set(path, value):
    if path in FORCEABLE:
        forced[path] = float(value)
    elif path in state:
        state[path] = float(value)
    else:
        raise KeyError('unknown path ' + path + '; inputs: ' + ', '.join(state) + '; forced outputs: ' + ', '.join(FORCEABLE))


def service_of(path):
    name = path.split('.')[0]
    if name not in SERVICES:
        raise KeyError('unknown service ' + name + '; use ' + ', '.join(SERVICES))
    return name


class Api(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/forecast':
            try:
                return self._send(200, forecast_fixture(parse_qs(url.query)))
            except (ValueError, TypeError) as error:
                return self._send(400, dict(error=str(error)))
        with lock:
            if not ready:
                return self._send(503, dict(error='starting'))
            if url.path == '/state':
                now = time.time()
                return self._send(200, dict(inputs=state, computed=computed, forced=forced, failed=failed, now=now,
                                            stale={k: round(v - now) for k, v in stale_until.items() if v > now},
                                            outputs=actuator_outputs(),
                                            tuya=tuya.snapshot(), bms=bms,
                                            vebus_current_limit_a=vebus_limit_a() if 'vebus' in services else None))
            if url.path == '/writes':
                since = float(parse_qs(url.query).get('since', ['0'])[0])
                return self._send(200, [w for w in writes if w['ts'] > since])
        self._send(404, dict(error='not found'))

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
            if self.path in ('/set', '/stale', '/fail') and (not isinstance(body, dict) or not isinstance(body.get('path'), str)):
                raise ValueError('path must be a string')
            if self.path == '/reset':
                if not isinstance(body, dict) or 'outputs' in body and not isinstance(body['outputs'], bool):
                    raise ValueError('reset outputs must be a boolean')
                if body.get('outputs'):
                    with lock:
                        if not ready:
                            return self._send(503, dict(error='starting'))
                    reset_outputs()
            if self.path == '/mqtt':
                with lock:
                    if not ready:
                        return self._send(503, dict(error='starting'))
                topic, payload = validate_message(body)
                publish_message(topic, payload)
                return self._send(200, dict(ok=True))
            with lock:
                if not ready:
                    return self._send(503, dict(error='starting'))
                if self.path == '/set':
                    if body['path'].startswith('tuya.'):
                        parts = body['path'].split('.')
                        if len(parts) != 4 or parts[2] != 'dps':
                            raise ValueError('use tuya.<device>.dps.<number>')
                        tuya.set(parts[1], parts[3], body['value'])
                    elif body['path'].startswith('bms.'):
                        field = body['path'][4:]
                        if field not in BMS_DEFAULTS or type(body['value']) is not type(BMS_DEFAULTS[field]):
                            raise ValueError('invalid BMS fixture input')
                        bms[field] = body['value']
                    else:
                        apply_set(body['path'], body['value'])
                elif self.path == '/bms-repair':
                    instance = body.get('instance')
                    if type(instance) is not int:
                        raise ValueError('BmsInstance must be an integer')
                    bms['instance'] = instance
                    writes.append(dict(ts=time.time(), service='settings', path='/Settings/SystemSetup/BmsInstance',
                                       value=instance))
                elif self.path == '/stale':
                    if body['path'].startswith('tuya.'):
                        tuya.stale(body['path'][5:], body.get('seconds'))
                    else:
                        name, dot, prop = body['path'].partition('.')
                        name = service_of(name)
                        if dot and (not prop.startswith('/') or prop not in services[name]):
                            raise KeyError('unknown property ' + body['path'])
                        stale_until[body['path']] = time.time() + float(body['seconds'])
                elif self.path == '/fail':
                    mode = body.get('mode', 'invalid')
                    if body['path'].startswith('tuya.'):
                        tuya.fail(body['path'][5:], mode)
                    elif mode == 'ok':
                        name = service_of(body['path'])
                        failed.pop(name, None)
                    elif mode in ('invalid', 'offline'):
                        failed[service_of(body['path'])] = mode
                    else:
                        raise KeyError('mode must be invalid, offline or ok')
                elif self.path == '/reset':
                    state.clear()
                    state.update(DEFAULTS)
                    forced.clear()
                    stale_until.clear()
                    failed.clear()
                    bms.update(BMS_DEFAULTS)
                    writes.clear()
                    tuya.reset()
                else:
                    return self._send(404, dict(error='not found'))
            self._send(200, dict(ok=True))
        except (KeyError, ValueError, TypeError) as error:
            self._send(400, dict(error=str(error)))
        except (ActuatorResetError, dbus.DBusException) as error:
            print('Actuator reset failed:', str(error), flush=True)
            self._send(503, dict(error='Emulator actuator reset failed: ' + str(error)))
        except (ImportError, OSError, RuntimeError) as error:
            print('MQTT publish failed:', str(error), flush=True)
            self._send(503, dict(error='MQTT broker unavailable or publication failed'))


def main():
    import paho.mqtt.client as mqtt
    global mqtt_client
    mqtt_client = mqtt.Client()
    connected = threading.Event()

    def on_connect(client, userdata, flags, rc):
        if rc != 0:
            print('Tuya MQTT connection rejected:', rc, flush=True)
            return
        result, _ = client.subscribe('tuya/+/command', qos=1)
        if result != mqtt.MQTT_ERR_SUCCESS:
            print('Tuya MQTT subscription failed:', result, flush=True)
            return
        with lock:
            tuya.announce(force=True)

    def on_subscribe(client, userdata, mid, granted_qos):
        if not granted_qos or any(q >= 128 for q in granted_qos):
            print('Tuya MQTT command subscription rejected:', granted_qos, flush=True)
            return
        connected.set()

    def on_message(client, userdata, message):
        name = message.topic.split('/')[1]
        try:
            if message.retain:
                raise ValueError('retained Tuya commands are not accepted')
            with lock:
                tuya.command(name, json.loads(message.payload))
        except (KeyError, ValueError, TypeError) as error:
            print('Tuya command rejected:', str(error), flush=True)
            try:
                with lock:
                    tuya.error(name)
            except (KeyError, RuntimeError) as publish_error:
                print('Tuya MQTT error publication failed:', str(publish_error), flush=True)
        except RuntimeError as error:
            print('Tuya MQTT command response failed:', str(error), flush=True)

    mqtt_client.on_connect = on_connect
    mqtt_client.on_message = on_message
    mqtt_client.on_subscribe = on_subscribe
    mqtt_client.connect('mosquitto', 1883, 30)
    mqtt_client.loop_start()
    if not connected.wait(10):
        raise RuntimeError('Tuya MQTT connection/subscription did not become ready')
    sysbus = dbus.SystemBus()
    sysbus.add_signal_receiver(on_settings_change, signal_name='PropertiesChanged', dbus_interface='com.victronenergy.BusItem',
                               bus_name='com.victronenergy.settings', path_keyword='path')
    global startup_write_pending
    try:
        obj = sysbus.get_object('com.victronenergy.settings', MAX_CHARGE)
        try:
            current = float(obj.GetValue(dbus_interface='com.victronenergy.BusItem'))
        except Exception:   # empty array or no value: still reset it
            current = None
        if current != -1.0:   # no DVCC limit until the flow sets one
            startup_write_pending = True
            obj.SetValue(-1.0, dbus_interface='com.victronenergy.BusItem')
    except Exception as error:
        print('could not set MaxChargeCurrent:', error, flush=True)
    for name in SERVICES:
        build(name)
    GLib.timeout_add(1000, tick)

    if startup_write_pending:
        GLib.timeout_add(10000, ready_by_timeout)   # fallback when the signal never comes
    else:
        mark_ready()
    server = ThreadingHTTPServer(('0.0.0.0', 8081), Api)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    GLib.MainLoop().run()


if __name__ == '__main__':
    main()
