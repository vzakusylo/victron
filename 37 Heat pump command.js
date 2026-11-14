// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `37 Heat pump command.js` and the embedded `func` for "Heat pump command"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - The only node that WRITES to the heat pump devices. Takes requests from the
//   Heat Pump page (35) and the history page (39), validates them and routes them.
// Input (msg.topic):
// - 'curve'   payload { p23 }  -> set DP 133 (P23, curve ambient point) of the heat pump.
//                                 Higher P23 = warmer: every +1 °C raises the heating set point
//                                 by P24/10 °C at every outdoor temperature (P24 = 4 -> +0.4 °C).
//                                 Integer, CURVE_MIN…CURVE_MAX only.
// - 'bypass'  payload { on }   -> set DP 1 of the "Off Heating exchange" relay (true = bypass ON).
// - 'summary' payload {}       -> read the last HISTORY_DAYS day folders (cached days skipped)
// - 'day'     payload { day }  -> read every hour file of one day (YYYY-MM-DD)
// - 'ui'      payload { action: 'mode', id: 'dhw', mode } | { action: 'dhwSet', cfg }
//                              -> DHW controller panel of the Heat Pump page (d#138): passed to
//                                 "Heat pump automations" (40), which checks and stores it.
// Output (4):
// - output 1 -> Tuya node "Heating pump"          { operation: 'SET', dps, set }
// - output 2 -> Tuya node "Off Heating exchange"  { operation: 'SET', dps: 1, set }
// - output 3 -> exec "Read heat pump history" (`sh -c <payload>`), msg.topic / msg.day kept
// - output 4 -> "Heat pump automations" (40), msg.topic 'ui'
// Safety:
// - A command is refused while the target device is not CONNECTED with fresh data (≤ 5 min).
// - At most one write per device every MIN_GAP_MS; values are range-checked here,
//   not trusted from the browser.
// - Tuya cloud scenes that also switch the bypass may switch it back.
// Change notes:
// 1. Initial version (d#121): curve shift (P23), bypass on/off, history requests.
// 2. d#138: 'ui' requests of the DHW controller panel go to output 4.
// 3. d#142: P23 (curve) refused while a DHW cycle runs (the pump is on the boiler curve then).
// ==========================

const BASE_DIR = '/data/home/nodered/grid-control-logs/heatpump';
const HISTORY_DAYS = 14;
const CURVE_MIN = 20;
const CURVE_MAX = 40;
const MIN_GAP_MS = 5000;
const FRESH_MS = 5 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const now = Date.now();
const p = msg.payload || {};
const st = flow.get('heatPump') || {};

function ready(role) {
    const dev = st[role];
    return !!(dev && dev.state === 'CONNECTED' && dev.lastData && now - dev.lastData <= FRESH_MS);
}

function throttled(key) {
    const last = context.get('last_' + key) || 0;
    if (now - last < MIN_GAP_MS) return true;
    context.set('last_' + key, now);
    return false;
}

function refuse(text) {
    node.warn('Heat pump command refused: ' + text);
    node.status({ fill: 'red', shape: 'ring', text: 'refused: ' + text });
    return null;
}

// Shell snippet: print every hour file of day folder $d in hour order (gz or plain)
const CAT_DAY = 'for f in $(ls $d | sort); do case $f in *.csv.gz) gzip -dc $d/$f;; *.csv) cat $d/$f;; esac; done';

switch (msg.topic) {
case 'curve': {
    const v = Number(p.p23);
    if (!Number.isInteger(v) || v < CURVE_MIN || v > CURVE_MAX) return refuse('P23 ' + p.p23 + ' outside ' + CURVE_MIN + '…' + CURVE_MAX);
    if (!ready('hp')) return refuse('heat pump not connected');
    // d#142: during a DHW cycle the pump runs on the boiler curve; the heating P23 comes back at its end
    const dv = flow.get('dhwView');
    if (dv && dv.state && dv.state !== 'HEATING') return refuse('DHW cycle running, change the heating curve after it');
    const cur = st.hp.dps['133'];
    if (Number(cur) === v) { node.status({ fill: 'grey', shape: 'dot', text: 'P23 already ' + v }); return null; }
    if (throttled('hp')) return refuse('too fast, wait 5 s');
    node.log('Heat pump command: P23 (DP 133) ' + cur + ' -> ' + v);
    node.status({ fill: 'blue', shape: 'dot', text: 'P23 ' + cur + ' → ' + v });
    return [{ payload: { operation: 'SET', dps: 133, set: v } }, null, null];
}
case 'bypass': {
    if (typeof p.on !== 'boolean') return refuse('bypass: on must be true / false');
    if (!ready('bypass')) return refuse('bypass relay not connected');
    if (throttled('bypass')) return refuse('too fast, wait 5 s');
    node.log('Heat pump command: bypass relay DP 1 -> ' + p.on);
    node.status({ fill: 'blue', shape: 'dot', text: 'bypass → ' + (p.on ? 'ON' : 'OFF') });
    return [null, { payload: { operation: 'SET', dps: 1, set: p.on } }, null];
}
case 'summary': {
    // Days already summarised (finished days only) are not read again
    const cache = flow.get('hpDayCache2') || {};
    const cached = Object.keys(cache).filter((d) => DAY_RE.test(d));
    const script = 'cd ' + BASE_DIR + ' 2>/dev/null || exit 0; '
        + 'for d in $(ls | grep -E "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" | sort | tail -n ' + HISTORY_DAYS + '); do '
        + 'case " ' + cached.join(' ') + ' " in *" $d "*) echo "#day $d cached";; '
        + '*) echo "#day $d"; ' + CAT_DAY + ';; esac; done';
    node.status({ fill: 'grey', shape: 'dot', text: 'reading summary' });
    return [null, null, { topic: 'summary', payload: "'" + script + "'" }];
}
case 'day': {
    const day = String(p.day || '');
    if (!DAY_RE.test(day)) return refuse('bad day ' + day);
    const script = 'cd ' + BASE_DIR + ' 2>/dev/null || exit 0; d=' + day + '; [ -d $d ] || exit 0; echo "#day $d"; ' + CAT_DAY;
    node.status({ fill: 'grey', shape: 'dot', text: 'reading ' + day });
    return [null, null, { topic: 'day', day, payload: "'" + script + "'" }];
}
case 'ui': {
    const okMode = p.action === 'mode' && (p.id === 'dhw' || p.id === 'heat') && ['off', 'dry', 'live'].includes(p.mode);
    const okSet = p.action === 'dhwSet' && p.cfg && typeof p.cfg === 'object' && Array.isArray(p.cfg.curve);
    const okHeat = p.action === 'heatSet' && p.cfg && typeof p.cfg === 'object' && !Array.isArray(p.cfg);
    if (!okMode && !okSet && !okHeat) return refuse('ui: only the DHW / heating controller mode / settings');
    const who = (okMode ? p.id : okHeat ? 'heat' : 'dhw') === 'heat' ? 'Heating controller' : 'DHW controller';
    node.status({ fill: 'blue', shape: 'dot', text: who + ' ' + (okMode ? 'mode → ' + p.mode : 'settings') });
    return [null, null, null, { topic: 'ui', payload: okMode ? { action: 'mode', id: p.id, mode: p.mode } : { action: p.action, cfg: p.cfg } }];
}
default:
    return refuse('unknown topic ' + msg.topic);
}
