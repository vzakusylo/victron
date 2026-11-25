//! lib/heat-pump/curves.js: DHW settings and the curve math: dhwCfg, curveAt, heatCurveAt, curveCoeffs, wantedSupply.
//! Included into "40 Heat pump automations.js" by `// #include` (tools/includes.js); it runs in that
//! function node's scope, not as a module. Lines starting with //! are not embedded in flows.json.
// ---- DHW controller settings (d#130, d#142: docs/heat-pump-dhw-curve-plan.md) ----------
const DHW_ID = 'dhw';
const DHW_NAME = 'DHW controller';
const UNIT_MAX_A = 9.67;   // nameplate PW030-DKZLRS-A
const DHW_DEFAULTS = {
    autoRetry: false, retryMax: 2, retryWait: 30,
    curve: [[-20, 37], [1, 50]],   // outdoor °C → tank target °C; d#161: a straight line, 40 °C at -15, 50 °C at 1
    frostLimit: -20,     // below: no DHW by the heat pump (electric heater only)
    hyst: 3,             // start when tank < target − hyst
    gap: 5,              // DHW: curve supply ≤ return + gap while the ramp runs
    gapRamp: true,       // raise the boiler P23 1 per minute while supply − return ≤ gap
    startGap: 7,         // d#191: while the compressor is off in a DHW cycle, the curve may ask water + startGap
    supplyAdd: 4,        // wanted DHW supply = tank target + supplyAdd
    maxSupply: 55,       // wanted supply cap
    boilerP24: 12,       // boiler curve coefficient (1.2 °C per °C); P23 is computed per cycle
    minIntervalH: 1,     // at most one DHW cycle per … h (d#176: 1 h, owner)
    maxMin: 60,          // max DHW cycle …
    maxMinCold: 30,      // … at outdoor ≤ coldLimit
    coldLimit: -10,      // at or below: Silent only, supply ≤ coldCap, coldIntervalH, maxMinCold, heating first
    coldCap: 46,         // wanted supply cap at outdoor ≤ coldLimit
    coldIntervalH: 3,    // min interval at outdoor ≤ coldLimit
    lagC: 2,             // heating lags = 30-min supply average > lagC below the heating curve
    protHz: 80,          // compressor protection: frequency …
    protAmpPct: 85,      // … or current in % of 9.67 A …
    protDischarge: 90,   // … or discharge (DP 104) °C, held 3 min → P23 − 2
    allowPowerful: false,
    defrostLead: 20,     // d#169: no DHW start when the next defrost is expected within … min
    supplyReady: 1,      // d#169: after a defrost start DHW only when supply ≥ heating set − … °C
    defrostEndPct: 30,   // d#173: a defrost after this % of the way to the target ends the cycle …
    defrostNextMin: 60,  // … and the next one is planned this many min later
    afterDefrost: true,  // d#176: in the defrost season (a defrost < 3 h ago) start only right after one …
    afterDefrostWinMin: 30,  // … within this many min after the supply recovered
    minGapH: 1,          // d#201: no new cycle when one ended (tank at target) less than … h ago; Force boiler run ignores it
    startAfterDefrost: false,  // d#201: a defrost ended, tank below target and the gap allows it → start DHW at once
    showerForce: false,     // opt-in: early demand bypasses only the interval / tank hysteresis
    showerLeadMin: 30       // observed median successful warmup is about 28 min
};
const DHW_LIMITS = { retryMax: [1, 5], retryWait: [5, 240], frostLimit: [-30, 10], hyst: [1, 10], gap: [3, 10], startGap: [3, 15], supplyAdd: [1, 10], maxSupply: [45, 55],
    boilerP24: [5, 30], minIntervalH: [0, 12], maxMin: [15, 180], maxMinCold: [10, 180], coldLimit: [-25, 5],
    coldCap: [40, 55], coldIntervalH: [0, 12], lagC: [1, 10], protHz: [50, 90], protAmpPct: [50, 100], protDischarge: [70, 110],
    defrostLead: [0, 60], supplyReady: [0, 5], defrostEndPct: [0, 100], defrostNextMin: [15, 240], afterDefrostWinMin: [5, 120],
    showerLeadMin: [5, 90], minGapH: [0, 12] };
// raw values that are missing or out of range keep the value of `base` (default: DHW_DEFAULTS)
function dhwCfg(raw, base) {
    const c = { ...DHW_DEFAULTS };
    for (const k of Object.keys(c)) if (base?.[k] !== undefined) c[k] = base[k];
    // The curve is the only nested value in the normalized config.
    c.curve = c.curve.map(p => p.slice());
    const r = raw || {};
    for (const k of Object.keys(DHW_LIMITS)) {
        const v = Number(r[k]);
        if (r[k] !== undefined && r[k] !== null && r[k] !== '' && Number.isFinite(v) && v >= DHW_LIMITS[k][0] && v <= DHW_LIMITS[k][1]) c[k] = v;
    }
    if (typeof r.allowPowerful === 'boolean') c.allowPowerful = r.allowPowerful;
    if (typeof r.gapRamp === 'boolean') c.gapRamp = r.gapRamp;
    if (typeof r.autoRetry === 'boolean') c.autoRetry = r.autoRetry;
    c.retryMax = Math.floor(c.retryMax);
    if (typeof r.afterDefrost === 'boolean') c.afterDefrost = r.afterDefrost;
    if (typeof r.startAfterDefrost === 'boolean') c.startAfterDefrost = r.startAfterDefrost;
    if (typeof r.showerForce === 'boolean') c.showerForce = r.showerForce;
    if (Array.isArray(r.curve) && r.curve.length >= 2 && r.curve.length <= 8) {
        const pts = r.curve.map((p) => [Number(p[0]), Number(p[1])]);
        const okPts = pts.every((p, i) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= -30 && p[0] <= 20
            && p[1] >= 30 && p[1] <= 55 && (i === 0 || p[0] > pts[i - 1][0]));
        if (okPts) c.curve = pts;
    }
    return c;
}
function curveAt(curve, x) {
    if (x <= curve[0][0]) return curve[0][1];
    const last = curve[curve.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < curve.length; i++) {
        const a = curve[i - 1], b = curve[i];
        if (x <= b[0]) return Math.round((a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])) * 2) / 2;
    }
    return last[1];
}
// boiler curve (d#142): P23 that makes the pump's curve give supply `w` at outdoor `x` with P24 `p24`
// d#172: P23 / P24 that make the pump's curve give at least w at outdoor x: P23 first (slope p24), and once P23 would
// pass 40 P23 40 with a steeper P24 (≤ 30)
// d#173: % of the way from the tank at the cycle start to the target (0…100), null when unknown
function dhwProgress(start, tank, target) {
    if (![start, tank, target].every(Number.isFinite) || target <= start) return null;
    return Math.max(0, Math.min(100, Math.round((tank - start) / (target - start) * 100)));
}
function curveCoeffs(w, x, p24) {
    const p23 = Math.ceil(x + (w - 20) / (p24 / 10) - 1e-9);
    if (p23 <= P23_MAX) return { p23: Math.max(P23_MIN, p23), p24 };
    return { p23: P23_MAX, p24: Math.min(P24_MAX, Math.max(p24, Math.ceil((w - 20) * 10 / Math.max(1, P23_MAX - x) - 1e-9))) };
}
function p23For(w, x, p24) { return Math.max(P23_MIN, Math.min(P23_MAX, Math.round(x + (w - 20) / (p24 / 10)))); }
// wanted DHW supply at outdoor x (tank target + supplyAdd, capped; capped lower in the cold)
function wantedSupply(c, x) {
    const t = x === null || x < c.frostLimit ? null : curveAt(c.curve, x);
    if (t === null) return null;
    return Math.min(c.maxSupply, t + c.supplyAdd, x <= c.coldLimit ? c.coldCap : 99);
}
