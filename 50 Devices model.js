// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `50 Devices model.js` and the embedded `func` for "Devices model" in `flows.json`
//   must always stay synchronized.
// Purpose:
// - Backend of the "Devices" dashboard page (51): every device and sensor with its online state.
//   - Tuya (local network): heat pump, boiler valve relay, exchanger bypass, SA1 power meter and
//     the two battery temperature sensors, from flow `heatPump` / `heatPumpModel` (34) and the
//     last local readings of tools/tuya-local-sensors.js (grid-control-config/tuya-local-sensors-last.json).
//   - Victron (D-Bus): every com.victronenergy.* device service (MultiPlus, batteries / shunts,
//     solar, system) with product, connection, instance, firmware and a few key values, read by
//     one python call (like "Driver checks dashboard", 31).
// Online rules:
// - Tuya mains devices: CONNECTED and data in the last STALE_MS (5 min).
// - Battery sensors: a local reading in the last SENSOR_STALE_H (they report on a change of
//   0.3 °C and periodically, the exchange plate every 40 min). Battery low = battery_state 'low'
//   or a percentage <= LOW_BAT_PCT.
// - Victron: /Connected = 1.
// Input (msg.topic):
// - 'ui'   (page 51) payload { action: 'open' | 'refresh' } -> read now
// - 'tick' (inject, 2 min) -> read
// - 'read' (exec stdout)   -> parse, build the model, output 1
// Output (2):
// - output 1 -> ui_template "Devices page", msg.payload = model
// - output 2 -> exec node "Read devices" (`sh -c <payload>`)
// Change notes:
// 1. Initial version (d#151).
// 2. d#152: every device of the Smart Life account (owner: "find all sensors in Smart Life and
//    migrate them to Devices"), from grid-control-config/tuya-devices-meta.json (no keys, made by
//    tools/tuya-devices-setup.js): mains devices are read on the local network by
//    tools/tuya-local-poll.js in this exec (every 2 min), sleeping battery sensors by
//    tools/tuya-local-sensors.js on their beacon. Values decoded with the DP map of the setup.
//    Devices offline in Smart Life at setup are listed separately. flow `deviceBatteries` feeds the
//    battery mails of 47.
// 3. d#153: battery sensors that send no beacon on the local network (stair, stue, vlada, the smoke
//    detectors: they report to the Tuya cloud only) are read from the cloud by
//    tools/tuya-cloud-sensors.js (every 30 min, only while there is no local reading for 24 h) and
//    marked 'cloud' on their card. Smoke detectors report about once a day: online for SMOKE_STALE_H.
// 4. d#156: Qingping Air Monitor card (group 'air') from flow `airMonitor` of "Air monitor" (52):
//    the monitor pushes its readings to the MQTT broker of the GX. Online with a reading in the
//    last AIR_STALE_MS.
// 5. d#158 (review of PR #13): AIR_STALE_MS 5 min (reports every 60 s); online by the time the GX
//    got the data (`seen`), not the monitor clock; only the known monitor MAC gets a card.
// 6. d#163: flow `devicesReport` = { at, devices: [{ id, name, group, online, lastData, battery, note,
//    link }] } for the daily devices mail of "Heat pump alerts" (47).
// 7. d#178 (review of PR #24): a mains device without an IP at setup but read by tools/tuya-local-poll.js
//    (IP found by its MAC in the ARP table) no longer shows the note "IP not found".
// ==========================

const CFG_DIR = '/data/home/nodered/grid-control-config';
const TOOLS_DIR = '/data/home/nodered/tools';
const POLL_STALE_MS = 6 * 60 * 1000;      // mains devices are polled every 2 min
// Smart Life DP codes shown on the cards: label, and how to show the value (after the DP scale)
const CODES = {
    temp_current: ['Temperature', '°C'], va_temperature: ['Temperature', '°C'], temp_value: ['Temperature', '°C'],
    humidity_value: ['Humidity', '%'], va_humidity: ['Humidity', '%'],
    co2_value: ['CO2', 'ppm'], ch2o_value: ['HCHO', 'mg/m³'], voc_value: ['VOC', 'ppm'], pm25_value: ['PM2.5', 'µg/m³'],
    smoke_sensor_state: ['Smoke', ''], smoke_sensor_status: ['Smoke', ''], tamper_alarm: ['Tamper', ''],
    switch_1: ['Switch', ''], switch: ['Switch', ''], switch_2: ['Switch 2', ''], switch_3: ['Switch 3', ''], switch_4: ['Switch 4', ''],
    cur_power: ['Power', 'W'], cur_voltage: ['Voltage', 'V'], cur_current: ['Current', 'A'],
    add_ele: ['Energy', 'kWh'], forward_energy_total: ['Energy total', 'kWh'], total_forward_energy: ['Energy total', 'kWh']
};
const BATTERY_CODES = ['battery_state', 'battery_percentage', 'va_battery', 'battery_value'];
const STALE_MS = 5 * 60 * 1000;
const SENSOR_STALE_H = 24;
const SMOKE_STALE_H = 48;                  // smoke detectors (ywbj) report about once a day
const LOW_BAT_PCT = 20;
const MIN_READ_GAP_MS = 20000;
// Qingping Air Monitor (52): reports every 60 s (retained interval command on its down topic)
const AIR = { mac: '582D34701F19', name: 'Air monitor', product: 'Qingping Air Monitor', ip: '192.168.1.58', broker: '192.168.1.94:1883' };
const AIR_STALE_MS = 5 * 60 * 1000;
const AIR_VALUES = [
    ['co2', 'CO2', 'ppm'], ['pm25', 'PM2.5', 'µg/m³'], ['pm10', 'PM10', 'µg/m³'], ['tvoc', 'tVOC', 'ppb'], ['tvoc_index', 'tVOC index', ''],
    ['temperature', 'Temperature', '°C'], ['humidity', 'Humidity', '%'], ['noise', 'Noise', 'dB'], ['battery', 'Battery', '%']
];

// Known network data of the Tuya devices (docs/heat-pump.md); the battery sensors also report it
// in their local readings.
const TUYA = {
    hp: { name: 'Heat pump', tuyaName: 'Heating pump', ip: '192.168.1.31', ver: '3.3', power: 'mains' },
    valve: { name: 'Boiler valve relay', tuyaName: 'Boiler', ip: '192.168.1.53', ver: '3.5', power: 'mains' },
    bypass: { name: 'Heat exchanger bypass', tuyaName: 'Off Heating exchange', ip: '192.168.1.139', ver: '3.4', power: 'mains' },
    meter: { name: 'Heat pump power meter SA1', tuyaName: 'SA1 Wi-Fi Smart Power Transformer', ip: '192.168.0.115', ver: '3.5', power: 'mains' },
    acc: { name: 'Accumulator tank sensor', tuyaName: 'Accumulator tank temp', ip: '', ver: '', power: 'battery' },
    plate: { name: 'Exchange plate sensor', tuyaName: 'Exchange plate', ip: '192.168.1.116', ver: '3.4', power: 'battery' }
};
const ORDER = ['hp', 'valve', 'bypass', 'meter', 'acc', 'plate'];

const PYTHON = [
    'import json, sys',
    'try:',
    '    import dbus',
    'except Exception as error:',
    '    print("@@DBUSJSON " + json.dumps({"error": "python dbus module: %s" % error}))',
    '    sys.exit(0)',
    'COMMON = ["/ProductName", "/CustomName", "/Connected", "/DeviceInstance", "/Mgmt/Connection", "/FirmwareVersion", "/Serial"]',
    'TYPE = ' + JSON.stringify({
        battery: ['/Dc/0/Voltage', '/Dc/0/Current', '/Dc/0/Power', '/Soc', '/Dc/0/Temperature'],
        vebus: ['/State', '/Ac/ActiveIn/L1/P', '/Ac/Out/L1/P', '/Dc/0/Voltage', '/VebusError'],
        solarcharger: ['/Yield/Power', '/Dc/0/Voltage', '/Dc/0/Current'],
        system: ['/Ac/Grid/L1/Power', '/Ac/Consumption/L1/Power', '/Dc/Pv/Power', '/Dc/Battery/Soc'],
        grid: ['/Ac/Power'], acload: ['/Ac/Power'], pvinverter: ['/Ac/Power'],
        temperature: ['/Temperature', '/Humidity', '/BatteryVoltage'], tank: ['/Level'],
        dcload: ['/Dc/0/Power'], dcsource: ['/Dc/0/Power']
    }),
    'bus = dbus.SystemBus()',
    'def get(service, path):',
    '    try:',
    '        v = bus.get_object(service, path, introspect=False).GetValue(dbus_interface="com.victronenergy.BusItem", timeout=2)',
    '        if isinstance(v, (dbus.Double, float)):',
    '            return round(float(v), 2)',
    '        if isinstance(v, (dbus.Int16, dbus.Int32, dbus.Int64, dbus.UInt16, dbus.UInt32, dbus.UInt64, dbus.Byte, int)):',
    '            return int(v)',
    '        if isinstance(v, (dbus.String, str)):',
    '            return str(v)',
    '    except Exception:',
    '        pass',
    '    return None',
    'out = []',
    'for n in sorted(str(x) for x in bus.list_names() if str(x).startswith("com.victronenergy.")):',
    '    kind = n.split(".")[2]',
    '    if kind not in TYPE:',
    '        continue',
    '    out.append({"name": n, "kind": kind, "v": dict((p, get(n, p)) for p in COMMON + TYPE[kind])})',
    'print("@@DBUSJSON " + json.dumps({"services": out}))'
].join('\n');

function shellQuote(script) { return "'" + String(script).replace(/'/g, "'\\''") + "'"; }

function readCmd() {
    return shellQuote([
        // mains Smart Life devices: one local read each (keys stay in tuya-devices.json, never printed)
        'node ' + TOOLS_DIR + '/tuya-local-poll.js > /dev/null 2>&1',
        // battery sensors without a local beacon: Tuya cloud, at most every 30 min (the tool throttles itself)
        'node ' + TOOLS_DIR + '/tuya-cloud-sensors.js > /dev/null 2>&1',
        'echo "@@CLOUD"; cat ' + CFG_DIR + '/tuya-devices-cloud.json 2>/dev/null; echo',
        'echo "@@META"; cat ' + CFG_DIR + '/tuya-devices-meta.json 2>/dev/null; echo',
        'echo "@@POLL"; cat ' + CFG_DIR + '/tuya-devices-last.json 2>/dev/null; echo',
        'echo "@@LAST"; cat ' + CFG_DIR + '/tuya-local-sensors-last.json 2>/dev/null; echo',
        'PY=$(command -v python3 || command -v python)',
        'if [ -n "$PY" ]; then "$PY" - <<\'PYEOF\'',
        PYTHON,
        'PYEOF',
        'else echo "@@DBUSJSON {\\"error\\": \\"python not found\\"}"; fi',
        'true'
    ].join('\n'));
}

function parse(text) {
    let dbusOut = null, mode = '';
    const txt = { LAST: '', META: '', POLL: '', CLOUD: '' };
    for (const line of String(text || '').split(/\r?\n/)) {
        if (line.startsWith('@@DBUSJSON ')) {
            try { dbusOut = JSON.parse(line.slice(11)); } catch (e) { dbusOut = { error: 'bad D-Bus output' }; }
            mode = '';
            continue;
        }
        if (/^@@(LAST|META|POLL|CLOUD)$/.test(line)) { mode = line.slice(2); continue; }
        if (mode) txt[mode] += line;
    }
    const json = (s) => { if (!s.trim()) return {}; try { return JSON.parse(s); } catch (e) { return {}; } };
    return { last: json(txt.LAST), meta: json(txt.META), poll: json(txt.POLL), cloud: json(txt.CLOUD).devices || {}, dbus: dbusOut || { error: 'no D-Bus output' } };
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

// Battery of a sensor: 'low' / 'middle' / 'high' (battery_state) or a percentage.
function batteryInfo(bat) {
    if (bat === null || bat === undefined || bat === '') return { text: '', low: false };
    if (typeof bat === 'string' && !Number.isFinite(Number(bat))) return { text: bat, low: bat.toLowerCase() === 'low' };
    const p = Number(bat);
    return { text: p + ' %', low: p <= LOW_BAT_PCT };
}

const VEBUS_STATE = { 0: 'Off', 1: 'Low power', 2: 'Fault', 3: 'Bulk', 4: 'Absorption', 5: 'Float', 6: 'Storage', 7: 'Equalize', 8: 'Passthru', 9: 'Inverting', 10: 'Power assist', 11: 'Power supply', 252: 'External control' };

function tuyaDevices(now, last) {
    const st = flow.get('heatPump') || {};
    const model = flow.get('heatPumpModel') || {};
    const sum = model.summary || {};
    const mdev = {};
    (model.devices || []).forEach((d) => { mdev[d.role] = d; });
    const lastByRole = {};
    Object.keys(last || {}).forEach((id) => { const r = last[id]; if (r && r.role) lastByRole[r.role] = r; });
    return ORDER.map((role) => {
        const k = TUYA[role];
        const s = st[role] || {};
        const d = s.dps || {};
        const md = mdev[role] || {};
        const out = {
            group: 'tuya', id: role, name: k.name, tuyaName: k.tuyaName, power: k.power,
            ip: k.ip, ver: k.ver, link: 'Tuya local (Wi-Fi)', state: s.state || 'UNKNOWN',
            lastData: s.lastData || 0, ageS: s.lastData ? Math.round((now - s.lastData) / 1000) : null,
            values: [], battery: null, note: ''
        };
        if (k.power === 'battery') {
            const lr = lastByRole[role];
            const localT = lr && lr.t ? lr.t : 0;
            if (lr && lr.ip) { out.ip = lr.ip; out.ver = String(lr.version || out.ver); }
            out.link = 'Tuya local, wakes on change';
            out.lastData = localT;
            out.ageS = localT ? Math.round((now - localT) / 1000) : null;
            out.online = !!localT && now - localT <= SENSOR_STALE_H * 3600 * 1000;
            const temp = lr && lr.temp !== undefined ? lr.temp : null;
            const hum = lr && lr.hum !== undefined ? lr.hum : null;
            const bat = lr && lr.bat !== undefined && lr.bat !== null ? lr.bat : (s.source === 'local' ? d.bat : null);
            if (temp !== null) out.values.push({ k: 'Temperature', v: temp + ' °C' });
            if (hum !== null) out.values.push({ k: 'Humidity', v: hum + ' %' });
            const b = batteryInfo(bat);
            out.battery = b.text ? b : null;
            if (!localT) out.note = 'never read on the local network';
            else if (!out.online) out.note = 'no local reading for ' + Math.round((now - localT) / 3600000) + ' h';
            if (s.source === 'cloud' && s.state === 'CONNECTED') out.note += (out.note ? '; ' : '') + 'cloud value shown on the Heat Pump page';
        } else {
            out.online = s.state === 'CONNECTED' && !!s.lastData && now - s.lastData <= STALE_MS;
            if (role === 'hp') {
                if (sum.supply !== undefined && sum.supply !== null) out.values.push({ k: 'Supply / return', v: sum.supply + ' / ' + sum.ret + ' °C' });
                if (sum.tank !== undefined && sum.tank !== null) out.values.push({ k: 'Tank', v: sum.tank + ' °C' });
                if (sum.outdoor !== undefined && sum.outdoor !== null) out.values.push({ k: 'Outdoor', v: sum.outdoor + ' °C' });
                if (sum.compressorHz !== undefined && sum.compressorHz !== null) out.values.push({ k: 'Compressor', v: sum.compressorHz + ' Hz, ' + sum.compressorA + ' A' });
            } else if (role === 'valve') {
                if (md.switchOn !== null && md.switchOn !== undefined) out.values.push({ k: 'Position', v: md.switchOn ? 'DHW tank' : 'heating' });
            } else if (role === 'bypass') {
                if (md.switchOn !== null && md.switchOn !== undefined) out.values.push({ k: 'Bypass', v: md.switchOn ? 'ON (exchanger off)' : 'OFF' });
                if (num(d['19']) !== null) out.values.push({ k: 'Power', v: r1(num(d['19']) / 10) + ' W' });
            } else if (role === 'meter') {
                const rd = s.reading || {};
                if (num(rd.powerW) !== null) out.values.push({ k: 'Power', v: rd.powerW + ' W' });
                if (num(rd.voltageV) !== null) out.values.push({ k: 'Voltage', v: rd.voltageV + ' V' });
                // SA1: DP 1 forward energy total (kWh x 100), DP 32 grid frequency (Hz x 100)
                if (num(d['1']) !== null) out.values.push({ k: 'Energy total', v: r1(num(d['1']) / 100) + ' kWh' });
                if (num(d['32']) !== null) out.values.push({ k: 'Frequency', v: (num(d['32']) / 100).toFixed(2) + ' Hz' });
                if (!out.online) out.note = 'not reachable on the local network';
            }
        }
        return out;
    });
}

// A Smart Life DP value after its scale: numbers / 10^scale; mA shown as A.
function dpValue(code, v, def) {
    const c = CODES[code];
    if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
    if (typeof v !== 'number') return String(v);
    let x = v / Math.pow(10, (def && def.scale) || 0);
    let unit = c ? c[1] : ((def && def.unit) || '');
    if (code === 'cur_current' && (!def || !def.unit || def.unit === 'mA') && !(def && def.scale)) x = x / 1000;
    if (code === 'cur_current') unit = 'A';
    return (Math.round(x * 100) / 100) + (unit ? ' ' + unit : '');
}

// Every other device of the Smart Life account (tools/tuya-devices-setup.js): mains devices read by
// tools/tuya-local-poll.js, sleeping battery devices by tools/tuya-local-sensors.js on their beacon,
// or from the cloud (tools/tuya-cloud-sensors.js) when they send no beacon the GX hears.
function smartLifeDevices(now, meta, poll, last, cloud) {
    const shown = ['Accumulator tank temp', 'Exchange plate'];
    const out = [];
    for (const id of Object.keys(meta || {})) {
        const m = meta[id];
        if (m.node || shown.includes(m.name)) continue;          // already a card above (34 / 46)
        const lr = m.battery ? (last[id] || null) : (poll[id] || null);
        const cr = m.battery ? ((cloud || {})[id] || null) : null;
        const fromCloud = !!(cr && cr.t && (!lr || !lr.t || (now - lr.t > SENSOR_STALE_H * 3600 * 1000 && cr.t > lr.t)));   // local first
        const r = fromCloud ? cr : lr;
        const t = r && r.t ? r.t : 0;
        const staleH = m.category === 'ywbj' ? SMOKE_STALE_H : SENSOR_STALE_H;
        const online = !!t && now - t <= (m.battery ? staleH * 3600 * 1000 : POLL_STALE_MS);
        const values = [];
        let battery = null;
        const dps = (r && r.dps) || {};
        for (const dp of Object.keys(dps)) {
            const def = (m.dps || {})[dp];
            if (!def) continue;
            if (BATTERY_CODES.includes(def.code)) {
                let v = dps[dp];
                if (typeof v === 'number' && v > 100) v = Math.round(v / 10);   // some meters send % x 10
                if (m.battery) battery = batteryInfo(v);
                else values.push({ k: 'Battery', v: typeof v === 'number' ? v + ' %' : String(v) });
                continue;
            }
            if (!CODES[def.code] || values.length >= 6) continue;
            values.push({ k: CODES[def.code][0], v: dpValue(def.code, dps[dp], def) });
        }
        let note = '';
        if (!m.cloudOnline && !online) note = 'offline in Smart Life too (last seen ' + (m.cloudUpdated ? new Date(m.cloudUpdated).toISOString().slice(0, 10) : '?') + ' at setup)';
        else if (!m.ip && !(r && r.ip) && !m.battery) note = 'IP not found (not on a network the GX reaches)';   // d#178: an IP found by MAC at poll time counts
        else if (fromCloud) note = 'read from the Smart Life cloud: the sensor sends no beacon on the local network';
        else if (m.battery && !t) note = 'waits for the sensor to wake (it reports on a change)';
        out.push({
            group: m.cloudOnline || online ? 'smartlife' : 'smartlife-off', id, name: m.name, tuyaName: '', product: m.product,
            power: m.battery ? 'battery' : 'mains', ip: (r && r.ip) || m.ip, ver: (r && r.version) ? String(r.version) : '',
            link: fromCloud ? 'Tuya cloud (no local beacon)' : (m.battery ? 'Tuya local, wakes on change' : 'Tuya local (Wi-Fi)'),
            source: fromCloud ? 'cloud' : 'local', staleH, state: online ? 'CONNECTED' : 'OFFLINE',
            lastData: t, ageS: t ? Math.round((now - t) / 1000) : null, online, values, battery, note,
            alert: m.battery && m.cloudOnline
        });
    }
    return out.sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group)));
}

// Qingping Air Monitor: pushes its readings to the MQTT broker of the GX ("Air monitor", 52).
function airDevices(now) {
    // only the known monitor: any LAN client may publish to qingping/<mac>/up
    const all = flow.get('airMonitor') || {};
    return [AIR.mac].map((mac) => {
        const r = all[mac] || {};
        const v = r.values || {};
        const t = r.t || 0;
        // online by the time the GX got data (`seen`), so a drifting monitor clock does not matter
        const got = r.t ? Math.max(t, r.seen || 0) : 0;
        const online = !!got && now - got <= AIR_STALE_MS;
        const values = [];
        for (const row of AIR_VALUES) if (v[row[0]] !== undefined && v[row[0]] !== null) values.push({ k: row[1], v: v[row[0]] + (row[2] ? ' ' + row[2] : '') });
        let note = '';
        if (!t) note = 'no MQTT message yet: set a Private Access Config (self-built MQTT, ' + AIR.broker + ') on developer.qingping.co';
        else if (!online) note = 'no reading for ' + Math.round((now - got) / 60000) + ' min';
        return {
            group: 'air', id: 'air-' + mac, name: mac === AIR.mac ? AIR.name : 'Qingping ' + mac, product: AIR.product, power: 'mains',
            ip: mac === AIR.mac ? AIR.ip : '', ver: '', link: 'MQTT push to the GX (Wi-Fi)', state: online ? 'CONNECTED' : 'OFFLINE',
            lastData: t, ageS: t ? Math.round((now - t) / 1000) : null, online, values,
            battery: null, note
        };
    });
}

function victronDevices(db) {
    if (!db || db.error) return [];
    return (db.services || []).map((s) => {
        const v = s.v || {};
        const values = [];
        const add = (k, val, unit) => { if (val !== null && val !== undefined) values.push({ k, v: val + (unit ? ' ' + unit : '') }); };
        if (s.kind === 'battery') {
            add('Voltage', v['/Dc/0/Voltage'], 'V'); add('Current', v['/Dc/0/Current'], 'A'); add('SoC', v['/Soc'], '%');
            add('Temperature', v['/Dc/0/Temperature'], '°C');
        } else if (s.kind === 'vebus') {
            add('State', VEBUS_STATE[v['/State']] || v['/State']); add('AC in', v['/Ac/ActiveIn/L1/P'], 'W'); add('AC out', v['/Ac/Out/L1/P'], 'W');
            add('DC', v['/Dc/0/Voltage'], 'V'); if (v['/VebusError']) add('VE.Bus error', v['/VebusError']);
        } else if (s.kind === 'solarcharger') {
            add('PV power', v['/Yield/Power'], 'W'); add('Voltage', v['/Dc/0/Voltage'], 'V'); add('Current', v['/Dc/0/Current'], 'A');
        } else if (s.kind === 'system') {
            add('Grid', v['/Ac/Grid/L1/Power'], 'W'); add('AC loads', v['/Ac/Consumption/L1/Power'], 'W'); add('PV', v['/Dc/Pv/Power'], 'W'); add('Battery SoC', v['/Dc/Battery/Soc'], '%');
        } else if (s.kind === 'temperature') {
            add('Temperature', v['/Temperature'], '°C'); add('Humidity', v['/Humidity'], '%'); add('Battery', v['/BatteryVoltage'], 'V');
        } else {
            add('Power', v['/Ac/Power'] !== undefined ? v['/Ac/Power'] : v['/Dc/0/Power'], 'W'); add('Level', v['/Level'], '%');
        }
        const name = s.kind === 'system' ? 'GX system (Cerbo GX)' : (v['/CustomName'] || v['/ProductName'] || s.name);
        return {
            group: 'victron', id: s.name, name, product: v['/ProductName'] || '', kind: s.kind,
            link: v['/Mgmt/Connection'] || 'D-Bus', instance: v['/DeviceInstance'], firmware: v['/FirmwareVersion'],
            online: v['/Connected'] === 1, state: v['/Connected'] === 1 ? 'CONNECTED' : 'DISCONNECTED', values, battery: null, note: ''
        };
    });
}

const now = Date.now();
if (msg.topic === 'read') {
    const p = parse(msg.payload);
    const smart = smartLifeDevices(now, p.meta, p.poll, p.last, p.cloud);
    const devices = tuyaDevices(now, p.last).concat(smart, airDevices(now), victronDevices(p.dbus));
    // battery sensors for the low-battery / offline mails of "Heat pump alerts" (47)
    flow.set('deviceBatteries', smart.filter((d) => d.alert).map((d) => ({ id: d.id, name: d.name, battery: d.battery, lastData: d.lastData, source: d.source, staleH: d.staleH })));
    // d#163: every device for the daily devices mail of "Heat pump alerts" (47)
    flow.set('devicesReport', { at: now, devices: devices.map((d) => ({ id: d.id, name: d.name, group: d.group, online: !!d.online, lastData: d.lastData || 0, battery: d.battery || null, note: d.note || '', link: d.link || '' })) });
    const model = {
        updated: new Date(now).toISOString(),
        devices,
        online: devices.filter((d) => d.online).length,
        total: devices.length,
        lowBattery: devices.filter((d) => d.battery && d.battery.low).map((d) => d.name),
        dbusError: p.dbus && p.dbus.error ? p.dbus.error : ''
    };
    context.set('model', model);
    node.status({ fill: model.online === model.total ? 'green' : 'yellow', shape: 'dot', text: model.online + ' / ' + model.total + ' online' });
    return [{ topic: 'model', payload: model }, null];
}

// 'ui' / 'tick': show the cached model at once, then read again (not more often than MIN_READ_GAP_MS)
const cached = context.get('model');
const lastRead = context.get('lastRead') || 0;
if (now - lastRead < MIN_READ_GAP_MS) return [cached ? { topic: 'model', payload: cached } : null, null];
context.set('lastRead', now);
return [msg.topic === 'ui' && cached ? { topic: 'model', payload: cached } : null, { topic: 'read', payload: readCmd() }];
