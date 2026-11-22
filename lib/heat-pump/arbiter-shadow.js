//! @shared
//! Observes live SETs in nodes 37 and 40. Decisions never gate dispatch or read-back.
const HP_SHADOW_KEY = 'hpWriterShadow';

function shadowTag(item, writer, now) {
    const key = hpArbiter.resource(item.role, item.dps);
    if (!key) return item;
    try {
        const st = flow.get(HP_SHADOW_KEY) || {};
        // All curve coefficients queued by one writer/run in a tick are one intent.
        const intent = JSON.stringify([item.run, now, key === 'curve' ? null : item.set]);
        const { state, token } = hpArbiter.claim(st.owners || {}, key, writer, intent, now);
        flow.set(HP_SHADOW_KEY, { ...st, owners: state });
        return { ...item, shadow: { key, token, writer } };
    } catch (e) {
        node.warn('HP shadow claim: ' + e.message);
        return item;
    }
}

function shadowCheck(item, phase, now) {
    if (!item.shadow || (phase === 'verify' && item.shadow.token === null)) return;
    try {
        const { key, token, writer } = item.shadow;
        const st = flow.get(HP_SHADOW_KEY) || {}, owners = st.owners || {};
        const why = hpArbiter.check(owners, key, token, now);
        if (!why) return;
        const owner = owners[key];
        if (why === 'superseded generation' && owner?.writer === writer) {
            flow.set(HP_SHADOW_KEY, { ...st, sameWriterSupersessions: (st.sameWriterSupersessions || 0) + 1 });
            return;
        }
        const bucket = key + ':' + phase;
        const lastLog = st.lastLog || {};
        const log = lastLog[bucket] === undefined || now - lastLog[bucket] >= 60000;
        if (log) lastLog[bucket] = now;
        flow.set(HP_SHADOW_KEY, { ...st, lastLog, disagreements: (st.disagreements || 0) + 1 });
        if (log) {
            node.log(`HP shadow ${phase} ${key} DP ${item.dps}=${item.set} ${writer}@${token ?? '-'} vs ${owner?.writer ?? '-'}@${owner?.version ?? '-'}: ${why}`);
        }
    } catch (e) {
        node.warn('HP shadow check: ' + e.message);
    }
}
