// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `38 Build heat pump history.js` and the embedded `func` for "Build heat pump history"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Turns the recorder files (format "hp1", see 36) read by the exec node
//   "Read heat pump history" into day statistics and a day chart for the history page (39).
// Input:
// - msg.payload = stdout of the exec node: `#day YYYY-MM-DD [cached]` markers, each followed
//   by the decompressed hour files of that day (hp1 sections)
// - msg.topic = 'summary' (last 14 days) | 'day' (one day, msg.day)
// Output (1) -> ui_template "Heat pump history":
// - { topic: 'hpHistory', payload: { kind: 'summary', days: [stats…] } }
// - { topic: 'hpHistory', payload: { kind: 'day', day, stats, hourly: [...24], chart } }
// Statistics (rows where the heat pump state letter is C = connected; one row = one sample,
// weight = time to the next sample, max 120 s):
// - outdoor / supply / return / tank: min, average, max (°C)
// - runH = compressor running (DP 115 > 0), starts = 0 → running transitions,
//   avgHz while running, defrost = entries into "fan 0 and compressor > 30 Hz"
// - dhwH = valve relay ON (v1), bypassH = bypass relay ON (b1)
// - kwh / maxW / avgW = measured by the SA1 meter (column `pw`), null if no meter data
// - compKwh = compressor estimate, DP 112 A × DP 114 V (230 V fallback) — trends only
// State:
// - flow.hpDayCache = { 'YYYY-MM-DD': stats } for finished days (not today), last 60 days;
//   "Heat pump command" (37) skips cached days when it reads the summary.
// Change notes:
// 1. Initial version (d#121).
// ==========================

const KEYS = ['101', '102', '103', '108', '112', '114', '115', '116', 'v1', 'b1', 'pw'];
const K = {};
KEYS.forEach((k, i) => { K[k] = i; });
const MAX_DT = 120;
const BUCKET_S = 120;
const CACHE_DAYS = 60;

function pad(n) { return String(n).padStart(2, '0'); }
function r1(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10; }
function r2(v) { return v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100; }

// ---- parse --------------------------------------------------------------
function parse(text) {
    const days = {};
    const order = [];
    let day = null;
    let idx = null;      // KEYS index -> column index in the section
    let hour = 0;
    let last = null;
    let hpState = 'U';
    for (const line of String(text).split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith('#day ')) {
            const parts = line.split(' ');
            day = parts[1];
            if (!days[day]) { days[day] = { cached: parts[2] === 'cached', rows: [] }; order.push(day); }
            idx = null;
            continue;
        }
        if (line.startsWith('#hp1 ')) {
            const m = line.match(/^#hp1 (\d{4}-\d{2}-\d{2}) (\d{2}) cols=(.*)$/);
            if (!m || !day) { idx = null; continue; }
            hour = Number(m[2]);
            const cols = m[3].split(',');
            idx = KEYS.map((k) => cols.indexOf(k));
            last = KEYS.map(() => null);
            hpState = 'U';
            continue;
        }
        if (!idx) continue;
        const cells = line.split(',');
        const t = Number(cells[0]);
        if (!Number.isFinite(t)) continue;
        if (cells[1]) hpState = cells[1].charAt(0);
        for (let i = 0; i < KEYS.length; i++) {
            const c = idx[i];
            if (c > 1 && cells[c] !== undefined && cells[c] !== '') {
                const n = Number(cells[c]);
                last[i] = Number.isFinite(n) ? n : null;
            }
        }
        days[day].rows.push({ s: hour * 3600 + t, ok: hpState === 'C', a: last.slice() });
    }
    order.forEach((d) => days[d].rows.sort((x, y) => x.s - y.s));
    return { days, order };
}

// ---- statistics ---------------------------------------------------------
function acc() { return { min: null, max: null, sum: 0, n: 0 }; }
function add(a, v) {
    if (v === null || v === undefined) return;
    a.min = a.min === null ? v : Math.min(a.min, v);
    a.max = a.max === null ? v : Math.max(a.max, v);
    a.sum += v; a.n++;
}
function out(a) { return { min: r1(a.min), avg: a.n ? r1(a.sum / a.n) : null, max: r1(a.max) }; }

function stats(rows) {
    const T = { outdoor: acc(), supply: acc(), ret: acc(), tank: acc() };
    let coverS = 0, runS = 0, hzRunSum = 0, starts = 0, defrost = 0, dhwS = 0, bypassS = 0;
    let wh = 0, meterS = 0, maxW = null, compWh = 0;
    let wasRun = null, wasDefrost = false;
    const hourly = [];
    for (let h = 0; h < 24; h++) hourly.push({ hour: h, outdoor: acc(), supply: acc(), runS: 0, wh: 0, meterS: 0, compWh: 0 });

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.ok) { wasRun = null; continue; }
        const next = rows[i + 1];
        const dt = next ? Math.max(0, Math.min(MAX_DT, next.s - r.s)) : 30;
        const a = r.a;
        const hz = a[K['115']], amp = a[K['112']], bus = a[K['114']], fan = a[K['116']], pw = a[K.pw];
        const H = hourly[Math.min(23, Math.floor(r.s / 3600))];
        coverS += dt;
        add(T.outdoor, a[K['103']]); add(T.supply, a[K['102']]); add(T.ret, a[K['101']]); add(T.tank, a[K['108']]);
        add(H.outdoor, a[K['103']]); add(H.supply, a[K['102']]);
        const run = hz !== null && hz > 0;
        if (run) { runS += dt; hzRunSum += hz * dt; H.runS += dt; }
        if (run && wasRun === false) starts++;
        wasRun = hz === null ? null : run;
        const defr = fan === 0 && hz !== null && hz > 30;
        if (defr && !wasDefrost) defrost++;
        wasDefrost = defr;
        if (a[K.v1] === 1) dhwS += dt;
        if (a[K.b1] === 1) bypassS += dt;
        if (pw !== null) {
            wh += pw * dt / 3600; H.wh += pw * dt / 3600; meterS += dt; H.meterS += dt;
            maxW = maxW === null ? pw : Math.max(maxW, pw);
        }
        if (amp !== null) {
            const c = Math.max(0, amp) * (bus !== null && bus > 0 ? bus : 230) * dt / 3600;
            compWh += c; H.compWh += c;
        }
    }
    return {
        stats: {
            samples: rows.length,
            coverageH: r1(coverS / 3600),
            outdoor: out(T.outdoor), supply: out(T.supply), ret: out(T.ret), tank: out(T.tank),
            runH: r1(runS / 3600),
            runPct: coverS ? Math.round(runS / coverS * 100) : null,
            starts,
            avgHz: runS ? Math.round(hzRunSum / runS) : null,
            defrost,
            dhwH: r1(dhwS / 3600),
            bypassH: r1(bypassS / 3600),
            kwh: meterS ? r2(wh / 1000) : null,
            avgW: meterS ? Math.round(wh * 3600 / meterS) : null,
            maxW,
            meterH: r1(meterS / 3600),
            compKwh: r2(compWh / 1000)
        },
        hourly: hourly.map((h) => ({
            hour: pad(h.hour),
            outdoor: out(h.outdoor).avg,
            supply: out(h.supply).avg,
            runMin: Math.round(h.runS / 60),
            kwh: h.meterS ? r2(h.wh / 1000) : null,
            compKwh: r2(h.compWh / 1000)
        }))
    };
}

// ---- day chart (SVG coordinates) ----------------------------------------
function chart(rows) {
    const W = 760, L = 40, R = 12;
    const T1 = 10, B1 = 200, T2 = 228, B2 = 300;
    const nb = Math.ceil(86400 / BUCKET_S);
    const buckets = [];
    for (let i = 0; i < nb; i++) buckets.push(null);
    rows.forEach((r) => {
        if (!r.ok) return;
        const i = Math.min(nb - 1, Math.floor(r.s / BUCKET_S));
        const b = buckets[i] || (buckets[i] = KEYS.map(() => ({ s: 0, n: 0 })).concat([{ s: 0, n: 0 }]));
        KEYS.forEach((k, j) => { const v = r.a[j]; if (v !== null) { b[j].s += v; b[j].n++; } });
        const amp = r.a[K['112']], bus = r.a[K['114']];
        if (amp !== null) { b[KEYS.length].s += Math.max(0, amp) * (bus !== null && bus > 0 ? bus : 230); b[KEYS.length].n++; }
    });
    const val = (b, j) => (b && b[j].n ? b[j].s / b[j].n : null);
    const x = (i) => +(L + (i + 0.5) * BUCKET_S / 86400 * (W - L - R)).toFixed(1);

    const tempDefs = [['Supply', '102', '#d62728'], ['Return', '101', '#1f77b4'], ['Tank', '108', '#ff7f0e'], ['Outdoor', '103', '#2ca02c']];
    const powDefs = [['Heat pump W (meter)', KEYS.length - 1, '#9467bd'], ['Compressor ≈W', KEYS.length, '#8c564b']];

    let tMin = Infinity, tMax = -Infinity, pMax = 0;
    buckets.forEach((b) => {
        tempDefs.forEach(([, k]) => { const v = val(b, K[k]); if (v !== null) { tMin = Math.min(tMin, v); tMax = Math.max(tMax, v); } });
        powDefs.forEach(([, j]) => { const v = val(b, j); if (v !== null) pMax = Math.max(pMax, v); });
    });
    if (!Number.isFinite(tMin)) { tMin = 0; tMax = 50; }
    const yMin = Math.floor(tMin / 10) * 10, yMax = Math.max(yMin + 10, Math.ceil(tMax / 10) * 10);
    const pTop = Math.max(500, Math.ceil(pMax / 500) * 500);
    const yT = (v) => +(T1 + (yMax - v) / (yMax - yMin) * (B1 - T1)).toFixed(1);
    const yP = (v) => +(B2 - v / pTop * (B2 - T2)).toFixed(1);

    function segs(j, y) {
        const out = [];
        let cur = [];
        buckets.forEach((b, i) => {
            const v = val(b, j);
            if (v === null) { if (cur.length > 1) out.push(cur.join(' ')); cur = []; return; }
            cur.push(x(i) + ',' + y(v));
        });
        if (cur.length > 1) out.push(cur.join(' '));
        return out;
    }
    const tTicks = [];
    for (let v = yMin; v <= yMax; v += 10) tTicks.push({ label: v, y: yT(v) });
    const pStep = pTop <= 1000 ? 250 : (pTop <= 3000 ? 500 : 1000);
    const pTicks = [];
    for (let v = 0; v <= pTop; v += pStep) pTicks.push({ label: v >= 1000 ? (v / 1000) + 'k' : v, y: yP(v) });
    const xTicks = [];
    for (let h = 0; h <= 24; h += 3) xTicks.push({ label: pad(h % 24) + ':00', x: +(L + h / 24 * (W - L - R)).toFixed(1) });

    return {
        viewBox: '0 0 ' + W + ' 330',
        left: L, right: W - R, t1: T1, b1: B1, t2: T2, b2: B2,
        xTicks, tTicks, pTicks,
        temp: tempDefs.map(([name, k, color]) => ({ name, color, segs: segs(K[k], yT) })),
        power: powDefs.map(([name, j, color]) => ({ name, color, segs: segs(j, yP) })).filter((s) => s.segs.length)
    };
}

// ---- main ---------------------------------------------------------------
const text = Buffer.isBuffer(msg.payload) ? msg.payload.toString('utf8') : String(msg.payload || '');
const parsed = parse(text);
const nowD = new Date();
const today = nowD.getFullYear() + '-' + pad(nowD.getMonth() + 1) + '-' + pad(nowD.getDate());
const cache = flow.get('hpDayCache') || {};

if (msg.topic === 'day') {
    const d = parsed.days[msg.day];
    if (!d || !d.rows.length) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'no data for ' + msg.day });
        return { topic: 'hpHistory', payload: { kind: 'day', day: msg.day, empty: true } };
    }
    const s = stats(d.rows);
    if (msg.day < today) { cache[msg.day] = s.stats; }
    flow.set('hpDayCache', cache);
    node.status({ fill: 'green', shape: 'dot', text: msg.day + ': ' + d.rows.length + ' samples' });
    return { topic: 'hpHistory', payload: { kind: 'day', day: msg.day, stats: s.stats, hourly: s.hourly, chart: chart(d.rows) } };
}

// summary
const days = parsed.order.map((day) => {
    const d = parsed.days[day];
    let s = d.cached ? cache[day] : null;
    if (!s) {
        s = stats(d.rows).stats;
        if (day < today && d.rows.length) cache[day] = s;
    }
    return Object.assign({ day, today: day === today }, s || {});
}).reverse();
const keep = Object.keys(cache).sort().slice(-CACHE_DAYS);
const trimmed = {};
keep.forEach((k) => { trimmed[k] = cache[k]; });
flow.set('hpDayCache', trimmed);
node.status({ fill: 'green', shape: 'dot', text: 'summary: ' + days.length + ' days' });
return { topic: 'hpHistory', payload: { kind: 'summary', days } };
