function advanceGridFeedback(previous, { now, value, reading, gap, tolerance, refresh = false, reassert = false }) {
    const state = { ...previous };
    const out = { state };
    const wanted = Number.isFinite(value);
    if (state.phase === 'reading' && reading) {
        const match = Number.isFinite(reading.value) && Math.abs(reading.value - state.value) <= tolerance;
        if (match) {
            delete state.fault;
            state.phase = 'verified';
        } else if (state.probe || state.retried) {
            const reason = `expected ${state.value}; ${reading.error || `read ${reading.value}`}`;
            if (!state.fault) out.alarm = reason;
            state.fault = reason;
            state.phase = 'failed';
            state.due = now + 10000;
        } else {
            state.phase = 'retry';
        }
    }

    if (state.phase === 'reading') return out;
    if (state.phase === 'pending') {
        if (now >= state.due) {
            state.phase = 'reading';
            state.probe = false;
            out.read = true;
        }
        return out;
    }
    const changed = wanted && value !== state.value;
    if (wanted && now - (state.sent ?? -Infinity) >= gap &&
        (changed || state.phase === 'retry' || state.phase === 'verified' && refresh ||
         state.phase === 'failed' && reassert)) {
        state.retried = !changed && (state.phase === 'retry' || state.phase === 'failed');
        state.value = value;
        state.sent = now;
        state.due = now + 4000;
        state.phase = 'pending';
        out.write = value;
    } else if (state.phase === 'failed' && now >= state.due) {
        state.phase = 'reading';
        state.probe = true;
        out.read = true;
    }
    return out;
}

function gridFeedbackNotice(previous, faults, now, clockStart) {
    const stored = previous?.lastAlertElapsed;
    let lastAlertElapsed;
    // A previous boot's overlapping stamp can only delay a notice, not release it early.
    if (Number.isFinite(stored) && stored >= clockStart && stored <= now) {
        lastAlertElapsed = stored;
    } else if (Number.isFinite(stored) || Number.isFinite(previous?.lastAlert) || previous?.notified) {
        // A wall timestamp or a previous process's stamp cannot prove elapsed time.
        lastAlertElapsed = now;
    }
    const state = { lastAlertElapsed };
    if (!faults.length) return { state };
    if (previous?.notified) state.notified = true;
    if (state.notified || now - (lastAlertElapsed ?? -Infinity) < 15 * 60 * 1000) {
        return { state };
    }
    return { state: { notified: true, lastAlertElapsed: now }, text: `grid not following setpoint: ${faults.join('; ')}` };
}
