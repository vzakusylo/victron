//! @shared
//! Attribution is observational: a post-dispatch matching report explains a change, but does not prove its origin.
const hpAttribution = (() => {
    const key = 'hpWriteAttribution';
    const labels = { 2: 'DP 2 (mode)', 121: 'DP 121 (hysteresis)', 132: 'P22', 133: 'P23', 134: 'P24' };
    const outside = 'outside Node-RED (app / cloud / pump)';
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
            : item.protection ? 'protection' : item.rule === 'dhw' ? 'dhw' : item.rule === 'heat' ? 'heat' : 'recovery');
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
            record.pending.push({ value: normalize(dp, value), at, until, writer: source });
        }
        flow.set(key, s);
        return { writer: source, values: Object.fromEntries(tagged) };
    }
    function observe(dps, previous, at) {
        const s = state();
        let updated = false;
        for (const [dp, raw] of Object.entries(dps)) {
            if (!Object.hasOwn(labels, dp)) continue;
            const value = normalize(dp, raw);
            if (value === null) continue;
            const record = s.dps[dp] || (s.dps[dp] = {});
            const old = record.value ?? normalize(dp, previous[dp]);
            const live = pending(record, at);
            const matches = w => w.at < at && w.value === value;
            const match = live.findLast(matches);
            // A repeat observation can confirm a SET but cannot change the last writer.
            if (value !== old && old !== null) {
                record.lastWriter = match ? match.writer : outside;
                if (!match) s.events.push({ kind: 'warn', rule: 'hp_external_change', live: true, t: at,
                    dp, old, value, writer: outside, text: `${labels[dp]} changed ${old} → ${value} — changed ${outside}` });
            }
            record.pending = match ? live.filter(w => !matches(w)) : live;
            record.value = value;
            updated = true;
        }
        if (updated) flow.set(key, s);
    }
    function drain() {
        const s = state(), events = s.events;
        if (events.length) flow.set(key, { ...s, events: [] });
        return events;
    }
    function mismatch(item, dp) {
        if (item.role !== 'hp' || !Object.hasOwn(labels, dp)) return '';
        const last = state().dps[dp]?.lastWriter || 'unknown';
        return ` (requesting writer: ${writer(item)}; last writer: ${last})`;
    }
    return { sent, observe, drain, mismatch };
})();
