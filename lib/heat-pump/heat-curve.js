//! @shared
//! Weather curve math and owner-edit constraints shared by nodes 34, 35 and 40.
const P23_MIN = 0, P23_MAX = 40, P24_MIN = 1, P24_MAX = 30;
const CURVE_MIN_C = 20, CURVE_MAX_C = 60;
const HEAT_CURVE_END_LOCK_MS = 10 * 60_000;
function inCurveRange(v, min, max) { return Number.isFinite(v) && v >= min && v <= max; }
function validHeatCurve(p23, p24) {
    return inCurveRange(p23, P23_MIN, P23_MAX) && inCurveRange(p24, P24_MIN, P24_MAX);
}
function validOwnerCurve(p23, p24) { return Number.isInteger(p23) && Number.isInteger(p24) && validHeatCurve(p23, p24); }
function heatCurveAt(p23, p24, outdoor) { return Math.max(CURVE_MIN_C, Math.min(CURVE_MAX_C, CURVE_MIN_C + p24 / 10 * (p23 - outdoor))); }
function heatCurveEnabled(value) { return value === true || String(value) === '1'; }
function heatCurveWriteBlock(hp, valveOn, state, lastEnd, at) {
    if (!hp || hp.state !== 'CONNECTED' || !hp.lastData || at - hp.lastData > 5 * 60_000) return 'heat pump not connected or data stale';
    if ((state && state !== 'HEATING') || valveOn) return 'DHW cycle running; wait until it ends';
    if (lastEnd && at - lastEnd < HEAT_CURVE_END_LOCK_MS) return 'wait 10 minutes after the DHW cycle ends';
    if (!heatCurveEnabled(hp.dps?.['132'])) return 'P22 is off or unknown; enable the weather curve first';
    return '';
}
