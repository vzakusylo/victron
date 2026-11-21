//! lib/heat-pump/heating-tick.js: warm-up boost, status line and the heating power controller tick (heatTick).
//! Included into "40 Heat pump automations.js" by `// #include` (tools/includes.js); it runs in that
//! function node's scope, not as a module. Lines starting with //! are not embedded in flows.json.
// ---- warm-up boost (P3) ------------------------------------------------------------
// The operator raises the followed heating point by deltaC for a while; the owner's curve comes back by itself.
const WARM_DEFAULTS = { deltaC: 2, hours: 1 };
const WARM_LIMITS = { deltaC: [0.5, 5], hours: [0.5, 6] };
function warmCfg(raw) {
    if (!raw || !Number.isFinite(raw.at) || !Number.isFinite(raw.until) || !Number.isFinite(raw.deltaC)) return null;
    if (raw.deltaC < WARM_LIMITS.deltaC[0] || raw.deltaC > WARM_LIMITS.deltaC[1]) return null;
    if (raw.until <= raw.at || raw.until - raw.at > WARM_LIMITS.hours[1] * 3600 * 1000) return null;
    return { at: raw.at, until: raw.until, deltaC: raw.deltaC };
}
function warmDelta() {
    const w = settings.heatWarm;
    if (!w) return 0;
    if (w.until <= now) {
        settings.heatWarm = null; saveSettingsFile();
        logEvent({ kind: 'setting', rule: HEAT_ID, cloud: HEAT_NAME, text: 'warm-up ended: following your heating curve again' });
        return 0;
    }
    return w.deltaC;
}
// ---- heating power controller tick (d#166) ----------------------------------------
function heatState() { return ctx('heat', { samples: [], boost: 0, p23At: 0, target: null, lastStep: 0, modeCmd: null, modeAt: 0, why: '', decision: '', lag: null, gap: null, run: null }); }
function heatModel() {
    const h = heatState(), c = (context.get('settings') || settings).heat || heatCfg({});
    const H = (st.hp && st.hp.dps) || {};
    return { mode: modeOf(HEAT_ID), cfg: c, lag: h.lag, gap: h.gap, why: h.why, decision: h.decision, lastStep: h.lastStep,
        kick: (() => { const k = context.get('kick') || {}; return { phase: k.phase || null, last: k.last || 0, why: k.why || '' }; })(),
        warm: (() => { const w = settings.heatWarm; return w && w.until > now ? { active: true, at: w.at, until: w.until, deltaC: w.deltaC, applied: h.warmApplied || 0, note: h.warmNote || '' }
            : { active: false, deltaC: WARM_DEFAULTS.deltaC, hours: WARM_DEFAULTS.hours, limits: WARM_LIMITS }; })(),
        pumpMode: MODE_NAME[H['2']] || H['2'] || null, outSrc: h.outSrc || null, boost: h.boost || 0, target: h.target === undefined ? null : h.target, nextStepAt: h.lastStep ? h.lastStep + c.stepMin * MIN : 0,
        offCurve: { warned: !!h.offWarned, since: h.offSince || 0, today: h.offDay && h.offDay.day === new Date(now).toISOString().slice(0, 10) ? h.offDay.n : 0,
            limitC: +(c.bandDown + c.offCurveC).toFixed(1), min: c.offCurveMin }, blocked: h.blockWhy ? h.why : '' };
}
// task 5: the one status line of the Heat Pump page — DHW / defrost / heating / idle with the reason
function statusLine() {
    const d = context.get('dhw') || {}, h = heatState();
    const H = (st.hp && st.hp.dps) || {}, V = (st.valve && st.valve.dps) || {};
    const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
    const c = (context.get('settings') || settings).heat || heatCfg({});
    const dm = dhwModel();
    if (!ready('hp')) return { kind: 'idle', text: 'Idle: heat pump not connected / data stale', since: 0 };
    const defNow = n(H['116']) === 0 && n(H['115']) > 30;
    if (defNow || d.state === 'DEFROST_DHW') {
        const since = context.get('defrostSince') || 0;
        return { kind: 'defrost', text: 'Defrost' + (since ? ' since ' + hhmm(since) : ''), since };
    }
    if (d.state && d.state !== 'HEATING') {
        const tank = n(H['108']);
        return { kind: 'dhw', text: 'DHW heating (tank ' + (Number.isFinite(tank) ? tank : '?') + ' → ' + (dm.target === null ? '?' : dm.target) + ' °C, since ' + hhmm(d.startAt || d.since) + ')', since: d.startAt || d.since };
    }
    if (H['1'] === true && n(H['115']) > 0 && V['1'] !== true) {
        const sup = n(H['102']);
        return { kind: 'heating', since: 0, text: 'Heating (' + (MODE_NAME[H['2']] || H['2'] || '?') + ', point ' + (h.target === null || h.target === undefined ? '?' : h.target)
            + ' °C, supply ' + (Number.isFinite(sup) ? sup : '?') + ' °C, band −' + c.bandDown + '/+' + c.bandUp + ' °C, boost +' + (h.boost || 0) + ' °C)'
            + (h.offWarned ? ' — NOT following the curve since ' + hhmm(h.offSince) : '') };
    }
    let reason = H['1'] !== true ? 'heat pump off' : d.why && d.why !== 'start conditions met' ? d.why : h.why || 'compressor stopped';
    if (reason.length > 90) reason = reason.slice(0, 89).trimEnd() + '…';
    return { kind: 'idle', text: 'Idle: ' + reason, since: 0 };
}
function publishView() { flow.set('dhwView', Object.assign(dhwModel(), { at: now, master: settings.master, heat: heatModel(), pumpOut: pumpOutNow(), status: statusLine() })); }
function heatTick() {
    const h = heatState(), c = settings.heat || heatCfg({});
    const md = modeOf(HEAT_ID);
    const H = (st.hp && st.hp.dps) || {}, V = (st.valve && st.valve.dps) || {}, B = (st.bypass && st.bypass.dps) || {};
    const d = context.get('dhw') || {};
    const hold = [];
    if (md === 'off') hold.push('controller Off');
    if (!(ready('hp') && ready('valve') && ready('bypass'))) hold.push('device not connected / stale');
    if (d.state && d.state !== 'HEATING') hold.push('DHW cycle running');
    else if (now - dhwLastEnd(d) < HEAT_WINDOW_MIN * MIN) hold.push('DHW cycle ended < ' + HEAT_WINDOW_MIN + ' min ago');
    if (V['1'] === true) hold.push('valve on DHW');
    if (H['1'] !== true) hold.push('heat pump off');
    if (!HEAT_LADDER.includes(H['2'])) hold.push('pump mode ' + H['2'] + ' unknown');
    // controller not On (Off or Test) → the owner's curve back now; a boost or warm-up only exists while it is On
    // (local control OFF: nothing can be written, the boost and its bookkeeping stay)
    const ownerCurveBack = () => {
        const hc0 = settings.heatCurve;
        if (!(h.boost || h.warmApplied) || !hc0 || md === 'live' || !settings.master || !ready('hp')) return;
        const q = context.get('queue') || [];
        for (const w of [p24w(hc0.p24), p23w(hc0.p23)]) {
            q.push({ rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, role: w.role, dps: w.dps, set: w.set, text: w.text, force: true });
            logEvent({ kind: 'write', rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, live: true, text: 'controller ' + MODE_LABEL[md] + ' → curve boost / warm-up off, ' + w.text });
        }
        context.set('queue', q);
        pump();
        h.boost = 0; h.warmApplied = 0; h.curveCmd = null;
    };
    // P6: controller not On (Off or Test) → the owner's heating hysteresis back; the band only exists while it is On
    const ownerBandBack = () => {
        if (md === 'live' || !settings.master || !ready('hp') || !Number.isFinite(settings.heatBandSaved)) return;
        const hy = H['121'] === null || H['121'] === undefined || H['121'] === '' ? NaN : Number(H['121']);
        if (Number.isFinite(hy) && hy !== settings.heatBandSaved && !(h.hystAt && now - h.hystAt < 2 * MIN)) {
            const w = hystw(settings.heatBandSaved);
            const q = context.get('queue') || [];
            q.push({ rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, role: w.role, dps: w.dps, set: w.set, text: w.text, force: true });
            context.set('queue', q);
            logEvent({ kind: 'write', rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, live: true, text: 'controller ' + MODE_LABEL[md] + ' → band off, ' + w.text });
            pump();
            h.hystAt = now;
        } else if (hy === settings.heatBandSaved) { settings.heatBandSaved = null; saveSettingsFile(); }
    };
    if (hold.length) {
        // d#171: a curve boost ends with the hold: a DHW cycle writes the owner's curve back at its end itself;
        // controller Off (or not On) → the owner's P23 back now
        // d#177 (review of #21): other holds (pump off, stale, valve, unknown mode) keep the boost and its bookkeeping, so the
        // boosted P23 / P24 is never stored as the owner's curve
        const dhwRun = !!(d.state && d.state !== 'HEATING');
        if (dhwRun) { h.boost = 0; h.warmApplied = 0; }   // the DHW cycle writes the owner's curve back at its end
        else ownerCurveBack();
        ownerBandBack();
        h.samples = []; h.lag = null; h.gap = null; h.why = 'waiting: ' + hold.join('; ');
        h.offSince = 0; h.offWarned = false; h.blockWhy = '';   // P1 / P2: a hold (DHW, pump off, Off) is not "not following"
        context.set('heat', h); return;
    }
    // Test mode adds no hold: On → Test must still put the owner's curve and hysteresis back (PR #65 / #66 review)
    ownerCurveBack();
    ownerBandBack();
    // d#170: a defrost (bypass ON, compressor stop, supply drop) and the recovery after it are ignored: no samples,
    // no step, and the samples from before the defrost are kept, so the window continues after it
    const defNowH = n(H['116']) === 0 && n(H['115']) > 30;
    if (defNowH || recentDefrost || defRecovering || B['1'] === true || !(n(H['115']) > 0)) {
        h.why = 'ignored: ' + (defNowH ? 'defrost now' : recentDefrost ? 'defrost < ' + DEFROST_QUIET_MIN + ' min ago'
            : defRecovering ? 'supply recovering after the defrost' : B['1'] === true ? 'bypass ON' : 'compressor stopped')
            + (h.samples.length ? ' (keeps ' + h.samples.length + ' samples from before)' : '');
        h.paused = h.paused || now;
        context.set('heat', h); return;
    }
    // d#177: while a stuck-supply kick holds Smart the controller does not decide (Smart is not its own step)
    const kk = context.get('kick');
    if (kk && kk.phase === 'smart') { h.why = 'stuck-supply kick running (Smart for a moment)'; context.set('heat', h); return; }
    // shift the kept samples over the pause, so the 10-min window counts only time outside defrosts
    if (h.paused) { const p = now - h.paused; h.samples = h.samples.map((x) => [x[0] + p, x[1], x[2], x[3]]); h.paused = 0; }
    const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));   // Number(null) is 0
    const sup = num(H['102']), ret = num(H['101']), amp = num(H['112']), P23 = num(H['133']);
    // d#171: the point to follow is the owner's heating curve (settings.heatCurve at the 10-min outdoor average),
    // not DP 125, which rises with the curve boost; without a stored curve DP 125
    const hc = settings.heatCurve;
    // d#195: ... at the outdoor value the pump itself computes its curve from (fallback: the 10-min sensor average)
    const po = pumpOutNow();
    const xh = po ? po.v : d.outAvg;
    h.outSrc = po ? 'pump' : 'sensor';
    const base = hc && Number.isFinite(xh) ? +heatCurveAt(hc.p23, hc.p24, xh).toFixed(1) : num(H['125']);
    // P3: a warm-up raises the followed point; it needs the owner's curve to write a raised one
    const wd = hc && Number.isFinite(xh) ? warmDelta() : 0;
    const set = Number.isFinite(base) ? +(base + wd).toFixed(1) : base;
    h.target = Number.isFinite(set) ? set : null;
    // P6: with the pump band option on, the pump is set to point + up with hysteresis up + down; the offset written includes up
    const bandOn = !!(c.band && hc && Number.isFinite(xh) && md === 'live' && settings.master);
    const bandHyst = bandHystOf(c);
    const off = wd + (bandOn ? c.bandUp : 0);
    // boost bookkeeping: the pump shows the owner's curve again (DHW end, slider) → boost 0
    // (or any other curve than the one written: the owner moved the slider, a DHW cycle wrote its own)
    if ((h.boost || h.warmApplied) && !(h.p23At && now - h.p23At < 2 * MIN) && !(h.curveCmd && P23 === h.curveCmd.p23 && num(H['134']) === h.curveCmd.p24)) { h.boost = 0; h.warmApplied = 0; h.curveCmd = null; }
    if ([sup, ret, set].every(Number.isFinite)) h.samples.push([now, sup - set, sup - ret, Number.isFinite(amp) ? amp : null]);
    h.samples = h.samples.filter((x) => now - x[0] <= HEAT_WINDOW_MIN * MIN);
    const full = h.samples.length >= 20 && now - h.samples[0][0] >= (HEAT_WINDOW_MIN - 1) * MIN;
    const avg = (i) => Math.round(h.samples.reduce((a, x) => a + x[i], 0) / h.samples.length * 10) / 10;
    h.lag = h.samples.length ? avg(1) : null; h.gap = h.samples.length ? avg(2) : null;
    // P2: not following the curve — the full 10-min average stays more than bandDown + offCurveC below the point
    if (full) {
        const offLim = +(c.bandDown + c.offCurveC).toFixed(1);
        const day = new Date(now).toISOString().slice(0, 10);
        if (!h.offDay || h.offDay.day !== day) h.offDay = { day, n: 0 };
        if (h.lag < -offLim) {
            if (!h.offSince) h.offSince = now;
            if (!h.offWarned && now - h.offSince >= c.offCurveMin * MIN) {
                h.offWarned = true; h.offDay.n += 1;
                logEvent({ kind: 'warn', rule: HEAT_ID, cloud: HEAT_NAME, live: true, text: 'not following the curve for ' + c.offCurveMin + ' min: point ' + h.target
                    + ' °C, supply ' + sup + ' °C (avg ' + h.lag + ' °C, limit −' + offLim + '), mode ' + (MODE_NAME[H['2']] || H['2']) + ', boost +' + (h.boost || 0) + ' °C' + (h.why ? ', last: ' + h.why : '') });
            }
        } else if (h.lag >= -c.bandDown) {
            if (h.offWarned) logEvent({ kind: 'info', rule: HEAT_ID, cloud: HEAT_NAME, live: true, text: 'following the curve again after ' + Math.round((now - h.offSince) / MIN) + ' min (supply avg ' + (h.lag >= 0 ? '+' : '') + h.lag + ' °C)' });
            h.offSince = 0; h.offWarned = false;
        }
    }
    const amps = h.samples.map((x) => x[3]).filter((x) => x !== null);
    const cur = HEAT_LADDER.indexOf(H['2']);
    const a = { lag: full ? h.lag : null, amp: amps.length ? Math.max(...amps.slice(-6)) : null, cur, boost: h.boost || 0 };
    const dec = heatDecide(c, a);
    h.decStep = dec.step;   // d#175: the kick waits while the controller itself wants to step
    const top = c.allowPowerful ? 2 : 1;
    const boost = h.boost || 0;
    // d#171 / d#172: two levers. Up: power mode first, then the curve: +1 °C of the curve's set point per step above
    // the owner's curve (up to maxBoost °C), through its coefficients — P23 first, P24 (slope) once P23 is at 40.
    // Down: the curve boost first, then the mode. Powerful while it is not allowed → down at once.
    let steps = null, act = '', nb = boost;
    const curveSteps = (b) => {
        const total = off + b;   // warm-up + band offset + controller boost, all above the owner's curve
        const cc = total > 0 ? curveCoeffs(base + total, xh, hc.p24) : { p23: hc.p23, p24: hc.p24 };
        const out = [];
        if (cc.p24 !== num(H['134'])) out.push(p24w(cc.p24));
        if (cc.p23 !== P23) out.push(p23w(cc.p23));
        return { cc, out };
    };
    // P3: a new or ended warm-up is written at once (not after the 10-min step); the controller then works on top of it
    // (h.warmApplied is the whole offset written above the owner's curve: warm-up + band up)
    if (hc && Number.isFinite(base) && Number.isFinite(xh) && off !== (h.warmApplied || 0) && md === 'live' && settings.master) {
        const cs = curveSteps(boost);
        const parts = [wd ? 'warm-up +' + wd + ' °C' : '', bandOn ? 'band +' + c.bandUp + ' / −' + c.bandDown + ' °C' : ''].filter(Boolean);
        const act = (parts.length ? parts.join(', ') : 'offset over, curve back to ' + (boost ? 'boost +' + boost : 'yours')) + ' (P23 ' + cs.cc.p23 + ' / P24 ' + cs.cc.p24 + ')';
        h.run = now + ':' + HEAT_ID + ':warm'; h.warmApplied = off; h.p23At = now; h.curveCmd = off + boost > 0 ? cs.cc : null;
        h.samples = []; h.why = act;
        if (cs.out.length) {
            const q = context.get('queue') || [];
            for (const s of cs.out) {
                q.push({ rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, role: s.role, dps: s.dps, set: s.set, text: s.text });
                logEvent({ kind: 'write', rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, live: true, text: act + ': ' + s.text });
            }
            context.set('queue', q);
            pump();
        }
        context.set('heat', h); return;
    }
    // P6: the pump's heating hysteresis follows the band; the owner's own value is saved once and written back
    const hyst = num(H['121']);
    const wantHyst = bandOn ? bandHyst : (Number.isFinite(settings.heatBandSaved) ? settings.heatBandSaved : null);
    if (md === 'live' && settings.master && wantHyst !== null && Number.isFinite(hyst) && hyst !== wantHyst
        && !(h.hystAt && now - h.hystAt < 2 * MIN)) {
        if (bandOn && !Number.isFinite(settings.heatBandSaved)) settings.heatBandSaved = hyst;
        if (!bandOn) settings.heatBandSaved = null;
        saveSettingsFile();
        const w = hystw(wantHyst);
        h.run = now + ':' + HEAT_ID + ':band'; h.hystAt = now;
        h.why = (bandOn ? 'band: compressor restarts ' + bandHyst + ' °C below its stop point' : 'band off: your heating hysteresis back') + ' → ' + w.text;
        const q = context.get('queue') || [];
        q.push({ rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, role: w.role, dps: w.dps, set: w.set, text: w.text });
        context.set('queue', q);
        logEvent({ kind: 'write', rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, live: true, text: h.why });
        pump();
        context.set('heat', h); return;
    }
    if (!bandOn && Number.isFinite(settings.heatBandSaved) && hyst === settings.heatBandSaved) { settings.heatBandSaved = null; saveSettingsFile(); }
    h.warmNote = wd && !(md === 'live' && settings.master) ? 'warm-up needs the heating controller On and local control ON' : '';
    if (settings.heatWarm && settings.heatWarm.until > now && !wd) h.warmNote = !hc ? 'warm-up waits: your heating curve is not stored yet' : 'warm-up waits: no outdoor average yet';
    if (cur > top) { steps = [mode(HEAT_LADDER[top])]; act = MODE_NAME[HEAT_LADDER[top]]; }
    else if (dec.step > 0 && cur < top) { steps = [mode(HEAT_LADDER[cur + 1])]; act = MODE_NAME[HEAT_LADDER[cur + 1]]; }
    else if (dec.step > 0 && hc && Number.isFinite(set) && Number.isFinite(xh) && boost < c.maxBoost) {
        nb = Math.min(c.maxBoost, boost + 1);
        const cs = curveSteps(nb);
        if (cs.out.length) { steps = cs.out; act = 'curve +' + nb + ' °C (P23 ' + cs.cc.p23 + ' / P24 ' + cs.cc.p24 + ')'; }
    }
    else if (dec.step < 0 && boost > 0 && hc && Number.isFinite(set) && Number.isFinite(xh)) {
        nb = Math.max(0, boost - 1);
        const cs = curveSteps(nb);
        steps = cs.out.length ? cs.out : null; act = nb ? 'curve +' + nb + ' °C (P23 ' + cs.cc.p23 + ' / P24 ' + cs.cc.p24 + ')' : wd ? 'curve back to warm-up +' + wd + ' °C (P23 ' + cs.cc.p23 + ' / P24 ' + cs.cc.p24 + ')' : 'curve back to yours (P23 ' + hc.p23 + ' / P24 ' + hc.p24 + ')';
        if (!steps) h.boost = nb;
    }
    else if (dec.step < 0 && cur > 0) { steps = [mode(HEAT_LADDER[cur - 1])]; act = MODE_NAME[HEAT_LADDER[cur - 1]]; }
    h.decision = dec.why;
    // P1: the pump left the mode the controller set (cloud scene, DHW end, a hand on the app) → step again without the wait
    const reverted = !!(h.modeCmd && h.modeCmd !== H['2'] && now - (h.modeAt || 0) >= 2 * MIN && HEAT_LADDER.indexOf(h.modeCmd) > cur && cur < top && dec.step > 0);
    const early = h.lastStep && now - h.lastStep < c.stepMin * MIN && !reverted;
    // P1: a wanted step up that cannot be made is logged once with its reason (no silent "stuck in Silent")
    const blockWhy = dec.blocked ? dec.why
        : dec.step > 0 && !steps ? dec.why + ': no step up — already ' + MODE_NAME[H['2']] + (c.allowPowerful ? '' : ' (Powerful not allowed)')
            + (boost ? ', curve +' + boost + ' °C' : '') + (boost >= c.maxBoost ? ' (boost cap +' + c.maxBoost + ' °C)' : !hc ? ' (your curve is not stored yet)' : !Number.isFinite(xh) ? ' (no outdoor value)' : '')
            : '';
    if (blockWhy && h.blockWhy !== blockWhy.replace(/[-+]?\d+(\.\d+)?/g, '#')) logEvent({ kind: 'warn', rule: HEAT_ID, cloud: HEAT_NAME, live: true, text: 'step up blocked: ' + blockWhy });
    h.blockWhy = blockWhy ? blockWhy.replace(/[-+]?\d+(\.\d+)?/g, '#') : '';
    if (reverted) logEvent({ kind: 'info', rule: HEAT_ID, cloud: HEAT_NAME, live: true, text: 'pump mode is ' + (MODE_NAME[H['2']] || H['2']) + ', the controller set ' + MODE_NAME[h.modeCmd] + ' → step again now' });
    if (!steps) { h.why = dec.why + (dec.step ? ' (already ' + MODE_NAME[H['2']] + (boost ? ', curve +' + boost + ' °C' : '') + ' — limit)' : ''); context.set('heat', h); return; }
    if (early && cur <= top) { h.why = dec.why + ' → ' + act + ' after ' + new Date(h.lastStep + c.stepMin * MIN).toTimeString().slice(0, 5); context.set('heat', h); return; }
    if (steps[0].dps === 2 && h.modeCmd === steps[0].set && now - h.modeAt < MIN) { context.set('heat', h); return; }
    const live = md === 'live' && settings.master;
    h.run = now + ':' + HEAT_ID; h.lastStep = now;
    if (steps[0].dps === 2) { h.modeCmd = steps[0].set; h.modeAt = now; }
    else { h.boost = nb; h.p23At = now; h.curveCmd = wd + nb > 0 ? curveSteps(nb).cc : null; }   // the warm-up stays written after a boost step-down
    h.samples = [];   // the next decision only sees the new mode / curve
    h.why = dec.why + ' → ' + act;
    for (const s of steps) {
        if (live) {
            const q = context.get('queue') || [];
            q.push({ rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, role: s.role, dps: s.dps, set: s.set, text: s.text });
            context.set('queue', q);
            logEvent({ kind: 'write', rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, live: true, text: dec.why + ' → ' + act + ': ' + s.text });
            pump();
        } else {
            logEvent({ kind: 'dry', rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, live: false, text: dec.why + ' → would ' + s.text });
        }
    }
    context.set('heat', h);
}
