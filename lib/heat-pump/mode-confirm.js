//! Mode dispatch confirmation and non-safety retry budget for node 40.
const MODE_BACKOFF_MS = 30 * MIN;

function isModeWrite(item) { return item.role === 'hp' && String(item.dps) === '2'; }
function modeSafety(item) { return item.rule === DHW_ID || item.protection === true; }
function modeIntent(item) { return JSON.stringify([item.rule, item.intent || '', String(item.set)]); }

function modeObservation() {
    const dev = (flow.get('heatPump') || {}).hp;
    return { at: dev?.dpObservedAt?.['2'] || 0, value: dev?.dps?.['2'] };
}

function modeBlocked(item) {
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
}
