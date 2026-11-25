//! @shared
//! Attribution is observational: a post-dispatch matching report explains a change, but does not prove its origin.
const hpAttribution = (() => {
    const key = 'hpWriteAttribution';
    const labels = { 2: 'DP 2 (mode)', 121: 'DP 121 (hysteresis)', 132: 'P22', 133: 'P23', 134: 'P24' };
    const outside = 'outside Node-RED (app / cloud / pump)';
    const maxEvents = 49; // Leave room for an overflow line in the existing 50-line digest.
    const state = () => flow.get(key) || { dps: {}, events: [] };
    function normalize(dp, value) {
        if (dp === '2') return typeof value === 'string' && value.trim() ? value : null;
        if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? String(n) : null;
    }
    function pending(record, at) { return (record.pending || []).filter(w => at <= w.until); }
    function writer(item) {
        return item.shadow?.writer || (item.curveGroup ? 'owner' : item.intent === 'kick' ? 'kick'
            : item.protection ? 'protection' : item.rule || 'unknown');
    }
    function sent(item, at, until) {
        if (item.role !== 'hp') return null;
        const values = item.curveGroup || { [item.dps]: item.set };
        const tagged = Object.entries(values).filter(([dp]) => Object.hasOwn(labels, dp));
        if (!tagged.length) return null;
        const s = state(), source = writer(item);
        for (const [dp, value] of tagged) {
            const record = s.dps[dp] || (s.dps[dp] = {});
            record.pending = pending(record, at);
            record.pending.push({ value: normalize(dp, value), at, until, writer: source,
                curveWriter: item.curveWriter, parts: item.curveParts });
        }
        flow.set(key, s);
        return { writer: source, values: Object.fromEntries(tagged) };
    }
    function observe(dps, previous, at, onCurve = () => {}) {
        const s = state();
        let updated = false;
        for (const [dp, raw] of Object.entries(dps)) {
            if (!Object.hasOwn(labels, dp)) continue;
            const value = normalize(dp, raw);
            if (value === null) continue;
            const record = s.dps[dp] || (s.dps[dp] = {});
            const old = record.value ?? normalize(dp, previous[dp]);
            let match;
            record.pending = pending(record, at).filter(w => {
                if (w.at >= at || w.value !== value) return true;
                match = w;
                return false;
            });
            // A repeat observation can confirm a SET but cannot change the last writer.
            if (value !== old && old !== null) {
                record.lastWriter = match ? match.writer : outside;
                if (dp === '133' || dp === '134') {
                    const source = match?.curveWriter || ({ owner: 'owner (dashboard)', heat: 'heating controller',
                        dhw: 'DHW', recovery: 'restore' })[record.lastWriter] || record.lastWriter;
                    onCurve(at, Number(dp), Number(old), Number(value), source, match?.parts);
                }
                if (!match) {
                    if (s.events.length >= maxEvents) {
                        const dropped = s.events.shift();
                        const overflow = s.overflow || (s.overflow = { count: 0, t: dropped.t });
                        overflow.count++;
                    }
                    s.events.push({ kind: 'warn', rule: 'hp_external_change', live: true, t: at,
                        dp, old, value, writer: outside, text: `${labels[dp]} changed ${old} → ${value} — changed ${outside}` });
                }
            }
            record.value = value;
            updated = true;
        }
        if (updated) flow.set(key, s);
    }
    function drain() {
        const { dps, events, overflow } = state();
        if (overflow) events.unshift({ kind: 'warn', rule: 'hp_external_change', live: true, t: overflow.t,
            text: `Heat pump attribution backlog overflow: omitted ${overflow.count} earlier changes before the automation tick` });
        if (events.length) flow.set(key, { dps, events: [] });
        return events;
    }
    function mismatch(item, dp) {
        if (item.role !== 'hp' || !Object.hasOwn(labels, dp)) return '';
        const last = state().dps[dp]?.lastWriter || 'unknown';
        return ` (requesting writer: ${writer(item)}; last writer: ${last})`;
    }
    return { sent, observe, drain, mismatch };
})();
