"""Four test-only Tuya devices. MQTT envelopes mirror palette 5.4.0, not the local protocol."""
import base64
import copy
import json
import math
from pathlib import Path
import time

MODEL = json.loads(Path(__file__).with_name('tuya-model.json').read_text())


class TuyaDevices:
    def __init__(self, publish, record):
        self.publish = publish
        self.record = record
        self.reset(announce=False)

    def reset(self, announce=True):
        self.devices = {name: dict(dps={dp: copy.deepcopy(s['default']) for dp, s in schema.items() if not s.get('optional')},
                                   failed=None, stale_until=0) for name, schema in MODEL.items()}
        self.power_w = 0
        self.energy_wh = 0
        self.last_status = {}
        if announce:
            self.announce()

    def device(self, name):
        if name not in self.devices:
            raise KeyError('unknown Tuya device ' + name)
        return self.devices[name]

    def validate(self, name, dp, value, write=False):
        self.device(name)
        spec = MODEL[name].get(str(dp))
        if not spec:
            raise KeyError('unmodelled Tuya DPS ' + name + '.' + str(dp))
        if write and not spec.get('write'):
            raise ValueError('read-only Tuya DPS ' + name + '.' + str(dp))
        if spec.get('type') == 'boolean':
            valid = isinstance(value, bool)
        elif 'enum' in spec:
            valid = value in spec['enum']
        elif spec.get('type') == 'base64':
            try:
                valid = isinstance(value, str) and len(base64.b64decode(value, validate=True)) == 8
            except ValueError:
                valid = False
        else:
            valid = (isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                     and spec['min'] <= value <= (spec.get('writeMax', spec['max']) if write else spec['max']))
        if not valid:
            raise ValueError('invalid value for Tuya DPS ' + name + '.' + str(dp))

    def announce(self, name=None, force=False):
        for role in [name] if name else self.devices:
            d = self.device(role)
            if d['stale_until'] > time.time():
                continue
            status = 'DISCONNECTED' if d['failed'] == 'offline' else 'CONNECTED'
            if force or self.last_status.get(role) != status:
                self.publish('tuya/' + role + '/state', dict(state=status))
                self.last_status[role] = status
            if d['failed'] == 'offline':
                continue
            data = copy.deepcopy(d['dps'])
            if d['failed'] == 'invalid':
                if role == 'pump':
                    data.update({'101': -127, '102': -127, '108': -127, '112': None, '115': 0})
                elif role == 'meter':
                    data.update({'6': '', '1': 0})
                else:
                    data['1'] = None
            self.publish('tuya/' + role + '/data', dict(dps=data, t=int(time.time())))

    def command(self, name, payload):
        d = self.device(name)
        if not isinstance(payload, dict):
            raise ValueError('Tuya command must be an object')
        operation = payload.get('operation') or 'SET'
        if operation in ('GET', 'REFRESH'):
            self.record(dict(device=name, operation=operation, dps=payload.get('dps'), value=None, applied=False))
            self.announce(name)
            return
        if operation != 'SET':
            raise ValueError('unsupported Tuya operation ' + str(operation))
        if payload.get('multiple') is True:
            changes = payload.get('data')
            if not isinstance(changes, dict) or not changes:
                raise ValueError('multiple SET requires a nonempty data object')
        else:
            if 'set' not in payload:
                raise ValueError('SET requires set')
            changes = {str(payload.get('dps', 1)): payload['set']}
        # Validate the whole command before applying any DPS (a failed batch must not partly switch valves).
        for dp, value in changes.items():
            self.validate(name, dp, value, write=True)
        online = d['failed'] != 'offline'
        for dp, value in changes.items():
            self.record(dict(device=name, operation=operation, dps=str(dp), value=value, applied=online))
        if online:
            d['dps'].update({str(dp): v for dp, v in changes.items()})
        self.announce(name)

    def error(self, name):
        self.device(name)
        self.publish('tuya/' + name + '/state', dict(state='ERROR'))
        self.last_status[name] = 'ERROR'

    def set(self, name, dp, value):
        self.validate(name, dp, value)
        self.device(name)['dps'][str(dp)] = value
        if name == 'boiler':
            self.devices['pump']['dps'][str(dp)] = value
            self.announce('pump')
            return
        if name == 'pump' and str(dp) == '108':
            self.devices['boiler']['dps']['108'] = value
        self.announce(name)

    def stale(self, name, seconds=None):
        if seconds is not None and (not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds < 0):
            raise ValueError('stale seconds must be finite and nonnegative')
        self.device(name)['stale_until'] = time.time() + seconds if seconds is not None else math.inf
        if name == 'boiler':
            self.stale('pump', seconds)

    def fail(self, name, mode):
        if mode not in ('ok', 'offline', 'invalid'):
            raise ValueError('Tuya mode must be ok, offline or invalid')
        d = self.device(name)
        d['failed'] = None if mode == 'ok' else mode
        if mode == 'ok':
            d['stale_until'] = 0
        if name == 'boiler':
            self.fail('pump', mode)
            return
        self.announce(name)

    def local_reading(self, name):
        d = self.device(name)
        if name != 'boiler':
            raise KeyError('unknown local Tuya reading ' + name)
        pump = self.devices['pump']
        state = 'DISCONNECTED' if pump['failed'] == 'offline' else 'STALE' if pump['stale_until'] > time.time() else 'CONNECTED'
        dps = copy.deepcopy(d['dps'])
        if pump['failed'] == 'invalid':
            dps['108'] = -127
        return dict(state=state, t=int(time.time() * 1000), dps=dps)

    def tick(self, dt):
        hp = self.devices['pump']
        p = hp['dps']
        running = p['1'] and hp['failed'] != 'offline'
        dhw = self.devices['valve']['dps']['1'] and not self.devices['bypass']['dps']['1']
        target = min(60, max(20, 20 + p['134'] / 10 * (p['133'] - p['103']))) if p['132'] == '1' else p['125']
        self.power_w = (900 if p['2'] == 'mute' else 1600) if running and target > p['101'] else 0
        p['115'], p['116'], p['112'] = (40, 600, round(self.power_w / 230, 2)) if self.power_w else (0, 0, 0)
        if p['132'] == '1':
            p['125'] = round(target)
        approach = min(1, max(0, dt) / 60)
        p['102'] = round(p['102'] + ((target if self.power_w else p['101']) - p['102']) * approach, 2)
        p['101'] = round(p['101'] + (p['102'] - p['101'] - (5 if self.power_w else 0)) * approach, 2)
        boiler = self.devices['boiler']['dps']
        heating = running and dhw and self.power_w
        tank = boiler['108']
        if heating and tank < p['102']:
            tank = min(p['102'], tank + max(0, dt) * 0.01)
        else:
            tank = max(0, tank - max(0, dt) * 0.005)
        boiler['108'] = round(tank, 2)
        p['108'] = boiler['108']
        self.energy_wh += self.power_w * dt / 3600
        meter = self.devices['meter']['dps']
        meter['1'] = MODEL['meter']['1']['default'] + int(self.energy_wh / 10)
        amps_ma = round(self.power_w / 230 * 1000)
        meter['6'] = base64.b64encode((2300).to_bytes(2, 'big') + amps_ma.to_bytes(3, 'big')
                                     + int(self.power_w).to_bytes(3, 'big')).decode()
        self.announce()

    def snapshot(self):
        return {name: dict(dps=copy.deepcopy(d['dps']), failed=d['failed'],
                           stale=d['stale_until'] > time.time()) for name, d in self.devices.items()}
