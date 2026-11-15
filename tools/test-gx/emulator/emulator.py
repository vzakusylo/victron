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
#   POST /stale {"path": "battery", "seconds": 900} freeze the values on D-Bus (service stays, data stops changing)
#   POST /fail  {"path": "battery", "mode": "invalid"|"offline"|"ok"}   invalid values / service disappears / back to normal
#   POST /reset                       defaults, no faults, no writes
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

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

lock = threading.Lock()
state = dict(DEFAULTS)
forced = {}
stale_until = {}      # service -> unix time
failed = {}           # service -> 'invalid' | 'offline'
writes = []
ready = False         # API answers 200 only after all services are registered and the startup write is dropped
computed = dict(grid_w=0.0, batt_w=0.0, batt_a=0.0, batt_v=51.2, consumed_ah=0.0)
services = {}
buses = {}


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
    svc.add_mandatory_paths('test-gx-emulator', '1.0', 'emulated', info[1], 0, info[2], '1', '1', 1)

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
                     ('/Ac/ActiveIn/L1/P', 0.0), ('/Ac/Out/L1/P', 0.0), ('/Dc/0/Voltage', 51.2), ('/Dc/0/Current', 0.0)):
            svc.add_path(p, v)
    else:
        for p, v in (('/Dc/0/Voltage', 51.2), ('/Dc/0/Current', 0.0), ('/Dc/0/Power', 0.0), ('/ConsumedAmphours', 0.0),
                     ('/Soc', 60.0), ('/Info/MaxChargeCurrent', 100.0), ('/Info/MaxDischargeCurrent', 200.0)):
            svc.add_path(p, v)
    svc.register()
    buses[name], services[name] = bus, svc


def drop(name):
    if name in buses:
        services.pop(name, None)
        buses.pop(name).close()


def settings_value(path, fallback):
    try:
        obj = dbus.SystemBus().get_object('com.victronenergy.settings', path)
        return float(obj.GetValue(dbus_interface='com.victronenergy.BusItem'))
    except Exception:
        return fallback


def vebus_limit_a():
    svc = services.get('vebus')
    value = svc['/Ac/In/1/CurrentLimit'] if svc else None
    return 25.0 if value is None else float(value)


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
    value = lambda v: None if kind == 'invalid' else v
    if name == 'system':
        svc['/Ac/Grid/L1/Power'] = value(round(c['grid_w'], 1))
        svc['/Ac/Consumption/L1/Power'] = value(round(s['load_w'], 1))
        svc['/Dc/System/Power'] = value(0.0)
        svc['/Dc/Pv/Power'] = value(round(s['pv_w'], 1))
        svc['/Dc/Battery/Soc'] = value(round(s['soc'], 1))
        svc['/Dc/Battery/Voltage'] = value(round(c['batt_v'], 2))
        svc['/Dc/Battery/Current'] = value(round(c['batt_a'], 2))
        svc['/Dc/Battery/Power'] = value(round(c['batt_w'], 1))
    elif name == 'vebus':
        svc['/Soc'] = value(round(s['soc'], 1))
        svc['/Ac/ActiveIn/L1/P'] = value(round(c['grid_w'], 1))
        svc['/Ac/Out/L1/P'] = value(round(s['load_w'], 1))
        svc['/Dc/0/Voltage'] = value(round(c['batt_v'], 2))
        svc['/Dc/0/Current'] = value(round(c['batt_a'], 2))
    else:
        svc['/Dc/0/Voltage'] = value(round(c['batt_v'], 2))
        svc['/Dc/0/Current'] = value(round(c['batt_a'], 2))
        svc['/Dc/0/Power'] = value(round(c['batt_w'], 1))
        svc['/ConsumedAmphours'] = value(round(c['consumed_ah'], 2))
        svc['/Soc'] = value(round(s['soc'], 1))
        svc['/Info/MaxChargeCurrent'] = value(s['bms_max_charge_a'])
        svc['/Info/MaxDischargeCurrent'] = value(s['bms_max_discharge_a'])


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
    except Exception as error:
        print('tick failed:', repr(error), flush=True)
    return True


def on_settings_change(changes, path=None):
    # PropertiesChanged of a settings item: the flow wrote it
    value = changes.get('Value') if hasattr(changes, 'get') else None
    if isinstance(value, dbus.Array):
        value = None
    elif isinstance(value, (dbus.Double, dbus.Int32, dbus.Int64, int, float)):
        value = float(value)
    elif value is not None:
        value = str(value)
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
        with lock:
            if not ready:
                return self._send(503, dict(error='starting'))
            if url.path == '/state':
                now = time.time()
                return self._send(200, dict(inputs=state, computed=computed, forced=forced, failed=failed, now=now,
                                            stale={k: round(v - now) for k, v in stale_until.items() if v > now},
                                            vebus_current_limit_a=vebus_limit_a() if 'vebus' in services else None))
            if url.path == '/writes':
                since = float(parse_qs(url.query).get('since', ['0'])[0])
                return self._send(200, [w for w in writes if w['ts'] > since])
        self._send(404, dict(error='not found'))

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
            with lock:
                if self.path == '/set':
                    apply_set(body['path'], body['value'])
                elif self.path == '/stale':
                    stale_until[service_of(body['path'])] = time.time() + float(body['seconds'])
                elif self.path == '/fail':
                    name, mode = service_of(body['path']), body.get('mode', 'invalid')
                    if mode == 'ok':
                        failed.pop(name, None)
                    elif mode in ('invalid', 'offline'):
                        failed[name] = mode
                    else:
                        raise KeyError('mode must be invalid, offline or ok')
                elif self.path == '/reset':
                    state.clear()
                    state.update(DEFAULTS)
                    forced.clear()
                    stale_until.clear()
                    failed.clear()
                    writes.clear()
                else:
                    return self._send(404, dict(error='not found'))
            self._send(200, dict(ok=True))
        except (KeyError, ValueError, TypeError) as error:
            self._send(400, dict(error=str(error)))


def main():
    sysbus = dbus.SystemBus()
    sysbus.add_signal_receiver(on_settings_change, signal_name='PropertiesChanged', dbus_interface='com.victronenergy.BusItem',
                               bus_name='com.victronenergy.settings', path_keyword='path')
    try:
        obj = sysbus.get_object('com.victronenergy.settings', '/Settings/SystemSetup/MaxChargeCurrent')
        obj.SetValue(-1.0, dbus_interface='com.victronenergy.BusItem')   # no DVCC limit until the flow sets one
    except Exception as error:
        print('could not set MaxChargeCurrent:', error, flush=True)
    for name in SERVICES:
        build(name)
    GLib.timeout_add(1000, tick)

    def finish_startup():
        # the signal for our own startup SetValue arrives only now; drop it so /writes holds the flow's writes only
        global ready
        with lock:
            writes.clear()
            ready = True
        print('emulator up: system/0, vebus/276, battery/289, api :8081', flush=True)
        return False
    GLib.timeout_add(1500, finish_startup)
    server = ThreadingHTTPServer(('0.0.0.0', 8081), Api)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    GLib.MainLoop().run()


if __name__ == '__main__':
    main()
