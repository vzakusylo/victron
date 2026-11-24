//! lib/heat-pump/dhw-helpers.js: DHW controller helpers: usage / shower statistics, the DHW model and plan.
//! Included into "40 Heat pump automations.js" by `// #include` (tools/includes.js); it runs in that
//! function node's scope, not as a module. Lines starting with //! are not embedded in flows.json.
// ---- DHW controller (d#130, rebuilt on the pump's curve in d#142) -------------------------
// The pump's weather curve P22 stays ON all the time. The controller only switches the curve's
// values (docs/heat-pump-dhw-curve-plan.md):
//   heating — the owner's P23 / P24 (P23 slider), stored in settings.heatCurve;
//   stop    — P23 0: the curve gives 20 °C and the compressor stops before a valve switch;
//   boiler  — P24 = boilerP24 (12) and P23 computed from the wanted supply (tank target + 4) at
//             the 10-min outdoor average, raised 1 per minute while supply − return ≤ gap.
// States: HEATING → STOP → DHW (⇄ DEFROST_DHW → STOP) → HEATING (end = heating curve back).
// Compressor protection in DHW: Silent only at ≤ coldLimit, supply ≤ coldCap there; ≥ protHz or
// ≥ protAmpPct of 9.67 A or discharge ≥ protDischarge for 3 min → P23 − 2 and Silent (every 3 min);
// held 10 min or 3 steps and hot again → end of the cycle (the electric heater takes over).
// If Node-RED stops mid-cycle the pump still runs on a curve; on every start (and outside a cycle)
// the heating values are written back when the pump shows the stop or boiler values.
// d#144: valve travel, quick retry after an early abort (Er03 on 11 Nov), max duration counts DHW time only
const VALVE_TRAVEL_S = 90;     // valve ON with the curve still at P23 0 (no demand) while the valve moves
const EARLY_MIN = 5;           // a cycle that ends earlier (Er03, valve switched back) …
const RETRY_MIN = 15;          // … is tried again after this, ignoring the interval …
const RETRY_MAX = 2;           // … at most this many times in a row
const HARD_EXTRA_MIN = 30;     // a cycle never lasts longer than max duration + this (defrosts included)
const p23w = (v) => ({ role: 'hp', dps: 133, set: v, text: 'curve P23 ' + v });
const p24w = (v) => ({ role: 'hp', dps: 134, set: v, text: 'curve P24 ' + v });
const hystw = (v) => ({ role: 'hp', dps: 121, set: v, text: 'heating hysteresis ' + v + ' °C' });   // P6
const SHOWER_HISTORY_MS = 14 * 24 * 3600 * 1000;
const SHOWER_MIN_DEFICIT_C = 1;
const USAGE_DAYS = 90;              // daily motion / hot-water statistics kept in the settings file
const USAGE_VISIT_GAP_MS = 5 * MIN; // PIR reports closer than this belong to one visit
function usageDay(t) {
    const u = settings.dhwUsage || (settings.dhwUsage = {});
    const key = dayKey(t);
    if (!u[key]) {
        u[key] = { visits: 0, draws: 0, drawsWithMotion: 0, dropC: 0, hours: new Array(24).fill(0) };
        const keys = Object.keys(u).sort();
        while (keys.length > USAGE_DAYS) delete u[keys.shift()];
    }
    return u[key];
}
function countVisit(motion) {
    if (motion.source !== 'local' || !Number.isFinite(motion.lastMotionAt) || motion.lastMotionAt <= 0 || motion.lastMotionAt > now) return false;
    // A visit ends after 5 min without any PIR report: the gap is measured from the last report SEEN, so one long
    // stay (a shower with reports every 1–2 min) is one visit. The last seen report is kept in the settings, so a
    // restart does not count the same report twice (it is written to the file with the next counted visit or draw).
    const last = Number(settings.dhwUsageLastSeen) || 0;
    if (last && motion.lastMotionAt <= last) return false;
    settings.dhwUsageLastSeen = motion.lastMotionAt;
    if (last && motion.lastMotionAt - last < USAGE_VISIT_GAP_MS) return false;
    usageDay(motion.lastMotionAt).visits++;
    return true;
}
function usageCfg(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    const count = (v) => Number.isInteger(v) && v >= 0 ? v : 0;
    for (const key of Object.keys(raw).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-USAGE_DAYS)) {
        const r = raw[key] || {};
        const hours = Array.isArray(r.hours) && r.hours.length === 24 ? r.hours.map(count) : new Array(24).fill(0);
        out[key] = { visits: count(r.visits), draws: count(r.draws), drawsWithMotion: Math.min(count(r.drawsWithMotion), count(r.draws)),
            dropC: Number.isFinite(r.dropC) && r.dropC >= 0 ? r.dropC : 0, hours };
    }
    return out;
}
function countDraw(ep) {
    const day = usageDay(ep.at);
    day.draws++;
    if (ep.motionAt) day.drawsWithMotion++;
    day.dropC = Math.round((day.dropC + (ep.peak - ep.low)) * 10) / 10;
    day.hours[new Date(ep.at).getHours()]++;
}
function usageSummary(days = 7) {
    const u = settings.dhwUsage || {};
    const keys = [];
    // calendar days, not 24 h steps: a 23 h or 25 h DST day is neither skipped nor counted twice
    for (let i = 0; i < days; i++) { const t = new Date(now); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() - i); keys.push(dayKey(t.getTime())); }
    const rows = keys.map(k => u[k]).filter(Boolean);
    if (!rows.length) return { days: 0 };
    const sum = (f) => rows.reduce((a, r) => a + (Number(r[f]) || 0), 0);
    const hours = new Array(24).fill(0);
    for (const r of rows) (r.hours || []).forEach((v, h) => { hours[h] += Number(v) || 0; });
    const peak = hours.some(v => v > 0) ? hours.indexOf(Math.max(...hours)) : null;
    const visits = sum('visits'), draws = sum('draws'), withMotion = sum('drawsWithMotion');
    return { days: rows.length, visitsPerDay: Math.round(visits / rows.length * 10) / 10,
        drawsPerDay: Math.round(draws / rows.length * 10) / 10,
        motionShare: draws ? Math.round(withMotion / draws * 100) : null,
        dropCPerDay: Math.round(sum('dropC') / rows.length * 10) / 10, peakHour: peak };
}
function showerState() {
    return ctx('shower', { samples: [], lastValve: null, valveAt: now, episode: null, demand: null, dropC: null });
}
function cancelShowerWrites(run) {
    if (!run) return;
    cancelModeWrite(active => active.run === run);
    const q = context.get('queue') || [];
    for (let i = q.length - 1; i >= 0; i--) if (q[i].run === run) q.splice(i, 1);
    context.set('queue', q);
    context.set('cancelledShowerRuns', (context.get('cancelledShowerRuns') || []).concat(run).slice(-4));
}
function showerForecast() {
    const history = (settings.showerHistory || []).filter(e => !e.cancelled && e.at <= now && now - e.at <= SHOWER_HISTORY_MS)
        .map(e => { const date = new Date(e.at); return { minute: date.getHours() * 60 + date.getMinutes(),
            weekend: [0, 6].includes(date.getDay()), day: dayKey(e.at) }; });
    let best = null;
    for (let ahead = 0; ahead < 7; ahead++) {
        const date = new Date(now); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + ahead);
        const weekend = [0, 6].includes(date.getDay());
        const points = history.filter(e => e.weekend === weekend);
        for (const seed of points) {
            const origin = seed.minute;
            // Circular minutes keep usage around midnight in the same cluster.
            const distance = e => ((e.minute - origin + 2160) % 1440) - 720;
            const cluster = points.filter(e => Math.abs(distance(e)) <= 30);
            const days = new Set(cluster.map(e => e.day)).size;
            if (days < 3) continue;
            const offsets = cluster.map(distance).sort((a, b) => a - b);
            const center = (origin + offsets[Math.floor(offsets.length / 2)] + 1440) % 1440;
            const expected = new Date(date); expected.setMinutes(center);
            const at = expected.getTime();
            if (at < now - 15 * MIN) continue;
            if (!best || at < best.at) best = { at, days, weekend };
        }
    }
    return best;
}
const MANUAL_QUEUE_MS = 3 * 3600 * 1000;   // a forced boiler run that never could start is dropped after this
// Operator "Force boiler run": persisted, starts as soon as the safety gates allow (right after a defrost).
function manualDemand() {
    const m = settings.dhwManual;
    if (!m || !Number.isFinite(m.at) || !Number.isFinite(m.until)) return null;
    if (m.until <= now) {
        settings.dhwManual = null; saveSettingsFile();
        logEvent({ kind: 'warn', rule: DHW_ID, cloud: DHW_NAME, text: 'forced boiler run expired: it could not start within ' + Math.round(MANUAL_QUEUE_MS / 3600000) + ' h' });
        return null;
    }
    return { id: 'manual:' + m.at, at: m.at, type: 'manual', until: m.until, reason: 'operator forced boiler run' };
}
function showerModel(d, c) {
    const s = showerState(), forecast = showerForecast(), motion = flow.get('bathroomMotion') || {};
    const requested = !!(c.showerForce && s.demand && s.demand.until > now);
    const active = !!(d.showerStart && d.state !== 'HEATING');
    const manualRun = !!(active && d.showerStart.type === 'manual');
    const m = settings.dhwManual;
    return { enabled: !!c.showerForce, requested, active,
        manual: { queued: !!(m && m.until > now), at: m ? m.at : 0, until: m ? m.until : 0, running: manualRun,
            why: m && m.until > now && d.state === 'HEATING' ? d.why || '' : '' },
        state: active ? ((c.showerForce || manualRun) && !d.showerStopRequested && !d.showerSafetyStopRequested ? d.live ? 'heating' : 'test' : 'stopping') : !c.showerForce ? 'paused' : requested ? 'requested' : forecast ? 'armed' : 'learning',
        motionAt: motion.lastMotionAt || 0, motionReportAt: motion.t || 0, motionValue: motion.value || 'unknown',
        expectedAt: forecast ? forecast.at : 0, evidenceDays: forecast ? forecast.days : 0,
        observations: (settings.showerHistory || []).filter(e => !e.cancelled).length,
        dropC: s.dropC, reason: active ? d.showerStart.reason : requested ? s.demand.reason : '',
        leadMin: c.showerLeadMin || DHW_DEFAULTS.showerLeadMin, minDeficitC: SHOWER_MIN_DEFICIT_C,
        usage: usageSummary(7) };
}
function observeShower(d, c, tank, valveOn, bypassOn, defNow, devOk) {
    const s = showerState(), motion = flow.get('bathroomMotion') || {};
    let usageChanged = countVisit(motion);
    if (s.lastValve !== valveOn) { s.lastValve = valveOn; s.valveAt = now; }
    const last = s.samples[s.samples.length - 1];
    const stable = devOk && Number.isFinite(tank) && !bypassOn && !defNow && !recentDefrost && !defRecovering && !restartSettling
        && now - s.valveAt >= 5 * MIN && (!last || now - last[0] <= MIN);
    s.samples = s.samples.filter(p => now - p[0] <= 3 * MIN);
    if (!stable) { s.samples = []; s.episode = null; s.dropC = null; }
    else {
        const peak = Math.max(tank, ...s.samples.map(p => p[1]));
        const fell = !!last && tank < last[1];
        s.dropC = peak - tank;
        const motionRecent = motion.source === 'local' && motion.lastMotionAt > 0
            && now >= motion.lastMotionAt && now - motion.lastMotionAt <= 15 * MIN;
        if (s.episode && now - s.episode.lastFall > 10 * MIN) s.episode = null;
        if (fell && s.dropC >= 1) {
            if (!s.episode) s.episode = { at: now, peak, low: tank, lastFall: now, motionAt: motionRecent ? motion.lastMotionAt : 0 };
            s.episode.low = Math.min(s.episode.low, tank); s.episode.lastFall = now;
            if (!s.episode.counted && s.episode.peak - s.episode.low >= 2) {
                s.episode.counted = true;
                countDraw(s.episode);
                usageChanged = true;
            }
            const history = settings.showerHistory || [];
            if (!s.episode.cancelled && s.episode.motionAt && s.episode.peak - s.episode.low >= 2 && !history.some(e => e.at === s.episode.at)) {
                settings.showerHistory = history.filter(e => now - e.at <= SHOWER_HISTORY_MS).concat({
                    at: s.episode.at, motionAt: s.episode.motionAt, dropC: s.episode.peak - s.episode.low, cancelled: false
                }).slice(-64);
                usageChanged = true;
                logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: 'recorded motion-correlated tank drop; possible hot-water use, not a confirmed shower' });
            }
            if (c.showerForce && d.state === 'HEATING' && (motionRecent || s.dropC >= 2)) {
                s.demand = { id: 'draw:' + s.episode.at, at: now, evidenceAt: s.episode.at, type: 'drop', until: now + 20 * MIN,
                    reason: motionRecent ? 'local motion + tank falling' : 'tank fell at least 2 °C within 3 min' };
            }
        }
        s.samples.push([now, tank]);
    }
    if (!c.showerForce || (s.demand && (s.demand.until <= now || s.demand.id === (settings.showerLastStart || {}).id))) s.demand = null;
    const forecast = showerForecast();
    if (c.showerForce && !s.demand && forecast && forecast.at - now <= (c.showerLeadMin || 30) * MIN && d.state === 'HEATING') {
        const id = 'forecast:' + forecast.at;
        if (id !== (settings.showerLastStart || {}).id) s.demand = { id, at: now, type: 'preheat', until: forecast.at + 15 * MIN,
            reason: 'learned hot-water window on ' + forecast.days + ' distinct days' };
    }
    context.set('shower', s);
    if (usageChanged) saveSettingsFile();
    return s.demand;
}
function dhwState() {
    const d = ctx('dhw', { state: 'HEATING', since: now, run: null, live: false, lastEnd: 0, p23Cmd: null, p24Cmd: null, rampAt: 0,
        startAt: 0, startTank: null, streak: 0, outS: [], outAvg: null, lagS: [], prog: null, defTicks: 0, fanOkSince: 0,
        valveOnSince: 0, goal: null, want: null, prot: null, curveFixAt: 0, why: '', waitNote: '' });
    const seed = context.get('restartOutdoor');
    if (seed) {
        context.set('restartOutdoor', null);
        if (d.state === 'HEATING' && now - seed[0] <= FRESH_MS) {
            d.outS = [seed];
            d.outAvg = Math.round(seed[1] * 10) / 10;
            context.set('dhw', d);
        }
    }
    return d;
}
function dhwLastEnd(d) { return Math.max(d.lastEnd || 0, Number((context.get('settings') || settings).dhwLastEnd) || 0); }
function dhwModel() {
    const d = dhwState(), c = dhwCfgNow();
    const out = d.outAvg;
    const cold = out !== null && out <= c.coldLimit;
    const lastEnd = dhwLastEnd(d);
    const s = context.get('settings') || settings;
    return { mode: modeOf(DHW_ID), state: d.state, since: d.since, why: d.why, waitNote: d.waitNote, outAvg: out,
        target: out === null ? null : (out < c.frostLimit ? null : curveAt(c.curve, out)), frost: out !== null && out < c.frostLimit,
        cold, wanted: out === null ? null : wantedSupply(c, out),
        p23Cmd: d.p23Cmd, p24Cmd: d.p24Cmd, goalP23: d.goal, curveSupply: d.p23Cmd !== null && d.p24Cmd !== null && out !== null ? +heatCurveAt(d.p23Cmd, d.p24Cmd, out).toFixed(1) : null,
        prot: d.prot, heatCurve: s.heatCurve || null, plan: dhwPlan(d, c),
        startTank: d.startTank, startAt: d.startAt, lastEnd,
        progress: ['STOP', 'VALVE', 'DHW', 'DEFROST_DHW'].includes(d.state) && out !== null ? dhwProgress(d.startTank, n(((st.hp && st.hp.dps) || {})['108']), out < c.frostLimit ? null : curveAt(c.curve, out)) : null,
        planned: s.dhwRetry && !s.dhwRetry.n ? s.dhwRetry.at : 0,
        blocked: s.dhwBlock || null, shower: showerModel(d, c),
        nextStart: lastEnd ? lastEnd + (cold ? c.coldIntervalH : c.minIntervalH) * 3600 * 1000 : 0, lag: dhwLag(d), cfg: c, defrost: defrostForecast() };
}
// d#143: where the running cycle is heading: tank target and the expected end, from the tank rise
// of the last 6 min (least-squares slope, at least 3 min of DHW), never later than the max duration
function dhwPlan(d, c) {
    if (!['STOP', 'VALVE', 'DHW', 'DEFROST_DHW'].includes(d.state) || d.outAvg === null) return null;
    const target = d.outAvg < c.frostLimit ? null : curveAt(c.curve, d.outAvg);
    if (target === null) return null;
    const cold = d.outAvg <= c.coldLimit;
    const maxDur = (cold ? c.maxMinCold : c.maxMin) * MIN;
    const maxEnd = Math.min(now + Math.max(0, maxDur - (d.dhwMs || 0)), d.startAt + maxDur + HARD_EXTRA_MIN * MIN);
    const s = d.tankS || [];
    const last = s.length ? s[s.length - 1] : null;
    let rate = null, eta = null;
    if (d.state === 'DHW' && s.length >= 2 && last[0] - s[0][0] >= 3 * MIN) {
        const mx = s.reduce((a, p) => a + p[0], 0) / s.length, my = s.reduce((a, p) => a + p[1], 0) / s.length;
        const sxx = s.reduce((a, p) => a + (p[0] - mx) * (p[0] - mx), 0), sxy = s.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
        rate = sxx > 0 ? sxy / sxx * MIN : null;   // °C per minute
        if (rate !== null && rate > 0.02) eta = Math.round(last[0] + Math.max(0, target - (my + rate * (last[0] - mx) / MIN)) / rate * MIN);
    }
    const capped = eta === null || eta > maxEnd;
    return { target, tank: last ? last[1] : d.startTank, startAt: d.startAt, rate: rate === null ? null : Math.round(rate * 100) / 100,
        eta: capped ? maxEnd : eta, byMax: capped, maxEnd };
}
function dhwLag(d) {
    const s = d.lagS || [];
    if (s.length < 20 || s[s.length - 1][0] - s[0][0] < 20 * MIN) return null;
    return Math.round(s.reduce((a, x) => a + x[1], 0) / s.length * 10) / 10;
}
// d#169: next defrost = last start + median of the last intervals (10 min … 3 h); null with < 2 intervals or when overdue
function defrostForecast() {
    const ds = ((context.get('settings') || settings).defrostStarts || []).slice(-7);
    const iv = [];
    for (let i = 1; i < ds.length; i++) { const g = ds[i] - ds[i - 1]; if (g > 10 * MIN && g < 3 * 3600 * 1000) iv.push(g); }
    if (iv.length < 2) return null;
    iv.sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    const next = ds[ds.length - 1] + med;
    return { last: ds[ds.length - 1], intervalMin: Math.round(med / MIN), next: now - next > 15 * MIN ? null : next };
}
// d#171: the pump's P23 is the heating controller's boost, not a new owner curve (do not store it)
function boostedCurve(heat, P23, P24) {
    const h = context.get('heat') || {};
    if (!heat) return false;
    return ((h.boost > 0 || h.warmApplied > 0) && !!h.curveCmd && P23 === h.curveCmd.p23 && P24 === h.curveCmd.p24) || (!!h.p23At && now - h.p23At < 2 * MIN);
}
// d#194: never write the settings file before it has been read. On 20 Nov 00:36 the d#193 redeploy started the
// node with default settings (local control OFF); a motion visit saved them over the real file before 'load'
// arrived, and modes, heating curve and shower history were lost. A defrost start right after a restart could do
// the same. Until 'load' succeeds, changes stay in the context only.
function saveSettingsFile() {
    persist();
    if (context.get('settingsLoaded') === false) {
        if (!context.get('saveHeldNoted')) {
            context.set('saveHeldNoted', true);
            logEvent({ kind: 'warn', text: 'settings file not written: it has not been read since the node start' });
        }
        return;
    }
    send(2, saveMsg());
}
