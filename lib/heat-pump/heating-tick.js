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
// With a fixed slope, a P23 shift bounds the target rise at every outdoor temperature, even across the 20/60 °C clamps.
function heatingP23Limit(owner, cap = HEAT_DEFAULTS.maxCurveOffset) {
    return Math.max(owner.p23, Math.min(P23_MAX, Math.floor(owner.p23 + cap * 10 / owner.p24 + 1e-9)));
}
function heatingP23(owner, offset, limit) {
    return offset > 0 ? Math.min(limit, Math.ceil(owner.p23 + offset * 10 / owner.p24 - 1e-9)) : owner.p23;
}
function recordHeatModeStep(item, at) {
    const h = heatState();
    Object.assign(h, { run: item.run, lastStep: at, modeAt: at, modeCmd: item.set, samples: [] });
    context.set('heat', h);
}
function recordHeatCurve(item, at) {
    const h = heatState();
    const { step, gentleStep, requestedBoost, ...change } = item.curveChange;
    Object.assign(h, change, { run: item.run, p23At: at, samples: [], curvePartial: false });
    if (step) h.lastStep = at;
    if (gentleStep) h.gentleAt = at;
    context.set('heat', h);
}
function heatModel() {
    const h = heatState(), c = (context.get('settings') || settings).heat || heatCfg({});
    const H = (st.hp && st.hp.dps) || {};
    return { mode: modeOf(HEAT_ID), cfg: c, lag: h.lag, gap: h.gap, why: h.why, decision: h.decision, lastStep: h.lastStep,
        kick: (() => { const k = context.get('kick') || {}; return { phase: k.phase || null, last: k.last || 0, why: k.why || '' }; })(),
        warm: (() => { const w = settings.heatWarm; return w && w.until > now ? { active: true, at: w.at, until: w.until, deltaC: w.deltaC, applied: h.warmApplied || 0, note: h.warmNote || '' }
            : { active: false, deltaC: WARM_DEFAULTS.deltaC, hours: WARM_DEFAULTS.hours, limits: WARM_LIMITS }; })(),
        pumpMode: MODE_NAME[H['2']] || H['2'] || null, boost: h.boost || 0, target: h.target === undefined ? null : h.target, nextStepAt: h.lastStep ? h.lastStep + c.stepMin * MIN : 0,
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
    const defNow = defrostReading(H) === true;
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
            + (h.atCapacity && Number.isFinite(h.target) && (sup < h.target || h.offsetDeferred) ? ' — ' + HEAT_CAPACITY_TEXT
                : h.offWarned ? ' — NOT following the curve since ' + hhmm(h.offSince) : '') };
    }
    // d#206: the same cause text as the log line and the history (idleCause, lib/heat-pump/idle.js)
    let reason = n(H['115']) > 0 && H['1'] === true ? h.why || 'compressor running' : idleCause().text;
    if (reason.length > 90) reason = reason.slice(0, 89).trimEnd() + '…';
    return { kind: 'idle', text: 'Idle: ' + reason, since: 0 };
}
function publishView() { flow.set('dhwView', Object.assign(dhwModel(), { at: now, outHeld: !!(context.get('dhw') || {}).outHeld, master: settings.master, heat: heatModel(),
    pause: pauseModel(), pauseStandby: !!settings.pauseStandby, recentCurveChanges: hpCurveLog.recent(5),
    ownerCurvePending: !!context.get('ownerCurveRequest'), ownerCurveResult: context.get('ownerCurveResult') || null, status: statusLine(), idle: idleView() })); }
function heatTick() {
    const h = heatState(), c = settings.heat || heatCfg({});
    const md = modeOf(HEAT_ID);
    const H = (st.hp && st.hp.dps) || {}, V = (st.valve && st.valve.dps) || {}, B = (st.bypass && st.bypass.dps) || {};
    const d = context.get('dhw') || {};
    const P23 = dhwMeasurement(H['133']), P24 = dhwMeasurement(H['134']);
    const prevSupply = h.supplyAt >= now - MIN ? h.supply : null;
    h.supply = null; h.atCapacity = false; h.offsetDeferred = false;
    const hold = [];
    if (md === 'off') hold.push('controller Off');
    if (!(ready('hp') && ready('valve') && ready('bypass'))) hold.push('device not connected / stale');
    if (d.state && d.state !== 'HEATING') hold.push('DHW cycle running');
    else if (now - dhwLastEnd(d) < HEAT_WINDOW_MIN * MIN) hold.push('DHW cycle ended < ' + HEAT_WINDOW_MIN + ' min ago');
    if (V['1'] === true) hold.push('valve on DHW');
    if (H['1'] !== true) hold.push('heat pump off');
    if (!HEAT_LADDER.includes(H['2'])) hold.push('pump mode ' + H['2'] + ' unknown');
    const defNowH = defrostReading(H) === true;
    const curveHeld = defNowH || recentDefrost || defRecovering || restartSettling || V['1'] !== false || B['1'] !== false ||
        !!context.get('ownerCurveRequest');
    if (pauseCurveTick(d, h, H, !curveHeld && ready('hp') && ready('valve') && ready('bypass') && H['1'] === true)) {
        h.why = pauseHolding() ? 'owner pause: standby once the heating circuit is safe' : 'restoring the heating curve after pause';
        context.set('heat', h); return;
    }
    const pendingHeatCurve = () => (context.get('queue') || []).find(item => item.commitCurve && !writeLeaseProblem(item, now));
    const queueHeatCurve = (steps, run, curveChange, describe, force = false) => {
        const pending = pendingHeatCurve();
        if (pending && JSON.stringify(pending.curveChange) === JSON.stringify(curveChange)) return true;
        const owner = settings.heatCurve;
        const boost = curveChange.boost ?? h.boost ?? 0;
        const warmUp = curveChange.warmDeltaApplied ?? h.warmDeltaApplied ?? 0;
        const bandOffset = Math.max(0, (curveChange.warmApplied ?? h.warmApplied ?? 0) - warmUp);
        const rawOffset = force ? 0 : warmDelta() + (c.band ? c.bandUp : 0) + (curveChange.requestedBoost ?? boost);
        const curveParts = { owner: owner ? { p23: owner.p23, p24: owner.p24 } : null,
            boost, warmUp, bandOffset, capApplied: !!owner && Math.ceil(owner.p23 + rawOffset * 10 / owner.p24 - 1e-9) >
                heatingP23Limit(owner, c.maxCurveOffset), outdoorAverage: d.outAvg ?? null,
            dhw: d.state ?? null, defrost: defNowH, reason: describe };
        const spec = { rule: HEAT_ID, cloud: HEAT_NAME, run, curveChange, force, curveParts,
            ...(force && { curveWriter: 'restore' }) };
        if (steps.length) return enqueueCurveGroup(steps, spec, 'heat', now, w => describe + ': ' + w.text);
        if (pending) cancelWriteLease('curve', lease => lease.generation === pending.modeGeneration);
        recordHeatCurve(spec, now);
        return true;
    };
    // controller not On (Off or Test) → the owner's curve back now; a boost or warm-up only exists while it is On
    // (local control OFF: nothing can be written, the boost and its bookkeeping stay)
    const ownerCurveBack = () => {
        const hc0 = settings.heatCurve;
        if (!(h.boost || h.warmApplied || h.curvePartial) || !hc0 || md === 'live' || !settings.master ||
            !ready('hp') || curveHeld || !validHeatCurve(P23, P24)) return;
        const writes = [];
        if (P24 > hc0.p24) writes.push(p24w(hc0.p24));
        if (P23 !== hc0.p23 && (P24 === hc0.p24 || P23 > hc0.p23)) writes.push(p23w(hc0.p23));
        queueHeatCurve(writes, now + ':' + HEAT_ID + ':restore',
            { boost: 0, warmApplied: 0, warmDeltaApplied: 0, curveCmd: null },
            'controller ' + MODE_LABEL[md] + ' → curve boost / warm-up off', true);
    };
    const queueBand = (w, run, force, text, originalHyst) => {
        const q = context.get('queue') || [];
        if (q.some(item => item.rule === HEAT_ID && item.dps === 121 && item.set === w.set && !writeLeaseProblem(item, now))) return false;
        const item = tagWrite({ rule: HEAT_ID, cloud: HEAT_NAME, run, ...w, force, originalHyst }, 'heat', now);
        if (item.writeRejection) { h.why = 'heating band held by a higher writer'; return false; }
        q.push(item);
        context.set('queue', q);
        logEvent({ kind: 'write', rule: HEAT_ID, cloud: HEAT_NAME, run, live: true, text });
        return true;
    };
    // P6: controller not On (Off or Test) → the owner's heating hysteresis back; the band only exists while it is On
    const ownerBandBack = () => {
        if (md === 'live' || !settings.master || !ready('hp') || !Number.isFinite(settings.heatBandSaved)) return;
        const hy = H['121'] === null || H['121'] === undefined || H['121'] === '' ? NaN : Number(H['121']);
        if (Number.isFinite(hy) && hy !== settings.heatBandSaved && !(h.hystAt && now - h.hystAt < 2 * MIN)) {
            const w = hystw(settings.heatBandSaved);
            if (queueBand(w, h.run, true, 'controller ' + MODE_LABEL[md] + ' → band off, ' + w.text)) pump();
        } else if (hy === settings.heatBandSaved) { settings.heatBandSaved = null; saveSettingsFile(); }
    };
    if (hold.length) {
        h.gentleHotSince = null;
        // d#171: a curve boost ends with the hold: a DHW cycle writes the owner's curve back at its end itself;
        // controller Off (or not On) → the owner's P23 back now
        // d#177 (review of #21): other holds (pump off, stale, valve, unknown mode) keep the boost and its bookkeeping, so the
        // boosted P23 / P24 is never stored as the owner's curve
        const dhwRun = !!(d.state && d.state !== 'HEATING');
        if (dhwRun) { h.boost = 0; h.warmApplied = 0; h.curveCmd = null; h.curveSynced = false; }
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
    if (defNowH || recentDefrost || defRecovering || restartSettling || B['1'] === true || !(n(H['115']) > 0)) {
        h.gentleHotSince = null;
        h.why = 'ignored: ' + (defNowH ? 'defrost now' : recentDefrost ? 'defrost < ' + DEFROST_QUIET_MIN + ' min ago'
            : restartSettling ? 'settling after restart'
            : B['1'] === true ? 'bypass ON' : defRecovering ? 'supply recovering after the defrost' : 'compressor stopped')
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
    const sup = num(H['102']), ret = num(H['101']), amp = num(H['112']);
    const hc = settings.heatCurve;
    const xh = d.outAvg;
    const savedWarm = settings.heatWarm?.deltaC || 0;
    const requestedWarm = warmDelta();
    const noPoint = !hc ? 'your heating curve is not stored yet' : !Number.isFinite(xh) ? 'no outdoor average yet' : '';
    if (noPoint) {
        h.samples = [];
        h.offSince = 0; h.offWarned = false; h.blockWhy = '';
    }
    // At max frequency, require a recent falling supply reading before increasing demand.
    h.supply = Number.isFinite(sup) ? sup : null; h.supplyAt = now;
    const atCapacity = h.atCapacity = n(H['115']) >= HEAT_CAPACITY_HZ && h.supply !== null && (prevSupply == null || sup >= prevSupply);
    const base = noPoint ? null : heatCurveAt(hc.p23, hc.p24, xh);
    const bandOn = !noPoint && c.band && md === 'live' && settings.master;
    const bandUp = bandOn ? c.bandUp : 0;
    const limitP23 = hc ? heatingP23Limit(hc, c.maxCurveOffset) : null;
    const ceiling = hc ? +((limitP23 - hc.p23) * hc.p24 / 10).toFixed(8) : 0;
    const applicable = !noPoint && !curveHeld && validHeatCurve(P23, P24);
    const live = md === 'live' && settings.master;
    const pending = pendingHeatCurve();
    const expectedCurve = h.curveCmd || hc;
    const waitingForCurve = !!(pending || (h.p23At && now - h.p23At < 2 * MIN && expectedCurve &&
        (P23 !== expectedCurve.p23 || P24 !== expectedCurve.p24)));
    if (applicable && !h.curveSynced && live && !waitingForCurve) {
        // The pump keeps its coefficients across a restart. Count the already applied uplift before another step.
        const observed = Math.min(ceiling, +((Math.max(0, P23 - hc.p23) * hc.p24) / 10).toFixed(8));
        const sameCommand = h.curveCmd?.p23 === P23 && h.curveCmd?.p24 === P24;
        const currentWarm = Math.min(observed, Math.max(savedWarm, sameCommand ? h.warmDeltaApplied || 0 : 0));
        const currentOff = Math.min(observed, Math.max(currentWarm + bandUp, sameCommand ? h.warmApplied || 0 : 0));
        h.warmDeltaApplied = currentWarm;
        h.warmApplied = currentOff;
        h.boost = Math.min(c.maxBoost, +(observed - currentOff).toFixed(8));
        h.curveReplan = observed - currentOff > h.boost + 1e-9;
        h.curveCmd = observed > 0 && P24 === hc.p24 ? { p23: P23, p24: P24 } : null;
        h.curveSynced = true;
    } else if (applicable && h.curveCmd && !waitingForCurve && (P23 !== h.curveCmd.p23 || P24 !== h.curveCmd.p24)) {
        h.boost = 0; h.warmApplied = 0; h.warmDeltaApplied = 0; h.curveCmd = null;
    }
    // Keep existing offsets at capacity, but allow cancellation/expiry and reductions.
    const applied = h.warmApplied || 0;
    const appliedWarm = Math.min(applied, h.warmDeltaApplied || 0);
    const cappedWarm = Math.min(requestedWarm, ceiling);
    const wd = atCapacity ? Math.min(cappedWarm, appliedWarm) : cappedWarm;
    const bandHyst = bandHystOf(c);
    const wantHyst = bandOn ? (atCapacity ? null : bandHyst)
        : !c.band && Number.isFinite(settings.heatBandSaved) ? settings.heatBandSaved : null;
    const pendingBand = (context.get('queue') || []).find(item => item.rule === HEAT_ID &&
        item.dps === 121 && Number.isFinite(item.originalHyst) && !writeLeaseProblem(item, now));
    if (pendingBand && pendingBand.set !== wantHyst) {
        cancelWriteLease('hysteresis', lease => lease.generation === pendingBand.modeGeneration);
    }
    const requestedOff = Math.min(ceiling, wd + bandUp);
    const off = atCapacity ? Math.min(requestedOff, wd + Math.max(0, applied - appliedWarm)) : requestedOff;
    h.offsetDeferred = atCapacity && (wd < cappedWarm || off < requestedOff);
    h.warmNote = requestedWarm && !live ? 'warm-up needs the heating controller On and local control ON'
        : requestedWarm && noPoint ? 'warm-up waits: ' + noPoint
        : wd < cappedWarm ? 'warm-up waits: ' + HEAT_CAPACITY_TEXT
        : cappedWarm < requestedWarm ? 'warm-up limited by the total curve cap or P23 range' : '';
    const set = h.target = noPoint ? null : +(base + wd).toFixed(1);
    if ([sup, ret, set].every(Number.isFinite)) h.samples.push([now, sup - set, sup - ret, Number.isFinite(amp) ? amp : null]);
    h.samples = h.samples.filter((x) => now - x[0] <= HEAT_WINDOW_MIN * MIN);
    const full = h.samples.length >= 20 && now - h.samples[0][0] >= (HEAT_WINDOW_MIN - 1) * MIN;
    const avg = (i) => Math.round(h.samples.reduce((a, x) => a + x[i], 0) / h.samples.length * 10) / 10;
    h.lag = h.samples.length ? avg(1) : null; h.gap = h.samples.length ? avg(2) : null;
    // P2: not following the curve — the full 10-min average stays more than bandDown + offCurveC below the point
    if (atCapacity) {
        h.offSince = 0; h.offWarned = false;
    } else if (full) {
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
    const a = { lag: full ? h.lag : null, amp: amps.length ? Math.max(...amps.slice(-6)) : null, cur, boost: h.boost || 0, atCapacity };
    const gentle = gentleDecision(c, { since: now - h.gentleSampleAt <= MIN ? h.gentleHotSince : null, last: h.gentleAt },
        dhwMeasurement(H['115']), now);
    h.gentleHotSince = gentle.since;
    if (c.maxHz) h.gentleSampleAt = now;
    const decision = noPoint ? { step: 0, why: 'waiting: ' + noPoint } : heatDecide(c, a);
    const dec = gentle.hot && decision.step > 0 ? { step: 0, why: 'compressor above ' + c.maxHz + ' Hz' } : decision;
    h.decStep = dec.step;   // d#175: the kick waits while the controller itself wants to step
    const top = c.preferSilent || gentle.lower ? 0 : c.allowPowerful ? 2 : 1;
    const boostLimit = Math.min(c.maxBoost, Math.max(0, +(ceiling - off).toFixed(8)));
    const boost = Math.min(h.boost || 0, boostLimit);
    // Up: power mode first, then a P23-only boost within the remaining offset budget.
    // Down: the curve boost first, then the mode. Powerful while it is not allowed → down at once.
    let steps = null, act = '', nb = boost;
    const gentleWait = !!(c.gentleStepMin && h.p23At && now - h.p23At < c.gentleStepMin * MIN);
    const curveSteps = (b) => {
        const target = heatingP23(hc, off + b, limitP23);
        const held = gentle.hot && target > P23 ? P23 : target;
        const p23 = c.maxP23Step && P23 <= limitP23
            ? Math.max(P23 - c.maxP23Step, Math.min(P23 + c.maxP23Step, held)) : held;
        const cc = { p23: P24 === hc.p24 ? p23 : Math.min(P23, p23), p24: Math.min(P24, hc.p24) };
        const out = [];
        if (P24 > hc.p24) out.push(p24w(hc.p24));
        if (cc.p23 !== P23) out.push(p23w(cc.p23));
        return { cc, out, deferred: (P24 > hc.p24 || !!c.maxP23Step) && cc.p23 !== target && (!gentle.hot || target <= P23) };
    };
    if (gentle.lower && applicable && live && !waitingForCurve && !gentleWait && P24 === hc.p24) {
        const floor = Math.max(1, hc.p23 - 4);
        const p23 = Math.min(limitP23, Math.max(floor, P23 - Math.min(2, c.maxP23Step || 2)));
        if (p23 < P23) {
            const change = { boost: 0, warmApplied: off, warmDeltaApplied: wd, curveReplan: true,
                curveCmd: { p23, p24: P24 }, step: true, gentleStep: true };
            h.why = 'gentle heating: above ' + c.maxHz + ' Hz for 3 min → P23 ' + P23 + ' to ' + p23;
            if (!queueHeatCurve([p23w(p23)], now + ':' + HEAT_ID + ':gentle', change, h.why)) h.why += ' — curve held by a higher writer';
            context.set('heat', h); return;
        }
    }
    // P3: a new or ended warm-up is written at once (not after the 10-min step); the controller then works on top of it
    // (h.warmApplied is the whole offset written above the owner's curve: warm-up + band up)
    const pendingOffset = pending?.curveChange.warmApplied;
    const unsafe = applicable && (P24 > hc.p24 || P23 > limitP23);
    const reducedOffset = off < applied && expectedCurve?.p23 > heatingP23(hc, off + boost, limitP23);
    if (applicable && live && (!gentleWait || unsafe) && (!waitingForCurve || reducedOffset || pendingOffset !== undefined && pendingOffset !== off) &&
        (unsafe || off !== applied || boost !== (h.boost || 0) || pendingOffset !== undefined && pendingOffset !== off ||
            h.curvePartial || h.curveReplan)) {
        const cs = curveSteps(boost);
        const parts = [wd ? 'warm-up +' + wd + ' °C' : '', bandOn ? 'band +' + c.bandUp + ' / −' + c.bandDown + ' °C' : ''].filter(Boolean);
        const act = (parts.length ? parts.join(', ') : 'offset over, curve back to ' + (boost ? 'boost +' + boost : 'yours')) + ' (P23 ' + cs.cc.p23 + ' / P24 ' + cs.cc.p24 + ')';
        const run = now + ':' + HEAT_ID + ':warm';
        const change = { boost, warmApplied: off, warmDeltaApplied: wd, curveReplan: cs.deferred || (gentle.hot && h.curveReplan),
            curveCmd: cs.cc.p23 === hc.p23 && cs.cc.p24 === hc.p24 ? null : cs.cc };
        h.why = act;
        const writes = reducedOffset && !cs.out.some(w => w.dps === 133) ? [...cs.out, p23w(cs.cc.p23)] : cs.out;
        if (!queueHeatCurve(writes, run, change, act)) h.why += ' — curve held by a higher writer';
        context.set('heat', h); return;
    }
    if (!noPoint && md === 'live' && settings.master) h.warmDeltaApplied = wd;
    // P6: the pump's heating hysteresis follows the band; the owner's own value is saved once and written back
    const hyst = num(H['121']);
    if (md === 'live' && settings.master && wantHyst !== null && Number.isFinite(hyst) && hyst !== wantHyst
        && !(h.hystAt && now - h.hystAt < 2 * MIN)) {
        const w = hystw(wantHyst);
        const run = now + ':' + HEAT_ID + ':band';
        h.why = (bandOn ? 'band: compressor restarts ' + bandHyst + ' °C below its stop point' : 'band off: your heating hysteresis back') + ' → ' + w.text;
        if (queueBand(w, run, false, h.why, bandOn ? hyst : undefined)) pump();
        context.set('heat', h); return;
    }
    if (!c.band && Number.isFinite(settings.heatBandSaved) && hyst === settings.heatBandSaved) { settings.heatBandSaved = null; saveSettingsFile(); }
    if (cur > top) { steps = [mode(HEAT_LADDER[top])]; act = MODE_NAME[HEAT_LADDER[top]]; }
    else if (dec.step > 0 && cur < top) { steps = [mode(HEAT_LADDER[cur + 1])]; act = MODE_NAME[HEAT_LADDER[cur + 1]]; }
    else if (dec.step > 0 && applicable && P24 === hc.p24 && !waitingForCurve && !gentleWait && boost < boostLimit) {
        nb = Math.min(boostLimit, boost + 1);
        const cs = curveSteps(nb);
        if (cs.out.length) { steps = cs.out; act = 'curve +' + nb + ' °C (P23 ' + cs.cc.p23 + ' / P24 ' + cs.cc.p24 + ')'; }
    }
    else if (dec.step < 0 && applicable && !waitingForCurve && !gentleWait && boost > 0) {
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
            + (boost ? ', curve +' + boost + ' °C' : '') + (boost >= boostLimit
                ? (boostLimit === c.maxBoost ? ' (boost cap +' + c.maxBoost + ' °C)' : ' (curve offset limit)') : '')
            : '';
    if (blockWhy && h.blockWhy !== blockWhy.replace(/[-+]?\d+(\.\d+)?/g, '#')) logEvent({ kind: 'warn', rule: HEAT_ID, cloud: HEAT_NAME, live: true, text: 'step up blocked: ' + blockWhy });
    h.blockWhy = blockWhy ? blockWhy.replace(/[-+]?\d+(\.\d+)?/g, '#') : '';
    if (reverted) logEvent({ kind: 'info', rule: HEAT_ID, cloud: HEAT_NAME, live: true, text: 'pump mode is ' + (MODE_NAME[H['2']] || H['2']) + ', the controller set ' + MODE_NAME[h.modeCmd] + ' → step again now' });
    if (!steps) { h.why = dec.why + (dec.step ? ' (already ' + MODE_NAME[H['2']] + (boost ? ', curve +' + boost + ' °C' : '') + ' — limit)' : ''); context.set('heat', h); return; }
    if (early && cur <= top) { h.why = dec.why + ' → ' + act + ' after ' + new Date(h.lastStep + c.stepMin * MIN).toTimeString().slice(0, 5); context.set('heat', h); return; }
    if (steps[0].dps === 2 && h.modeCmd === steps[0].set && now - h.modeAt < MIN) { context.set('heat', h); return; }
    const protection = cur > top;
    if (live && modeBlocked({ ...steps[0], rule: HEAT_ID, protection })) {
        h.why = dec.why + ' → mode retry paused';
        context.set('heat', h); return;
    }
    if (live && isModeWrite(steps[0])) {
        const q = context.get('queue') || [];
        const step = steps[0];
        if (q.some(item => item.heatStep && item.set === step.set && item.protection === protection && !writeLeaseProblem(item, now))) {
            context.set('heat', h); return;
        }
        const request = tagWrite({ rule: HEAT_ID, cloud: HEAT_NAME, run: now + ':' + HEAT_ID, ...step, protection, heatStep: true },
            protection ? 'protection' : 'heat', now);
        h.why = dec.why + ' → ' + (request.writeRejection ? 'mode held by a higher writer' : act);
        context.set('heat', h);
        if (!request.writeRejection) {
            q.push(request);
            context.set('queue', q);
            logEvent({ kind: 'write', rule: HEAT_ID, cloud: HEAT_NAME, run: request.run, live: true,
                text: h.why + ': ' + step.text });
            pump();
        }
        return;
    }
    if (live) {
        h.why = dec.why + ' → ' + act;
        const change = { boost: nb, curveCmd: off + nb > 0 ? curveSteps(nb).cc : null, step: true,
            ...(nb > boost && { requestedBoost: Math.min(c.maxBoost, boost + 1) }),
            ...(c.maxP23Step && { curveReplan: curveSteps(nb).deferred }) };
        if (!queueHeatCurve(steps, now + ':' + HEAT_ID, change, h.why)) h.why += ' — curve held by a higher writer';
        context.set('heat', h);
        return;
    }
    h.run = now + ':' + HEAT_ID; h.lastStep = now;
    if (steps[0].dps === 2) { h.modeCmd = steps[0].set; h.modeAt = now; }
    else { h.boost = nb; h.p23At = now; h.curveCmd = wd + nb > 0 ? curveSteps(nb).cc : null; }   // the warm-up stays written after a boost step-down
    h.samples = [];   // the next decision only sees the new mode / curve
    h.why = dec.why + ' → ' + act;
    for (const s of steps) logEvent({ kind: 'dry', rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, live: false, text: dec.why + ' → would ' + s.text });
    context.set('heat', h);
}
