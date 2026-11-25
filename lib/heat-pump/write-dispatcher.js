//! The node 40 dispatcher uses independent leases for mode, the curve group and hysteresis.
const HP_LEASE_KEYS = { mode: 'hpModeLease', curve: 'hpCurveLease', hysteresis: 'hpHysteresisLease' };
const writeResource = item => hpArbiter.resource(item.role, item.dps);
const writeLeaseLive = (lease, at) => !!lease && (lease.until === null || at < lease.until);

function tagWrite(item, writer, at) {
    return tagWriteGroup([item], writer, at)[0];
}

function tagWriteGroup(items, writer, at, until = at + hpArbiter.leaseMs) {
    const resource = writeResource(items[0]);
    if (!resource) return items;
    const key = HP_LEASE_KEYS[resource];
    const lease = context.get(key);
    const priority = hpArbiter.priorityOf(writer);
    const reject = reason => items.map(item => ({ ...item, writeRejection: reason }));
    if (items.some(item => writeResource(item) !== resource)) {
        node.warn('Cannot share one heat-pump lease across different resources');
        return reject('mixed write resources');
    }
    if (priority < 0) {
        node.warn('Unknown heat-pump writer: ' + writer);
        return reject('unknown writer');
    }
    if (writeLeaseLive(lease, at) && priority < lease.priority) {
        return reject('lower priority at enqueue');
    }
    const generation = (lease?.generation || 0) + 1;
    // Automatic curve leases run on the same elapsed-time timers as paced SETs,
    // not the wall clock (which can jump or advance faster than the write queue).
    const timerBound = resource === 'curve' && writer !== 'owner';
    context.set(key, {
        writer, priority, generation, until: timerBound ? null : until, rule: items[0].rule, run: items[0].run
    });
    if (timerBound) setTimeout(() => {
        cancelWriteLease(resource, active => active.generation === generation);
    }, hpArbiter.leaseMs);
    return items.map(item => ({ ...shadowTag(item, writer, at), modeGeneration: generation }));
}

function writeLeaseProblem(item, at) {
    const resource = writeResource(item);
    if (!resource) return null;
    if (item.writeRejection) return item.writeRejection;
    if (item.modeGeneration === undefined) return 'unclaimed ' + resource + ' request';
    const lease = context.get(HP_LEASE_KEYS[resource]);
    if (!lease || lease.generation !== item.modeGeneration) return 'superseded generation';
    return writeLeaseLive(lease, at) ? null : 'expired lease';
}

function cancelWriteLease(resource, matches) {
    const key = HP_LEASE_KEYS[resource];
    const lease = context.get(key);
    if (lease && matches(lease)) context.set(key, { ...lease, until: 0 });
}

function cancelModeLease(matches) {
    cancelWriteLease('mode', matches);
}

function enqueueCurveGroup(steps, spec, writer, at, describe = step => step.text) {
    if (!steps.length) return true;
    const q = context.get('queue') || [];
    const items = tagWriteGroup(steps.map(step => ({ ...step, ...spec })), writer, at);
    if (items[0].writeRejection) {
        logEvent({ kind: 'step', rule: spec.rule, cloud: spec.cloud, run: spec.run, live: true,
            text: items.map(step => step.text).join(' / ') + ' dropped (' + items[0].writeRejection + ')' });
        return false;
    }
    if (spec.curveChange) items[items.length - 1].commitCurve = true;
    // Keep the existing wire order and pacing; a new generation invalidates all unsent members.
    q.push(...items);
    context.set('queue', q);
    for (const step of items) logEvent({ kind: 'write', rule: spec.rule, cloud: spec.cloud,
        run: spec.run, live: true, text: describe(step) });
    pump();
    return true;
}
