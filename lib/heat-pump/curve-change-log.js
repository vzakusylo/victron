//! @shared
const hpCurveLog = (() => {
    const file = '/data/home/nodered/heat-pump-curve-changes.jsonl';
    const key = 'hpCurveChanges';
    const segmentSize = 1000;
    const storage = typeof fs === 'undefined' ? null : fs;
    function read(path) {
        let text;
        try { text = storage.readFileSync(path, 'utf8'); }
        catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
        const rows = [];
        for (const line of text.split('\n').filter(Boolean)) {
            try { rows.push(JSON.parse(line)); }
            catch { node.warn('Heat pump curve log: ignored an invalid JSON line'); }
        }
        return rows.slice(-segmentSize);
    }
    function state() {
        const cached = flow.get(key);
        if (cached) return cached;
        const previous = storage ? read(file + '.1') : [];
        const current = storage ? read(file) : [];
        const result = { rows: [...previous, ...current], length: current.length };
        flow.set(key, result);
        return result;
    }
    function append(at, dp, old, value, writer, parts) {
        try {
            const s = state();
            const oslo = new Date(at).toLocaleString('sv-SE', {
                timeZone: 'Europe/Oslo', dateStyle: 'short', timeStyle: 'medium'
            });
            const entry = { time: new Date(at).toISOString(), oslo,
                dp, old, new: value, writer, ...(parts && { parts }) };
            const line = JSON.stringify(entry) + '\n';
            if (s.length >= segmentSize) {
                if (storage) storage.renameSync(file, file + '.1');
                s.rows = s.rows.slice(-segmentSize);
                s.length = 0;
            }
            if (storage) storage.appendFileSync(file, line, { mode: 0o644 });
            s.length++;
            s.rows.push(entry);
            flow.set(key, s);
        } catch (error) { node.warn('Heat pump curve log write failed: ' + error.message); }
    }
    function view(at) {
        try {
            const { rows } = state(), counts = {};
            for (const row of rows) {
                const age = at - Date.parse(row.time);
                if (age >= 0 && age < 86400000) counts[row.writer] = (counts[row.writer] || 0) + 1;
            }
            return { recent: rows.slice(-50).reverse(), counts };
        } catch (error) {
            node.warn('Heat pump curve log read failed: ' + error.message);
            return { recent: [], counts: {}, error: 'Curve log unavailable' };
        }
    }
    function recent(limit) {
        try { return state().rows.slice(-limit).reverse(); }
        catch (error) {
            node.warn('Heat pump curve log read failed: ' + error.message);
            return null;
        }
    }
    return { append, view, recent };
})();
