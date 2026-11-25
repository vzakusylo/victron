//! @shared
//! Pure ownership decisions for the heat pump SET queue in node 40.
const hpArbiter = (() => {
    const priorities = ['owner', 'heat', 'kick', 'recovery', 'dhw', 'protection'];
    const leaseMs = 60000; // Short write-intent lease, not ownership for a whole heating/DHW cycle.

    function resource(role, dp) {
        if (role !== 'hp') return null;
        switch (String(dp)) {
        case '2': return 'mode';
        case '132': case '133': case '134': return 'curve';
        case '121': return 'hysteresis';
        default: return null;
        }
    }

    function claim(state, key, writer, intent, now) {
        const owner = state[key], active = owner && now < owner.until;
        const priority = priorities.indexOf(writer);
        if (priority < 0) throw new Error('Unknown heat-pump writer: ' + writer);
        if (active && priority < priorities.indexOf(owner.writer)) return { state, token: null };
        const sameIntent = active && owner.writer === writer && owner.intent === intent;
        const version = sameIntent ? owner.version : (owner?.version || 0) + 1;
        return { state: { ...state, [key]: { writer, intent, version, until: now + leaseMs } }, token: version };
    }

    function check(state, key, token, now) {
        const owner = state[key];
        if (token === null) return 'lower priority at enqueue';
        if (!owner || owner.version !== token) return 'superseded generation';
        if (now >= owner.until) return 'expired lease';
        return null;
    }

    return { resource, claim, check, priorityOf: writer => priorities.indexOf(writer), leaseMs };
})();

if (typeof module !== 'undefined') module.exports = hpArbiter;
