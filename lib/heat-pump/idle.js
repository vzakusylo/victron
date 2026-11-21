//! lib/heat-pump/idle.js: why the compressor is off outside DHW / defrost (idle cause), the log lines "Idle: …" and
//! "running again after N min", and the cause published to the status line and the recorder (36).
//! Included into "40 Heat pump automations.js" by `// #include` (tools/includes.js); it runs in that
//! function node's scope, not as a module. Lines starting with //! are not embedded in flows.json.
// ---- idle cause (H0 / H11) -----------------------------------------------------------
// Codes are stored in the recorder column `idl` (36) and read by 38; never renumber, only append.
const IDLE_CAUSES = { 1: ['stale', 'heat pump not connected / data stale'], 2: ['pumpOff', 'heat pump off'], 3: ['fault', 'pump fault'],
    4: ['ctrlOff', 'controller Off'], 5: ['defrost', 'after a defrost (quiet period)'], 6: ['dhwEnd', 'after a DHW cycle'],
    7: ['point', 'curve point reached'], 8: ['hyst', 'pump hysteresis (waiting for the restart level)'],
    9: ['below', 'supply below the restart level, compressor not starting'] };
const IDLE_LOG_AFTER_MS = 60 * 1000;   // a compressor stop shorter than this is not logged
// pure: i = { ready, pumpOn, fault, ctrl ('off' | 'dry' | 'live'), defrostMin, dhwEndMin, sup, point, set, hyst }
// first match wins: what the pump / controller cannot do anything about comes first, then what the pump itself decides
function idleClassify(i) {
    const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    if (!i.ready) return 1;
    if (i.pumpOn === false) return 2;
    if (i.fault > 0) return 3;
    if (i.ctrl === 'off') return 4;
    if (fin(i.defrostMin) && i.defrostMin < DEFROST_QUIET_MIN) return 5;
    if (fin(i.dhwEndMin) && i.dhwEndMin < HEAT_WINDOW_MIN) return 6;
    const sup = Number(i.sup), lim = Math.min(...[i.point, i.set].filter(fin).map(Number));
    if (fin(i.sup) && Number.isFinite(lim) && sup >= lim) return 7;
    if (fin(i.sup) && fin(i.set) && fin(i.hyst) && sup > Number(i.set) - Number(i.hyst)) return 8;
    return 9;
}
function idleInputs() {
    const H = (st.hp && st.hp.dps) || {};
    const h = heatState(), d = context.get('dhw') || {};
    const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
    const dhwEnd = dhwLastEnd(d);
    // the pump stops / restarts on ITS curve (P23 / P24 at its outdoor value), not on the reported DP 125, which does not follow a written curve
    const po = pumpOutNow(), x = po ? po.v : d.outAvg;
    const set = [num(H['133']), num(H['134']), x].every(Number.isFinite) ? heatCurveAt(num(H['133']), num(H['134']), x) : num(H['125']);
    const lastDef = context.get('lastDefrost') || 0;
    return { ready: ready('hp'), pumpOn: H['1'] === undefined ? undefined : H['1'] === true, fault: num(H['15']) || 0, ctrl: modeOf(HEAT_ID),
        defrostMin: lastDef ? (now - lastDef) / MIN : null, dhwEndMin: dhwEnd ? (now - dhwEnd) / MIN : null,
        sup: num(H['102']), point: h.target, set, hyst: num(H['121']), outdoor: num(H['103']), mode: MODE_NAME[H['2']] || H['2'] };
}
function idleCause() {
    const i = idleInputs();
    const code = idleClassify(i);
    const faults = FAULT_LABELS.filter((_, k) => (i.fault & (1 << k)) !== 0).join(' ');
    const text = code === 3 && faults ? 'pump fault ' + faults : IDLE_CAUSES[code][1];
    const f = (v) => (Number.isFinite(v) ? v : '?');
    const detail = 'supply ' + f(i.sup) + ', point ' + f(Number(i.point === null || i.point === undefined ? i.set : i.point)) + ', outdoor ' + f(i.outdoor)
        + ', pump stops at ' + f(Number.isFinite(i.set) ? +i.set.toFixed(1) : NaN) + ', mode ' + (i.mode || '?') + ', hysteresis ' + f(i.hyst);
    return { code, key: IDLE_CAUSES[code][0], text, detail };
}
// the compressor is stopped and the pump is neither in a DHW cycle nor in a defrost
function idleNow() {
    const H = (st.hp && st.hp.dps) || {}, V = (st.valve && st.valve.dps) || {}, B = (st.bypass && st.bypass.dps) || {};
    const d = context.get('dhw') || {};
    if (!ready('hp')) return false;
    if (H['115'] === null || H['115'] === undefined || H['115'] === '' || n(H['115']) !== 0) return false;
    if ((d.state && d.state !== 'HEATING') || V['1'] === true || B['1'] === true) return false;
    return !(n(H['116']) === 0 && n(H['115']) > 30);
}
// one log line when an idle period starts (after IDLE_LOG_AFTER_MS) and one when the compressor runs again; no repeats per tick
function idleTick() {
    const s = context.get('idle') || { since: 0, logged: false, first: null, last: null, tickAt: 0 };
    // a restart / deploy left a hole: the period before it is not continued
    if (s.since && now - s.tickAt > 2 * MIN) { s.since = 0; s.logged = false; s.first = null; s.last = null; }
    s.tickAt = now;
    const wasOpen = !!s.since;
    const stale = wasOpen && !ready('hp');
    if (idleNow() || stale) {
        const c = idleCause();
        if (!s.since) { s.since = now; s.first = c; }
        s.last = c;
        if (!s.logged && now - s.since >= IDLE_LOG_AFTER_MS) {
            s.logged = true;
            logEvent({ kind: 'info', rule: 'hp_idle', cloud: 'Heat pump idle', text: 'Idle: ' + c.text + ' (' + c.detail + ')' });
        }
    } else if (s.since) {
        if (s.logged) {
            const H = (st.hp && st.hp.dps) || {};
            const run = ready('hp') && n(H['115']) > 0;
            const mins = Math.max(1, Math.round((now - s.since) / MIN));
            const f = s.first, l = s.last;
            logEvent({ kind: 'info', rule: 'hp_idle', cloud: 'Heat pump idle', text: (run ? 'running again after ' + mins + ' min' : 'idle ended after ' + mins + ' min (DHW cycle / defrost started)')
                + ' (reason was ' + f.text + (l && l.code !== f.code ? ', last: ' + l.text : '') + ')' });
        }
        s.since = 0; s.logged = false; s.first = null; s.last = null;
    }
    context.set('idle', s);
}
// what the page and the recorder show: the same cause text as the log
function idleView() {
    const s = context.get('idle') || {};
    if (!s.since) return { active: false, code: 0, text: '', since: 0 };
    const c = s.last || s.first;
    return { active: true, code: c.code, key: c.key, text: c.text, detail: c.detail, since: s.since };
}
