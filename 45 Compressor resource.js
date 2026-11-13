// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `45 Compressor resource.js` and the embedded `func` for "Compressor resource" in
//   `flows.json` must always stay synchronized (the On Start code is in flows.json only, see INIT).
// Purpose:
// - Counts the use of the heat pump compressor (PW030-DKZLRS-A, EVI DC inverter, bought
//   2022-01-01) and keeps the counters in a file on the GX, so they survive restarts and deploys.
// - Measured every 30 s from flow.heatPump (DPs from the local Tuya connection, 34):
//     run hours, starts, defrosts, DHW run hours, hours by frequency band, equivalent full-load
//     hours (Σ time × current / 9.67 A), estimated energy (Σ current × 220 W/A × time),
//     hours with a discharge temperature (DP 104) above HOT_DISCHARGE_C.
// - The counters were seeded from the recorder history (2026-11-08 01:17 on) when this node was
//   first deployed (d#133). Before that (2022-01-01 → BASE.until) the use is an ESTIMATE from daily
//   outdoor temperatures (Open-Meteo archive, Hokksund): run fraction (17 − T) / 20, 0…1, plus
//   1 h DHW a day → BASE.runH; starts from the defrost season (BASE.starts). Both are rough.
// - Resource = (estimated + measured run hours) / LIFE_H. LIFE_H is an ASSUMPTION (the
//   compressor maker publishes no service life), editable in the file (`lifeH`).
// Input (msg.topic):
// - 'tick' (inject every 30 s) -> count; every SAVE_MS also save the file
// - 'load' (file in "Read compressor resource", msg.payload = file text) -> restore the counters
// Output (2):
// - output 1 -> file node "Write compressor resource" (overwrite, msg.filename)
// - output 2 -> file in node "Read compressor resource" (asks for the file after a node start)
// State: flow.compressorResource = summary for the Heat Pump page (via 34, summary.resource)
// Change notes:
// 1. Initial version (d#133).
// INIT — the node's On Start code (`initialize` in flows.json):
//    context.set('needLoad', true); context.set('startedAt', Date.now());
// ==========================

const FILE = '/data/home/nodered/grid-control-config/compressor-resource.json';
const MAX_A = 9.67;            // nameplate max current
const W_PER_A = 220;           // nameplate 2130 W / 9.67 A
const DT_MAX_S = 120;          // longer gaps (GX / Node-RED down) are not counted
const FRESH_MS = 3 * 60 * 1000;
const SAVE_MS = 10 * 60 * 1000;
const LOAD_WAIT_MS = 2 * 60 * 1000;   // no file after 2 min → start new counters
const HOT_DISCHARGE_C = 95;
const BANDS = [[0, 40, 'lt40'], [40, 70, 'b40_70'], [70, 90, 'b70_90'], [90, 999, 'ge90']];
// Estimate for 2022-01-01 … 2026-11-09 (before the measurement), see the header
const BASE = {
    purchase: '2022-01-01', until: '2026-11-07',
    runH: 21957, starts: 27000,
    note: 'estimate from daily outdoor temperatures 2022-01-01…2026-11-07 (Open-Meteo, Hokksund): run fraction (17 − T) / 20 + 1 h DHW a day; starts ≈ 26 a day in the defrost season (T < 5 °C) + 8 a day otherwise; the counters are measured from 2026-11-08 01:17 (recorder)'
};
const DEFAULT_LIFE_H = 60000;   // assumption, not a maker value

function pad(x) { return String(x).padStart(2, '0'); }
function emptyCounters(now) {
    return { version: 1, since: now, lifeH: DEFAULT_LIFE_H, runS: 0, starts: 0, defrosts: 0, dhwS: 0,
        eflhS: 0, kwh: 0, hotS: 0, hzS: 0, bands: { lt40: 0, b40_70: 0, b70_90: 0, ge90: 0 }, savedAt: 0 };
}
function summary(c, now) {
    const runH = c.runS / 3600;
    const totalH = BASE.runH + runH;
    const years = (now - Date.parse(BASE.purchase + 'T00:00:00Z')) / (365.25 * 86400 * 1000);
    return {
        purchase: BASE.purchase, years: Math.round(years * 10) / 10,
        measuredSince: c.since, measuredRunH: Math.round(runH * 10) / 10,
        measuredStarts: c.starts, measuredDefrosts: c.defrosts,
        measuredDhwH: Math.round(c.dhwS / 360) / 10,
        eflh: Math.round(c.eflhS / 360) / 10,
        avgLoadPct: c.runS ? Math.round(c.eflhS / c.runS * 100) : null,
        avgHz: c.runS ? Math.round(c.hzS / c.runS) : null,
        kwh: Math.round(c.kwh * 10) / 10,
        hotH: Math.round(c.hotS / 360) / 10,
        bandsPct: Object.fromEntries(Object.keys(c.bands).map((k) => [k, c.runS ? Math.round(c.bands[k] / c.runS * 100) : 0])),
        startsPerRunH: runH > 1 ? Math.round(c.starts / runH * 10) / 10 : null,
        estimatedRunH: BASE.runH, estimatedStarts: BASE.starts, estimateNote: BASE.note, estimateUntil: BASE.until,
        totalRunH: Math.round(totalH),
        totalStarts: BASE.starts + c.starts,
        lifeH: c.lifeH,
        lifePct: Math.round(totalH / c.lifeH * 1000) / 10,
        hoursPerYear: years > 0 ? Math.round(totalH / years) : null,
        savedAt: c.savedAt
    };
}

const now = Date.now();
let c = context.get('c');

// ---- restore from the file ----------------------------------------------------------
if (msg.topic === 'load') {
    try {
        const f = JSON.parse(String(msg.payload || ''));
        // keep the counters in memory if they are ahead of the file (context survived the start)
        if (f && f.version === 1 && Number.isFinite(f.runS) && (!c || f.runS >= c.runS)) {
            c = Object.assign(emptyCounters(now), f);
            context.set('c', c);
            node.status({ fill: 'green', shape: 'dot', text: 'loaded: ' + Math.round(c.runS / 3600) + ' h measured' });
        }
    } catch (e) { node.warn('Compressor resource: file unreadable, keeping the counters in memory: ' + e.message); }
    context.set('needLoad', false);
    return null;
}

// ---- after a node start: ask for the file, wait for it --------------------------------
if (context.get('needLoad')) {
    if (!context.get('loadAsked')) {
        context.set('loadAsked', true);
        return [null, { topic: 'load', filename: FILE }];
    }
    if (now - (context.get('startedAt') || now) < LOAD_WAIT_MS) return null;
    context.set('needLoad', false);   // no file: new counters
    node.warn('Compressor resource: no counter file, starting new counters at ' + new Date(now).toISOString());
}
if (!c) { c = emptyCounters(now); context.set('c', c); }

// ---- count -----------------------------------------------------------------------------
const st = flow.get('heatPump') || {};
const hp = st.hp;
const last = context.get('last') || null;   // { t, run, defrost }
let saveNow = false;
if (hp && hp.state === 'CONNECTED' && hp.lastData && now - hp.lastData <= FRESH_MS) {
    const d = hp.dps || {};
    const hz = Number(d['115']), amp = Number(d['112']), fan = Number(d['116']), dis = Number(d['104']);
    const run = Number.isFinite(hz) && hz > 0;
    const defrost = fan === 0 && hz > 30;
    if (last) {
        const dt = Math.min(DT_MAX_S, (now - last.t) / 1000);
        if (run) {
            c.runS += dt;
            c.hzS += hz * dt;
            const a = Number.isFinite(amp) ? Math.max(0, amp) : 0;
            c.eflhS += dt * Math.min(1, a / MAX_A);
            c.kwh += a * W_PER_A * dt / 3600 / 1000;
            const b = BANDS.find(([lo, hi]) => hz >= lo && hz < hi);
            if (b) c.bands[b[2]] += dt;
            if (Number.isFinite(dis) && dis > HOT_DISCHARGE_C) c.hotS += dt;
            if (st.valve && st.valve.dps && st.valve.dps['1'] === true) c.dhwS += dt;
        }
        if (run && !last.run) c.starts++;
        if (defrost && !last.defrost) c.defrosts++;
    }
    context.set('last', { t: now, run, defrost });
} else {
    context.set('last', null);   // no fresh data: do not count the gap
}
context.set('c', c);
if (now - (c.savedAt || 0) >= SAVE_MS) { c.savedAt = now; saveNow = true; }

const s = summary(c, now);
flow.set('compressorResource', s);
node.status({ fill: 'green', shape: 'dot', text: s.totalRunH + ' h total (' + s.measuredRunH + ' h measured) · ' + s.lifePct + ' % of ' + c.lifeH + ' h · ' + c.starts + ' starts measured' });
return [saveNow ? { filename: FILE, payload: JSON.stringify(c, null, 1) } : null, null];
