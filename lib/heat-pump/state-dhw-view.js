//! Node 34: DHW and controller views.
// Boiler curve (d#134): tank target by outdoor temperature from the DHW controller of
// "Heat pump automations" (40), which writes flow.dhwView every 10 s. Same SVG frame and
// outdoor range as the heating curve, so the two charts sit side by side on the page.
const DHW_VIEW_STALE_MS = 2 * 60 * 1000;
const DHW_STATE_LABELS = { HEATING: 'heating (valve on heating)', PREHEAT: 'preheat (older version)', STOP: 'compressor stop (curve P23 0) before the valve switch', VALVE: 'valve moving to the tank (curve P23 0)',
    DHW: 'heating the tank on the boiler curve', DEFROST_DHW: 'defrost during DHW (valve on heating)', RAMPDOWN: 'older version' };
// d#142: the DHW controller runs the pump on its own curve; during a cycle the pump shows the
// boiler / stop values, the heating chart then uses the stored heating curve (dhwView.heatCurve)
// d#166: heating power controller of 40 (mode Silent ⇄ Smart by the supply lag), from flow.dhwView.heat
function buildHeatCtl() {
    const v = flow.get('dhwView');
    if (!v || !v.heat) return null;
    return Object.assign({ fresh: !!v.at && Date.now() - v.at <= DHW_VIEW_STALE_MS, master: v.master === undefined ? null : v.master }, v.heat);
}
// d#201: the one status line, built in 40 (flow.dhwView.status)
function buildStatus() {
    const v = flow.get('dhwView');
    if (!v || !v.status) return { kind: 'idle', text: 'Waiting for the automations…', since: 0, fresh: false };
    return Object.assign({}, v.status, { fresh: !!v.at && Date.now() - v.at <= DHW_VIEW_STALE_MS });
}
function dhwCycle() { const v = flow.get('dhwView'); return !!(v && v.state && v.state !== 'HEATING' && v.at && Date.now() - v.at <= DHW_VIEW_STALE_MS); }
// exact = no rounding (chart lines, d#161: a straight line instead of 0.5 °C steps); the
// controller (40) and the table use the target rounded to 0.5 °C
function wantedAt(c, t, exact) {
    if (t < c.frostLimit) return null;
    return Math.min(c.maxSupply || 55, tankCurveAt(c.curve, t, exact) + (c.supplyAdd || 4), t <= c.coldLimit ? (c.coldCap || 46) : 99);
}
function tankCurveAt(curve, x, exact) {
    if (x <= curve[0][0]) return curve[0][1];
    const last = curve[curve.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < curve.length; i++) {
        const a = curve[i - 1], b = curve[i];
        if (x <= b[0]) {
            const v = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
            return exact ? v : Math.round(v * 2) / 2;
        }
    }
    return last[1];
}
// "tank = 37 + 0.62 × (outdoor + 20)" for a curve of two points (d#161)
function curveFormula(curve) {
    if (curve.length !== 2) return '';
    const [a, b] = curve, k = (b[1] - a[1]) / (b[0] - a[0]);
    return 'tank = ' + a[1] + ' + ' + (Math.round(k * 100) / 100) + ' × (outdoor ' + (a[0] < 0 ? '+ ' + (-a[0]) : '− ' + a[0]) + ')';
}
function buildDhwChart(d) {
    const v = flow.get('dhwView');
    if (!v || !v.cfg || !Array.isArray(v.cfg.curve) || !v.cfg.curve.length) return null;
    const c = v.cfg, curve = c.curve;
    const tank = num(d['108']);
    const outdoor = v.outAvg !== null && v.outAvg !== undefined ? v.outAvg : num(d['103']);
    const pts = [];
    for (let t = CURVE_OUT_MIN; t <= CURVE_OUT_MAX; t++) pts.push({ out: t, set: t < c.frostLimit ? null : tankCurveAt(curve, t, true) });
    const W = 600, H = 240, L = 44, R = 10, T = 12, B = 36;
    const wpts = pts.map((p) => ({ out: p.out, w: wantedAt(c, p.out, true) }));
    const supplyNow = num(d['102']);
    const values = pts.filter((p) => p.set !== null).map((p) => p.set).concat(wpts.filter((p) => p.w !== null).map((p) => p.w)).concat([tank].filter((x) => x !== null));
    const yMin = Math.floor((Math.min(...values) - c.hyst - 1) / 5) * 5;
    const yMax = Math.ceil((Math.max(...values) + 1) / 5) * 5;
    const x = (t) => +(L + (t - CURVE_OUT_MIN) / (CURVE_OUT_MAX - CURVE_OUT_MIN) * (W - L - R)).toFixed(1);
    const y = (val) => +(T + (yMax - Math.max(yMin, Math.min(yMax, val))) / (yMax - yMin) * (H - T - B)).toFixed(1);
    const line = (off) => pts.filter((p) => p.set !== null).map((p) => `${x(p.out)},${y(p.set - off)}`).join(' ');
    const xTicks = [];
    for (let t = CURVE_OUT_MIN; t <= CURVE_OUT_MAX; t += 5) xTicks.push({ label: t, x: x(t) });
    const yTicks = [];
    for (let val = yMin; val <= yMax; val += 5) yTicks.push({ label: val, y: y(val) });
    const target = outdoor === null || outdoor < c.frostLimit ? null : tankCurveAt(curve, outdoor);
    const wanted = outdoor === null ? null : wantedAt(c, outdoor);
    const inCycle = dhwCycle();
    const inRange = outdoor !== null && outdoor >= CURVE_OUT_MIN && outdoor <= CURVE_OUT_MAX;
    return {
        fresh: !!v.at && Date.now() - v.at <= DHW_VIEW_STALE_MS,
        mode: v.mode,
        master: v.master === undefined ? null : v.master,
        lag: v.lag === undefined ? null : v.lag,
        defrost: v.defrost || null,   // d#169: next defrost forecast of 40
        progress: v.progress === undefined ? null : v.progress,   // d#173: % of the way to the tank target
        planned: v.planned || 0,
        blocked: v.blocked || null,   // d#174: DHW blocked after an aborted cycle
        shower: v.shower || null,
        startTank: v.startTank === undefined ? null : v.startTank,
        cfg: c,
        state: v.state,
        stateLabel: DHW_STATE_LABELS[v.state] || v.state,
        why: v.waitNote || v.why || '',
        since: v.since,
        outdoor,
        tank,
        target,
        start: target === null ? null : target - c.hyst,
        hyst: c.hyst,
        frostLimit: c.frostLimit,
        nextStart: v.nextStart || 0,
        lastEnd: v.lastEnd || 0,
        // d#161: read-only table at the same outdoor points as the heating curve
        table: [-20, -15, -10, -5, 0, 5, 10, 15].map((t) => ({ out: t, set: t < c.frostLimit ? null : tankCurveAt(curve, t), w: wantedAt(c, t) })),
        formula: curveFormula(curve),
        wanted,
        cold: !!v.cold,
        inCycle,
        p23Cmd: v.p23Cmd === undefined ? null : v.p23Cmd,
        p24Cmd: v.p24Cmd === undefined ? null : v.p24Cmd,
        goalP23: v.goalP23 === undefined ? null : v.goalP23,
        curveSupply: v.curveSupply === undefined ? null : v.curveSupply,
        boilerP23Now: outdoor === null || wanted === null ? null : Math.max(0, Math.min(40, Math.round(outdoor + (wanted - 20) / ((c.boilerP24 || 12) / 10)))),
        prot: v.prot || null,
        plan: v.plan || null,
        heatCurve: v.heatCurve || null,
        supplyNow,
        svg: {
            line: line(0),
            supplyLine: wpts.filter((p) => p.w !== null).map((p) => `${x(p.out)},${y(p.w)}`).join(' '),
            startLine: line(c.hyst),
            frostX: c.frostLimit > CURVE_OUT_MIN ? x(c.frostLimit) : null,
            yMin, yMax, outMin: CURVE_OUT_MIN, outMax: CURVE_OUT_MAX,
            xTicks,
            yTicks,
            left: L,
            right: W - R,
            top: T,
            bottom: H - B,
            now: inRange ? { x: x(outdoor), yTarget: target === null ? null : y(target), yStart: target === null ? null : y(target - c.hyst),
                yTank: tank === null ? null : y(tank), yWanted: wanted === null ? null : y(wanted),
                ySupply: inCycle && supplyNow !== null ? y(supplyNow) : null } : null
        }
    };
}
