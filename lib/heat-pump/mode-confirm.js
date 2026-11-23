//! Mode dispatch confirmation and retry budgets for node 40.
const MODE_BACKOFF_MS = 30 * MIN;

function isModeWrite(item) { return item.role === 'hp' && String(item.dps) === '2'; }
function modeSafety(item) { return item.rule === DHW_ID || item.protection === true; }
function modeIntent(item) { return JSON.stringify([item.rule, item.intent || '', String(item.set)]); }

function modeObservation() {
    const dev = (flow.get('heatPump') || {}).hp;
    return { at: dev?.dpObservedAt?.['2'] || 0, value: dev?.dps?.['2'] };
}

function dhwSilentPaused(d, now) {
    const retry = d.silentRetry;
    if (!retry) return false;
    const obs = modeObservation();
    if (retry.run !== d.run || retry.phase !== d.since || (obs.value === 'mute' && obs.at > retry.sentAt)) {
        d.silentRetry = null;
        return false;
    }
    return now < retry.until;
}

function recordDhwSilentResult(item, sentAt, outcome) {
    const d = context.get('dhw');
    if (d?.state !== 'DHW' || !d.live || d.run !== item.run) return;
    if (outcome === 'confirmed') {
        d.silentRetry = null;
    } else if (item.silentPhase === d.since && d.modeCmd === 'mute') {
        const retry = d.silentRetry;
        const failures = retry?.run === d.run && retry.phase === d.since ? Math.min(6, retry.failures + 1) : 1;
        const wait = failures < 3 ? 0 : Math.min(30, 5 * 2 ** (failures - 3));
        d.silentRetry = { run: d.run, phase: d.since, sentAt, failures, until: Date.now() + wait * MIN };
        if (failures === 3) logEvent({ kind: 'step', rule: DHW_ID, cloud: item.cloud, run: item.run, live: true,
            text: 'mode Silent retry paused after 3 unconfirmed writes; retry waits start at 5 min, then increase to 10, 20 and at most 30 min' });
    } else return;
    context.set('dhw', d);
}

function modeBlocked(item) {
    if (item.rule === DHW_ID && item.silentPhase !== undefined) {
        const d = context.get('dhw');
        if (!d || d.run !== item.run || d.since !== item.silentPhase || !dhwSilentPaused(d, Date.now())) return false;
        // An intentional pause belongs in the automation log, not the DHW warning email.
        logEvent({ kind: 'step', rule: DHW_ID, cloud: item.cloud, run: item.run, live: true,
            text: 'queued mode Silent write dropped (retry paused)' });
        return true;
    }
    if (!isModeWrite(item) || modeSafety(item)) return false;
    const retry = context.get('modeRetry');
    if (!retry) return false;
    if (retry.intent !== modeIntent(item) || (retry.until && Date.now() >= retry.until)) {
        context.set('modeRetry', null);
        return false;
    }
    return retry.until > Date.now();
}

function cancelModeWrite(matches) {
    const active = context.get('activeModeWrite');
    if (active && matches(active)) context.set('activeModeWrite', null);
}

function startModeVerification(item) {
    const sendId = (context.get('modeSendId') || 0) + 1;
    const sentAt = Date.now();
    const wanted = String(item.set);
    const intent = modeIntent(item);
    context.set('modeSendId', sendId);
    context.set('activeModeWrite', { sendId, run: item.run, rule: item.rule, intent: item.intent });
    return () => {
        const obs = modeObservation();
        const superseded = context.get('activeModeWrite')?.sendId !== sendId ||
            (context.get('cancelledShowerRuns') || []).includes(item.run);
        const fresh = obs.at > sentAt;
        const outcome = superseded ? 'superseded' : !fresh ? 'no fresh DP 2' :
            String(obs.value) === wanted ? 'confirmed' : 'fresh mismatch';
        const kind = superseded ? 'stop' : outcome === 'confirmed' ? 'ok' : 'fail';
        if (!superseded) {
            context.set('activeModeWrite', null);
            if (item.rule === DHW_ID && wanted === 'mute' && (item.silentPhase !== undefined || kind === 'ok')) {
                recordDhwSilentResult(item, sentAt, outcome);
            }
            const retry = context.get('modeRetry');
            if (kind === 'ok') {
                if (!modeSafety(item) && retry?.intent === intent) context.set('modeRetry', null);
            } else if (!modeSafety(item)) {
                const failures = (retry?.intent === intent ? retry.failures : 0) + 1;
                context.set('modeRetry', { intent, rule: item.rule, failures,
                    until: failures >= 3 ? Date.now() + MODE_BACKOFF_MS : 0 });
            }
        }
        logEvent({ kind, rule: item.rule, cloud: item.cloud, run: item.run, live: true,
            text: item.text + ' — ' + (superseded ? 'verification superseded' : outcome) +
                (outcome === 'fresh mismatch' ? ', device reports ' + obs.value : ''),
            modeCheck: { sendId, sentAt, device: item.role, dp: '2', wanted, outcome } });
    };
}

function cancelModeRule(rule) {
    cancelModeWrite(active => !rule || active.rule === rule);
    if (!rule || context.get('modeRetry')?.rule === rule) context.set('modeRetry', null);
    if (!rule || rule === DHW_ID) {
        const d = context.get('dhw');
        if (d?.silentRetry) {
            d.silentRetry = null;
            context.set('dhw', d);
        }
    }
}
