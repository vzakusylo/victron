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
// - compKwh = heat pump estimate, DP 112 A × 220 W/A (nameplate 9.67 A = 2.13 kW, d#133)
// State:
// - flow.hpDayCache = { 'YYYY-MM-DD': stats } for finished days (not today), last 60 days;
//   "Heat pump command" (37) skips cached days when it reads the summary.
// Event lane (d#130): chart.events = segments of heating (compressor runs), DHW (valve ON),
// preheat (bypass ON, valve OFF, set point ≥ 40) and defrost (fan 0 while the compressor runs
// > 30 Hz, plus the bypass time after it at a heating set point).
// Change notes:
// 1. Initial version (d#121).
// 10. d#154: meter power (`pw`) is ignored while the meter state letter is not C (a stale /
//    offline meter no longer adds kWh at its last reading).
// 12. d#162: two power charts (owner: "split Power, W: compressor power, current and voltage
//    (calculated) and the SA1 meter W, current and voltage (measured)"): chart.powers = [compressor,
//    meter], each W / A / V. Meter V and A are decoded from the recorded raw DP 6 (column m6),
//    only while the meter state letter is C. Replaces chart.power.
// 11. d#160: the meter series of the power chart is named "Power meter SA1 W (current transformer
//    on the heat pump wire)" (owner: add the SA1 meter to the Power chart; it was there as
//    "Heat pump W (meter)").
// 2. d#130: event lane under the temperature chart (heating / DHW / preheat / defrost).
// 4. d#133: power estimate = A × 220 W/A (nameplate) instead of A × DC bus voltage.
// 9. d#145: event lane kind 'error' (red) while DP 15 reports a fault, with the Er codes; at least
//    2.5 px wide so a short fault is visible; counted in the legend.
// 8. d#143: chart.plan (today only, while a DHW cycle runs): dashed tank target line from the cycle
//    start and a dashed projection from the tank now to the target at the expected end (flow.dhwView).
// 7. d#141: compressor current (DP 112) as a third power-chart series on a right axis (A);
//    every power series carries its axis maximum `max` for the tooltip dots.
// 6. d#136: chart.temp[].v / chart.power.series[].v = value per 2-min bucket (hover tooltip), chart.nb.
// 5. d#134: the power panel under the event lane is removed (owner); power is a separate chart
//    (chart.power) with compressor power = DC bus voltage (DP 114) × current (DP 112) (owner;
//    reads ~1.7× the nameplate-based A × 220 W/A) and the meter W; the ≈kWh estimate uses it too.
// 3. d#132: Accumulator (`atemp`) and Exchange plate (`xtemp`) cloud sensors on the day chart
//    (a series is shown only when the day has data for it).
// ==========================

// mv / ma (d#162) = SA1 meter voltage / current, decoded from its raw DP 6 (column `m6`)
const KEYS = ['101', '102', '103', '108', '112', '114', '115', '116', 'v1', 'b1', 'pw', '125', 'atemp', 'xtemp', '15', 'mv', 'ma'];
// DP 15 fault bits (same list as 34 / 40), for the red error marks of the event lane (d#145)
const FAULT_LABELS = ['Er03', 'Er04', 'Er05', 'Er06', 'Er09', 'Er10', 'Er12', 'Er14', 'Er15', 'Er16',
    'Er18', 'Er20', 'Er21', 'Er23', 'Er26', 'Er27', 'Er29', 'Er32', 'Er33', 'Er34', 'Er42', 'Er62',
    'Er63', 'Er64', 'Er66', 'Er67', 'Er68', 'Er69', 'Er70'];
const faultCodes = (v) => FAULT_LABELS.filter((_, i) => (Number(v) & (1 << i)) !== 0).join(' ');
const K = {};
KEYS.forEach((k, i) => { K[k] = i; });
const MAX_DT = 120;
const W_PER_A = 220;   // nameplate PW030-DKZLRS-A: 2130 W / 9.67 A (d#133); only when DP 114 is missing
// d#134 (owner): compressor power = DC bus voltage (DP 114) × compressor current (DP 112)
const compW = (amp, bus) => (amp === null ? null : Math.max(0, amp) * (bus !== null && bus > 0 ? bus : W_PER_A));
const BUCKET_S = 120;
// SA1 DP 6 (base64): voltage 2 B (0.1 V), current 3 B (mA), power 3 B (W) — same decode as 34
function meterVA(s) {
    let b;
    try { b = Buffer.from(String(s), 'base64'); } catch (e) { return null; }
    if (!b || b.length < 8) return null;
    return { v: b.readUInt16BE(0) / 10, a: b.readUIntBE(2, 3) / 1000 };
}
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
    let meterState = 'U';
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
            idx.m6 = cols.indexOf('m6');
            last = KEYS.map(() => null);
            hpState = 'U';
            meterState = 'U';
            continue;
        }
        if (!idx) continue;
        const cells = line.split(',');
        const t = Number(cells[0]);
        if (!Number.isFinite(t)) continue;
        if (cells[1]) { hpState = cells[1].charAt(0); meterState = cells[1].charAt(3) || 'U'; }
        for (let i = 0; i < KEYS.length; i++) {
            const c = idx[i];
            if (c > 1 && cells[c] !== undefined && cells[c] !== '') {
                const n = Number(cells[c]);
                last[i] = Number.isFinite(n) ? n : null;
            }
        }
        const m6 = idx.m6 > 1 ? cells[idx.m6] : undefined;
        if (m6 !== undefined && m6 !== '') {
            const va = meterVA(m6);
            last[K.mv] = va ? va.v : null;
            last[K.ma] = va ? va.a : null;
        }
        const a = last.slice();
        // An empty `pw` field means "unchanged", so a meter that went stale or offline would keep
        // its last power for hours: the power only counts while the meter letter is C.
        if (meterState !== 'C') { a[K.pw] = null; a[K.mv] = null; a[K.ma] = null; }
        days[day].rows.push({ s: hour * 3600 + t, ok: hpState === 'C', a });
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
            const c = compW(amp, bus) * dt / 3600;
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
// dv = flow.dhwView for today (d#143): plan of the running DHW cycle, drawn as dashed lines
function chart(rows, dv) {
    const W = 760, L = 40, R = 12;
    // d#134: the event lane is the bottom of the temperature chart; power has its own chart (power)
    const T1 = 10, B1 = 200, B2 = 224;
    const PT = 8, PB = 128;   // power chart, viewBox 0 0 760 156
    const nb = Math.ceil(86400 / BUCKET_S);
    const buckets = [];
    for (let i = 0; i < nb; i++) buckets.push(null);
    rows.forEach((r) => {
        if (!r.ok) return;
        const i = Math.min(nb - 1, Math.floor(r.s / BUCKET_S));
        const b = buckets[i] || (buckets[i] = KEYS.map(() => ({ s: 0, n: 0 })).concat([{ s: 0, n: 0 }]));
        KEYS.forEach((k, j) => { const v = r.a[j]; if (v !== null) { b[j].s += v; b[j].n++; } });
        const amp = r.a[K['112']], bus = r.a[K['114']];
        if (amp !== null) { b[KEYS.length].s += compW(amp, bus); b[KEYS.length].n++; }
    });
    const val = (b, j) => (b && b[j].n ? b[j].s / b[j].n : null);
    const x = (i) => +(L + (i + 0.5) * BUCKET_S / 86400 * (W - L - R)).toFixed(1);

    const tempDefs = [['Supply', '102', '#d62728'], ['Return', '101', '#1f77b4'], ['Tank', '108', '#ff7f0e'], ['Outdoor', '103', '#2ca02c'],
        ['Accumulator', 'atemp', '#9467bd'], ['Exchange plate', 'xtemp', '#bcbd22']];

    let tMin = Infinity, tMax = -Infinity;
    buckets.forEach((b) => {
        tempDefs.forEach(([, k]) => { const v = val(b, K[k]); if (v !== null) { tMin = Math.min(tMin, v); tMax = Math.max(tMax, v); } });
    });
    if (!Number.isFinite(tMin)) { tMin = 0; tMax = 50; }
    const yMin = Math.floor(tMin / 10) * 10, yMax = Math.max(yMin + 10, Math.ceil(tMax / 10) * 10);
    const yT = (v) => +(T1 + (yMax - v) / (yMax - yMin) * (B1 - T1)).toFixed(1);

    // d#162: one power chart: W on the left axis, A on the right axis (same grid), V on its own
    // scale (day min … max, labels in the plot)
    function powerChart(id, title, note, wDef, aDef, vDef) {
        let wMax = 0, aMax = 0, vMin = Infinity, vMax = -Infinity;
        buckets.forEach((b) => {
            const w = val(b, wDef[1]), am = val(b, aDef[1]), v = val(b, vDef[1]);
            if (w !== null) wMax = Math.max(wMax, w);
            if (am !== null) aMax = Math.max(aMax, am);
            if (v !== null) { vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); }
        });
        const top = Math.max(1000, Math.ceil(wMax / 1000) * 1000);
        const yP = (v) => +(PB - v / top * (PB - PT)).toFixed(1);
        const ticks = [];
        for (let v = 0; v <= top; v += top <= 2000 ? 500 : 1000) ticks.push({ label: v >= 1000 ? (v / 1000) + 'k' : v, y: yP(v) });
        const steps = ticks.length - 1;
        const aStep = Math.max(1, Math.ceil(Math.max(aMax, 1) / steps));
        const aTop = aStep * steps;
        const yA = (v) => +(PB - v / aTop * (PB - PT)).toFixed(1);
        const aTicks = ticks.map((tk, i) => ({ label: i * aStep, y: tk.y }));
        let vLo = null, vHi = null;
        if (Number.isFinite(vMin)) { vLo = Math.floor(vMin / 10) * 10 - 10; vHi = Math.ceil(vMax / 10) * 10 + 10; }
        const yV = (v) => +(PB - (v - vLo) / (vHi - vLo) * (PB - PT)).toFixed(1);
        const series = [
            { name: wDef[0], color: wDef[2], unit: 'W', min: 0, max: top, segs: segs(wDef[1], yP), v: vals(wDef[1], 0) },
            { name: aDef[0], color: aDef[2], unit: 'A', min: 0, max: aTop, right: true, segs: segs(aDef[1], yA), v: vals(aDef[1], 2) }
        ];
        if (vLo !== null) series.push({ name: vDef[0], color: vDef[2], unit: 'V', min: vLo, max: vHi, volt: true, segs: segs(vDef[1], yV), v: vals(vDef[1], 1) });
        return { id, title, note, viewBox: '0 0 ' + W + ' 156', top: PT, bottom: PB, ticks, aTicks, max: top, aMax: aTop,
            vLabels: vLo === null ? null : { hi: vHi, lo: vLo, color: vDef[2] }, series: series.filter((s) => s.segs.length) };
    }
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
    // d#136: value per bucket for the hover tooltip of the page (null = no data)
    const vals = (j, dec) => buckets.map((b) => { const v = val(b, j); return v === null ? null : +v.toFixed(dec); });
    const tTicks = [];
    for (let v = yMin; v <= yMax; v += 10) tTicks.push({ label: v, y: yT(v) });
    const xTicks = [];
    for (let h = 0; h <= 24; h += 3) xTicks.push({ label: pad(h % 24) + ':00', x: +(L + h / 24 * (W - L - R)).toFixed(1) });

    // event lane between the two charts: what the heat pump did, from the recorded states
    const EV = { heating: '#2ca02c', dhw: '#ff7f0e', preheat: '#e377c2', defrost: '#17becf', error: '#da3633' };
    const xs = (s) => +(L + s / 86400 * (W - L - R)).toFixed(1);
    const events = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.ok) continue;
        const a = r.a, hz = a[K['115']], fan = a[K['116']];
        // bypass ON with a DHW set point (≥ 40) = preheat; with a heating set point = after a defrost
        const flt = a[K['15']];
        const kind = flt !== null && flt > 0 ? 'error'
            : fan === 0 && hz !== null && hz > 30 ? 'defrost'
            : a[K.v1] === 1 ? 'dhw'
            : a[K.b1] === 1 ? (a[K['125']] !== null && a[K['125']] >= 40 ? 'preheat' : 'defrost')
            : hz !== null && hz > 0 ? 'heating' : null;
        const s1 = r.s, s2 = rows[i + 1] ? Math.min(rows[i + 1].s, r.s + MAX_DT) : r.s + 30;
        const last = events[events.length - 1];
        if (kind && last && last.kind === kind && s1 - last.s2 <= MAX_DT) last.s2 = s2;
        else if (kind) events.push({ kind, s1, s2, codes: kind === 'error' ? faultCodes(flt) : '' });
    }
    const evOut = events.map((e) => ({ kind: e.kind === 'error' ? 'error ' + e.codes : e.kind, err: e.kind === 'error', color: EV[e.kind], x: xs(e.s1), w: Math.max(e.kind === 'error' ? 2.5 : 0.8, +(xs(e.s2) - xs(e.s1)).toFixed(1)),
        from: pad(Math.floor(e.s1 / 3600)) + ':' + pad(Math.floor(e.s1 % 3600 / 60)), min: Math.round((e.s2 - e.s1) / 60) }));
    // d#143: where the running DHW cycle is heading — target line and the expected end
    let plan = null;
    const okRows = rows.filter((r) => r.ok);
    if (dv && dv.plan && dv.at && Date.now() - dv.at <= 2 * 60 * 1000 && okRows.length) {
        const p = dv.plan, lastS = okRows[okRows.length - 1].s, nowMs = Date.now();
        const sOf = (ms) => Math.max(0, Math.min(86400, lastS + (ms - nowMs) / 1000));
        const clampY = (v) => yT(Math.max(yMin, Math.min(yMax, v)));
        const eta = new Date(p.eta);
        plan = { x0: xs(sOf(p.startAt)), xNow: xs(lastS), yNow: p.tank === null || p.tank === undefined ? null : clampY(p.tank),
            xEnd: xs(sOf(p.eta)), yTarget: clampY(p.target), target: p.target, rate: p.rate, byMax: !!p.byMax,
            etaText: pad(eta.getHours()) + ':' + pad(eta.getMinutes()), state: dv.state };
    }
    const evCount = {};
    events.forEach((e, i) => { if (e.kind !== 'heating' && (i === 0 || events[i - 1].kind !== e.kind)) evCount[e.kind] = (evCount[e.kind] || 0) + 1; });

    return {
        viewBox: '0 0 ' + W + ' 250',
        left: L, right: W - R, t1: T1, b1: B1, b2: B2, nb, bucketS: BUCKET_S, yMin, yMax,
        evTop: B1 + 6, evH: 14,
        events: evOut,
        plan,
        eventLegend: Object.keys(EV).map((k) => ({ kind: k, color: EV[k], count: k === 'heating' ? null : (evCount[k] || 0) })),
        xTicks, tTicks,
        temp: tempDefs.map(([name, k, color]) => ({ name, color, unit: '°C', segs: segs(K[k], yT), v: vals(K[k], 1) })).filter((s) => s.segs.length),
        // d#162 (owner): two power charts — compressor (calculated: DC bus V × current) and the SA1
        // meter (measured on the heat pump wire); each W (left axis), A (right axis), V (own scale)
        powers: [
            powerChart('compressor', 'Compressor (calculated)', 'compressor power = DC bus voltage (DP 114) × compressor current (DP 112); the heat pump\'s own readings',
                ['Compressor W', KEYS.length, '#8c564b'], ['Compressor current, A', K['112'], '#e377c2'], ['DC bus voltage, V', K['114'], '#7f7f7f']),
            powerChart('meter', 'Power meter SA1 (measured)', 'SA1 current transformer on the heat pump wire: power, current and mains voltage of the whole unit',
                ['Meter W', K.pw, '#9467bd'], ['Meter current, A', K.ma, '#17becf'], ['Mains voltage, V', K.mv, '#bcbd22'])
        ].filter((c) => c.series.length)
    };
}

// ---- main ---------------------------------------------------------------
const text = Buffer.isBuffer(msg.payload) ? msg.payload.toString('utf8') : String(msg.payload || '');
const parsed = parse(text);
const nowD = new Date();
const today = nowD.getFullYear() + '-' + pad(nowD.getMonth() + 1) + '-' + pad(nowD.getDate());
const cache = flow.get('hpDayCache2') || {};

if (msg.topic === 'day') {
    const d = parsed.days[msg.day];
    if (!d || !d.rows.length) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'no data for ' + msg.day });
        return { topic: 'hpHistory', payload: { kind: 'day', day: msg.day, empty: true } };
    }
    const s = stats(d.rows);
    if (msg.day < today) { cache[msg.day] = s.stats; }
    flow.set('hpDayCache2', cache);
    node.status({ fill: 'green', shape: 'dot', text: msg.day + ': ' + d.rows.length + ' samples' });
    return { topic: 'hpHistory', payload: { kind: 'day', day: msg.day, stats: s.stats, hourly: s.hourly, chart: chart(d.rows, msg.day === today ? flow.get('dhwView') : null) } };
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
flow.set('hpDayCache2', trimmed);
node.status({ fill: 'green', shape: 'dot', text: 'summary: ' + days.length + ' days' });
return { topic: 'hpHistory', payload: { kind: 'summary', days } };
