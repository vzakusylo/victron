//! Node 34: Heating curve and outdoor display.
// Built-in weather curve of the controller (P22 on)
const CURVE_BASE_C = 20;
const CURVE_MIN_C = 20;
const CURVE_MAX_C = 60;
const CURVE_OUT_MIN = -25;
const CURVE_OUT_MAX = 25;

function curveTarget(p23, p24, outdoor) {
    const t = CURVE_BASE_C + (p24 / 10) * (p23 - outdoor);
    return Math.max(CURVE_MIN_C, Math.min(CURVE_MAX_C, Math.round(t * 10) / 10));
}

// H2 / H7: during a defrost and its recovery DP 103 reads 30–47 °C; 40 holds the 10-min average (dhwView.outHeld)
function outdoorShown(d) {
    const dv = flow.get('dhwView');
    const fresh = !!(dv && dv.at && Date.now() - dv.at <= DHW_VIEW_STALE_MS);
    const held = fresh && dv.outHeld === true && Number.isFinite(dv.outAvg);
    return { value: held ? dv.outAvg : num(d['103']), held, raw: num(d['103']) };
}

function buildCurveChart(d) {
    const dv = flow.get('dhwView');
    const boilerActive = dhwCycle() && dv && dv.heatCurve;
    const p23 = boilerActive ? dv.heatCurve.p23 : num(d['133']);
    const p24 = boilerActive ? dv.heatCurve.p24 : num(d['134']);
    if (p23 === null || p24 === null) return null;
    const enabled = d['132'] === undefined ? null : String(d['132']) === '1' || d['132'] === true;
    const sensor = num(d['103']);
    // d#195: the curve point uses the outdoor value the pump computes its set point from (latched by 40 from DP 125),
    // else the 10-min sensor average, else DP 103; `sensor` stays visible as the outdoor sensor
    const dvFresh = !!(dv && dv.at && Date.now() - dv.at <= DHW_VIEW_STALE_MS);
    const po = dvFresh && dv.pumpOut && Number.isFinite(dv.pumpOut.v) && Date.now() - dv.pumpOut.at < 3 * 3600 * 1000 ? dv.pumpOut : null;
    const fb = dvFresh && dv.outAvg !== null && dv.outAvg !== undefined ? dv.outAvg : sensor;
    const outdoor = po ? po.v : fb;
    const outdoorSource = po ? 'pump' : 'sensor';
    const outdoorText = po ? 'pump outdoor ' + po.v + ' °C (from its set point)' : fb === null ? 'no outdoor value' : 'sensor ' + fb + ' °C (fallback)';
    const supply = num(d['102']);
    const reported = num(d['125']);

    const pts = [];
    for (let t = CURVE_OUT_MIN; t <= CURVE_OUT_MAX; t++) pts.push({ out: t, set: curveTarget(p23, p24, t) });

    // SVG frame: viewBox 0 0 600 240, plot area x 44…590, y 12…204
    const W = 600, H = 240, L = 44, R = 10, T = 12, B = 36;
    const values = pts.map((p) => p.set).concat([supply, reported].filter((v) => v !== null));
    const yMin = Math.floor(Math.min(CURVE_MIN_C, ...values) / 5) * 5;
    const yMax = Math.ceil((Math.max(...values) + 1) / 5) * 5;   // at least 1 °C headroom
    const x = (t) => +(L + (t - CURVE_OUT_MIN) / (CURVE_OUT_MAX - CURVE_OUT_MIN) * (W - L - R)).toFixed(1);
    const y = (v) => +(T + (yMax - v) / (yMax - yMin) * (H - T - B)).toFixed(1);
    const inRange = (t) => t !== null && t >= CURVE_OUT_MIN && t <= CURVE_OUT_MAX;

    const xTicks = [];
    for (let t = CURVE_OUT_MIN; t <= CURVE_OUT_MAX; t += 5) xTicks.push({ label: t, x: x(t) });
    const yTicks = [];
    for (let v = yMin; v <= yMax; v += 5) yTicks.push({ label: v, y: y(v) });

    const target = outdoor === null ? null : curveTarget(p23, p24, outdoor);
    return {
        enabled,
        boilerActive: !!boilerActive,
        pumpP23: num(d['133']),
        pumpP24: num(d['134']),
        p23,
        p24,
        formula: `${CURVE_BASE_C} + ${p24 / 10} × (${p23} − outdoor)`,
        table: [-20, -15, -10, -5, 0, 5, 10, 15].map((t) => ({ out: t, set: curveTarget(p23, p24, t) })),
        outdoor,
        outdoorSource,
        outdoorText,
        sensor,
        target,
        reported,
        supply,
        svg: {
            viewBox: `0 0 ${W} ${H}`,
            line: pts.map((p) => `${x(p.out)},${y(p.set)}`).join(' '),
            xTicks,
            yTicks,
            left: L,
            right: W - R,
            top: T,
            bottom: H - B,
            yMin,
            yMax,
            outMin: CURVE_OUT_MIN,
            outMax: CURVE_OUT_MAX,
            now: inRange(outdoor) ? {
                x: x(outdoor),
                yTarget: y(target),
                ySupply: supply === null ? null : y(supply),
                yReported: reported === null ? null : y(reported)
            } : null
        }
    };
}
