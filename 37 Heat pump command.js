// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `37 Heat pump command.js` and the embedded `func` for "Heat pump command"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - The manual write path to the heat pump devices. Takes requests from the
//   Heat Pump page (35) and the history page (39), validates them and routes them.
// Input (msg.topic):
// - 'curve'   payload { p23, p24, requestId } -> validate, pace and save the owner curve in node 40.
// - 'bypass'  payload { on }   -> set DP 1 of the "Off Heating exchange" relay (true = bypass ON).
// - 'summary' payload {}       -> read the last HISTORY_DAYS day folders (cached days skipped)
// - 'day'     payload { day }  -> read every hour file of one day (YYYY-MM-DD)
// - 'ui'      payload { action: 'mode', id: 'dhw', mode } | { action: 'dhwSet', cfg }
//                              -> DHW controller panel of the Heat Pump page (d#138): passed to
//                                 "Heat pump automations" (40), which checks and stores it.
// Output (4):
// - output 1 -> unused (owner curve uses node 40's heat-pump queue)
// - output 2 -> Tuya node "Off Heating exchange"  { operation: 'SET', dps: 1, set }
// - output 3 -> "Build heat pump history" (38), msg.topic / msg.day kept
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
// 4. d#166 / d#174: 'ui' also passes the heating controller (mode id 'heat', heatSet) and dhwResume.
// 5. d#233: route the two-coefficient owner curve via node 40.
// ==========================

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

switch (msg.topic) {
case 'curve':
    return [null, null, null, { topic: 'ui', payload: { action: 'ownerCurve', p23: p.p23, p24: p.p24, requestId: p.requestId } }];
case 'bypass': {
    if (typeof p.on !== 'boolean') return refuse('bypass: on must be true / false');
    if (!ready('bypass')) return refuse('bypass relay not connected');
    if (throttled('bypass')) return refuse('too fast, wait 5 s');
    node.log('Heat pump command: bypass relay DP 1 -> ' + p.on);
    node.status({ fill: 'blue', shape: 'dot', text: 'bypass → ' + (p.on ? 'ON' : 'OFF') });
    return [null, { payload: { operation: 'SET', dps: 1, set: p.on } }, null];
}
case 'summary': {
    node.status({ fill: 'grey', shape: 'dot', text: 'reading summary' });
    return [null, null, { topic: 'summary' }];
}
case 'day': {
    const day = String(p.day || '');
    if (!DAY_RE.test(day)) return refuse('bad day ' + day);
    node.status({ fill: 'grey', shape: 'dot', text: 'reading ' + day });
    return [null, null, { topic: 'day', day }];
}
case 'ui': {
    if (p.action === 'dhwShowerForce') {
        if (typeof p.on !== 'boolean') return refuse('shower force must be a boolean');
        node.status({ fill: 'blue', shape: 'dot', text: 'Shower early starts ' + (p.on ? 'enabled' : 'stopped') });
        return [null, null, null, { topic: 'ui', payload: { action: p.action, on: p.on } }];
    }
    const okMode = p.action === 'mode' && (p.id === 'dhw' || p.id === 'heat') && ['off', 'dry', 'live'].includes(p.mode);
    const okSet = p.action === 'dhwSet' && p.cfg && typeof p.cfg === 'object' && Array.isArray(p.cfg.curve);
    const okHeat = p.action === 'heatSet' && p.cfg && typeof p.cfg === 'object' && !Array.isArray(p.cfg);
    if (p.action === 'hpResume') return [null, null, null, { topic: 'ui', payload: { action: p.action } }];
    if (p.action === 'hpPause') {
        if (!Number.isInteger(p.minutes) || p.minutes < 1 || p.minutes > 1440) return refuse('pause duration must be 1–1440 whole minutes');
        return [null, null, null, { topic: 'ui', payload: { action: p.action, minutes: p.minutes } }];
    }
    if (p.action === 'dhwRetrySet') {
        const { on, max, wait } = p;
        if (typeof on !== 'boolean' || !Number.isInteger(max) || max < 1 || max > 5 ||
            !Number.isInteger(wait) || wait < 5 || wait > 240) return refuse('invalid DHW retry settings');
        return [null, null, null, { topic: 'ui', payload: { action: 'dhwSet', cfg: { autoRetry: on, retryMax: max, retryWait: wait } } }];
    }
    if (p.action === 'dhwResume') { node.status({ fill: 'blue', shape: 'dot', text: 'DHW allowed again' }); return [null, null, null, { topic: 'ui', payload: { action: 'dhwResume' } }]; }   // d#174
    if (!okMode && !okSet && !okHeat) return refuse('ui: only the DHW / heating controller mode / settings');
    const who = (okMode ? p.id : okHeat ? 'heat' : 'dhw') === 'heat' ? 'Heating controller' : 'DHW controller';
    node.status({ fill: 'blue', shape: 'dot', text: who + ' ' + (okMode ? 'mode → ' + p.mode : 'settings') });
    return [null, null, null, { topic: 'ui', payload: okMode ? { action: 'mode', id: p.id, mode: p.mode } : { action: p.action, cfg: p.cfg } }];
}
default:
    return refuse('unknown topic ' + msg.topic);
}
