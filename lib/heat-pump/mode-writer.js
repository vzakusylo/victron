//! Enforced DP 2 ownership in node 40; curve and hysteresis remain shadow-only.
function tagWrite(item, writer, at) {
    const tagged = shadowTag(item, writer, at);
    if (!isModeWrite(item)) return tagged;
    const lease = context.get('hpModeLease');
    const priority = hpArbiter.priorityOf(writer);
    if (priority < 0) {
        node.warn('Unknown DP 2 writer: ' + writer);
        return { ...tagged, modeRejection: 'unknown writer' };
    }
    if (lease && at < lease.until && priority < lease.priority) {
        return { ...tagged, modeRejection: 'lower priority at enqueue' };
    }
    const generation = (lease?.generation || 0) + 1;
    context.set('hpModeLease', {
        writer, priority, generation, until: at + hpArbiter.leaseMs, rule: item.rule, run: item.run
    });
    return { ...tagged, modeGeneration: generation };
}

function modeLeaseProblem(item, at) {
    if (!isModeWrite(item)) return null;
    if (item.modeRejection) return item.modeRejection;
    if (item.modeGeneration === undefined) return 'unclaimed mode request';
    const lease = context.get('hpModeLease');
    if (!lease || lease.generation !== item.modeGeneration) return 'superseded generation';
    return at >= lease.until ? 'expired lease' : null;
}

function cancelModeLease(matches) {
    const lease = context.get('hpModeLease');
    if (lease && matches(lease)) context.set('hpModeLease', { ...lease, until: 0 });
}
