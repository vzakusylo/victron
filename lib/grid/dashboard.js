function gridDashboardOutput(previous, before, after, command, wallNow, tolerance) {
    let read = previous?.read ?? null;
    if (before?.phase === 'reading' && before.reading) {
        const { value, error } = before.reading;
        read = Number.isFinite(value)
            ? { value, state: Math.abs(value - before.value) <= tolerance ? 'Match' : 'Mismatch' }
            : { value: null, state: 'Read failed', error };
    }
    if (command && command.payload !== before?.value) read = null;
    return {
        value: after.value ?? null,
        sentAt: command ? wallNow : previous?.sentAt ?? null,
        phase: after.phase ?? 'not sent',
        fault: after.fault ?? '',
        read
    };
}

function gridDashboardSnapshot(decision, waiting, arrivals, outputs, feedbackAlerts, health) {
    const flags = decision?.limitFlags || [];
    return {
        decision: decision?.windowName ?? 'Waiting',
        reason: waiting || (flags.length ? flags.join(' / ') : 'Tariff and charge schedule'),
        targets: decision ? [decision.finalChargeCurrent, decision.finalGridSetpoint, decision.gridCurrentLimitA] : null,
        arrivals: [...SENSOR_KEYS.values()].map(key => arrivals?.[key] ?? null),
        outputs,
        safeMode: 'not implemented',
        feedbackAlerts,
        heartbeatAlerts: health?.alerts ?? 0,
        cadenceMs: health?.intervalP95Ms ?? null,
        lagMs: health?.lagP95Ms ?? null
    };
}

function gridDashboardStatus(previous, snapshot, now, wallNow) {
    if (previous && now - previous.at < 2000) return { state: previous, message: null };
    // Timestamps of actual input arrivals and queued writes are part of the snapshot;
    // wall time itself isn't. The browser ages the last reported arrivals.
    const signature = JSON.stringify(snapshot);
    if (previous?.signature === signature) return { state: previous, message: null };
    return { state: { at: now, signature }, message: { payload: { ...snapshot, reportedAt: wallNow } } };
}
