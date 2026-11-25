function pauseRequested() { return Number.isFinite(settings.pauseUntil) && now < settings.pauseUntil; }
function masterOffBlock() {
    if (pauseRequested()) return 'Resume the heat pump on the Heat Pump page before turning local control OFF.';
    if (settings.pauseStandby) return 'Wait for the owner curve to be restored before turning local control OFF.';
    return '';
}
function pauseProtection(outdoor, tank, cfg) {
    if (!Number.isFinite(outdoor) || outdoor <= 0) return 'frost protection';
    const floor = Math.min(...cfg.curve.map(point => point[1])) - cfg.hyst;
    if (!Number.isFinite(tank) || tank <= floor) return 'tank protection';
    return '';
}
function pauseHolding(at = now, cfg = settings, device = st.hp) {
    const hp = device?.dps || {};
    return cfg.pauseUntil > at && freshAutomationDevice(device, at) &&
        !pauseProtection(dhwMeasurement(hp['103']), dhwMeasurement(hp['108']), cfg.dhw || DHW_DEFAULTS);
}
function pauseModel() {
    if (!pauseRequested()) return null;
    const hp = st.hp?.dps || {};
    return { until: settings.pauseUntil, minutes: Math.ceil((settings.pauseUntil - now) / MIN),
        protection: !ready('hp') ? 'waiting for fresh readings'
            : pauseProtection(dhwMeasurement(hp['103']), dhwMeasurement(hp['108']), dhwCfgNow()) };
}
function retryDecision(block, count, cfg, fault, at) {
    if (!block?.retryable || !cfg.autoRetry || count >= cfg.retryMax) return null;
    const due = block.at + cfg.retryWait * MIN;
    return { due, ready: fault === 0 && at >= due };
}
function pauseCurveTick(d, h, H, safe) {
    const holding = pauseHolding();
    if (!holding && !settings.pauseStandby) return false;
    h.samples = [];
    h.gentleHotSince = null;
    const owner = settings.heatCurve;
    const p23 = dhwMeasurement(H['133']), p24 = dhwMeasurement(H['134']);
    if (!settings.master || !safe || d.state !== 'HEATING' || !owner || !heatCurveEnabled(H['132'])
        || !validHeatCurve(p23, p24) || (!holding && !ready('hp'))) return holding || settings.pauseStandby;
    const desired = holding ? 0 : owner.p23;
    if (!holding && p23 !== 0) {
        settings.pauseStandby = false;
        saveSettingsFile();
        h.curveSynced = false;
        return false;
    }
    const last = context.get('pauseCurveWrite');
    if (p23 === desired || p24 !== owner.p24 || (last?.holding === holding && now - last.at < MIN)) return true;
    if ((context.get('queue') || []).some(item => item.pauseCurve && item.set === desired && !writeLeaseProblem(item, now))) return true;
    if (holding && !settings.pauseStandby) {
        settings.pauseStandby = true;
        saveSettingsFile();
    }
    if (enqueueCurveGroup([p23w(desired)], { rule: HEAT_ID, cloud: HEAT_NAME, run: now + ':pause',
        force: true, pauseCurve: holding ? 'standby' : 'restore', curveWriter: holding ? 'owner (pause)' : 'restore' }, 'heat', now)) {
        context.set('pauseCurveWrite', { holding, at: now });
    }
    return true;
}
