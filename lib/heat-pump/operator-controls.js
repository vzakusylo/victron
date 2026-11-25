function pauseRequested() { return Number.isFinite(settings.pauseUntil) && now < settings.pauseUntil; }
const PAUSE_RESTORE_WARN_MS = 5 * MIN;
const PAUSE_PROTECTION_DWELL_MS = 10 * MIN;
function abandonPauseRestore(reason) {
    if (settings.pauseStandby) {
        logEvent({ kind: 'warn', rule: HEAT_ID, cloud: HEAT_NAME, text: reason
            + '; owner curve restore not confirmed. Check P23/P24 and apply the owner curve on the Heat Pump page when safe.' });
    }
    settings.pauseUntil = 0;
    settings.pauseStandby = false;
    settings.pauseRestoreBy = 0;
    settings.pauseRestoreWarned = false;
    context.set('pauseProtection', null);
    context.set('pauseCurveWrite', null);
}
function pauseProtection(outdoor, tank, cfg, recovering = false) {
    if (!Number.isFinite(outdoor) || (recovering ? outdoor < 1 : outdoor <= 0)) return 'frost protection';
    const floor = Math.min(...cfg.curve.map(point => point[1])) - cfg.hyst;
    if (!Number.isFinite(tank) || (recovering ? tank < floor + 2 : tank <= floor)) return 'tank protection';
    return '';
}
function pauseProtectionFor(cfg, device, at, recovering) {
    if (!freshAutomationDevice(device, at)) return 'waiting for fresh readings';
    const hp = device.dps || {};
    return pauseProtection(dhwMeasurement(hp['103']), dhwMeasurement(hp['108']), cfg.dhw || DHW_DEFAULTS, recovering);
}
function updatePauseProtection() {
    const previous = context.get('pauseProtection');
    if (!pauseRequested()) {
        if (previous) context.set('pauseProtection', null);
        return;
    }
    const reason = pauseProtectionFor(settings, st.hp, now, !!previous);
    if (reason) context.set('pauseProtection', { reason, clearSince: null });
    else if (previous) {
        const clearSince = previous.clearSince ?? now;
        context.set('pauseProtection', now - clearSince >= PAUSE_PROTECTION_DWELL_MS ? null : { ...previous, clearSince });
    }
}
function pauseHolding(at = now, cfg = settings, device = st.hp) {
    return cfg.pauseUntil > at && !context.get('pauseProtection') && !pauseProtectionFor(cfg, device, at);
}
function pauseModel() {
    if (!pauseRequested()) return null;
    return { until: settings.pauseUntil, minutes: Math.ceil((settings.pauseUntil - now) / MIN),
        protection: pauseProtectionFor(settings, st.hp, now) || context.get('pauseProtection')?.reason || '' };
}
function retryDecision(block, count, cfg, fault, at) {
    if (!block?.retryable || !cfg.autoRetry || count >= cfg.retryMax) return null;
    const due = block.at + cfg.retryWait * MIN;
    return { due, ready: fault === 0 && at >= due };
}
function pauseCurveTick(d, h, H, safe) {
    const holding = pauseHolding();
    if (!holding && !settings.pauseStandby) return false;
    if (holding && settings.pauseRestoreBy) {
        settings.pauseRestoreBy = 0;
        settings.pauseRestoreWarned = false;
        saveSettingsFile();
    } else if (!holding && !settings.pauseRestoreBy) {
        settings.pauseRestoreBy = now + PAUSE_RESTORE_WARN_MS;
        saveSettingsFile();
    }
    h.samples = [];
    h.gentleHotSince = null;
    const owner = settings.heatCurve;
    const p23 = dhwMeasurement(H['133']), p24 = dhwMeasurement(H['134']);
    const canRestore = settings.master && safe && d.state === 'HEATING' && owner && heatCurveEnabled(H['132'])
        && validHeatCurve(p23, p24);
    if (!holding && canRestore && p23 !== 0) {
        settings.pauseStandby = false;
        settings.pauseRestoreBy = 0;
        settings.pauseRestoreWarned = false;
        saveSettingsFile();
        h.curveSynced = false;
        return false;
    }
    if (!holding && !settings.pauseRestoreWarned && now >= settings.pauseRestoreBy) {
        settings.pauseRestoreWarned = true;
        saveSettingsFile();
        logEvent({ kind: 'warn', rule: HEAT_ID, cloud: HEAT_NAME,
            text: 'Heating pause restore is still pending; will retry when the heating circuit is safe' });
    }
    if (!canRestore) return true;
    const desired = holding ? 0 : owner.p23;
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
