//! @shared
const hpCurveLog = (() => {
    const file = '/data/home/nodered/heat-pump-curve-changes.jsonl';
    const key = 'hpCurveChanges';
    const segmentSize = 1000;
    const maxCurrent = 2 * segmentSize;
    const readBackoff = 5 * 60000;
    const storage = typeof fs === 'undefined' ? null : fs;
    function read(path, limit) {
        let text;
        try { text = storage.readFileSync(path, 'utf8'); }
        catch (error) {
            if (error.code === 'ENOENT') return { rows: [], length: 0 };
            throw error;
        }
        const lines = text.split('\n').filter(Boolean);
        const rows = [];
        let invalid = 0;
        for (const line of lines.slice(-limit)) {
            try {
                const row = JSON.parse(line);
                if (typeof row?.time === 'string' && typeof row.writer === 'string') rows.push(row);
                else invalid++;
            }
            catch { invalid++; }
        }
        if (invalid) node.warn('Heat pump curve log: ignored ' + invalid + ' invalid JSON lines');
        return { rows, length: lines.length };
    }
    function state(at) {
        const cached = flow.get(key);
        if (cached && (!cached.retryAt || at < cached.retryAt)) return cached;
        let result;
        try {
            const previous = storage ? read(file + '.1', segmentSize).rows : [];
            const current = storage ? read(file, maxCurrent) : { rows: [], length: 0 };
            result = { rows: [...previous, ...current.rows].slice(-maxCurrent), length: current.length };
        } catch (error) {
            node.warn('Heat pump curve log read failed: ' + error.message);
            result = { retryAt: at + readBackoff };
        }
        flow.set(key, result);
        return result;
    }
    function append(at, dp, old, value, writer, parts) {
        try {
            const s = state(at);
            if (s.retryAt) return;
            const oslo = new Date(at).toLocaleString('sv-SE', {
                timeZone: 'Europe/Oslo', dateStyle: 'short', timeStyle: 'medium'
            });
            const entry = { time: new Date(at).toISOString(), oslo,
                dp, old, new: value, writer, ...(parts && { parts }) };
            const line = JSON.stringify(entry) + '\n';
            if (s.length >= segmentSize && (!s.renameFailed || s.length >= maxCurrent)) {
                try {
                    if (storage) storage.renameSync(file, file + '.1');
                    s.rows = s.rows.slice(-segmentSize);
                    s.length = 0;
                    s.renameFailed = false;
                } catch (error) {
                    if (!s.renameFailed) node.warn('Heat pump curve log rotation failed: ' + error.message);
                    s.renameFailed = true;
                }
                flow.set(key, s);
            }
            if (s.length >= maxCurrent) {
                // Rotation can be denied even when the current file is writable.
                const rows = s.rows.slice(-segmentSize);
                storage.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join('') + line);
                s.rows = [...rows, entry];
                s.length = s.rows.length;
            } else {
                if (storage) storage.appendFileSync(file, line, { mode: 0o644 });
                s.length++;
                s.rows.push(entry);
                if (s.rows.length > maxCurrent) s.rows.shift();
            }
            flow.set(key, s);
        } catch (error) { node.warn('Heat pump curve log write failed: ' + error.message); }
    }
    function view(at) {
        const { rows } = state(at), counts = {};
        if (!rows) return { recent: [], counts, error: 'Curve log unavailable' };
        for (const row of rows) {
            const age = at - Date.parse(row.time);
            if (age >= 0 && age < 86400000) counts[row.writer] = (counts[row.writer] || 0) + 1;
        }
        return { recent: rows.slice(-50).reverse(), counts };
    }
    function recent(limit, at) {
        return state(at).rows?.slice(-limit).reverse() ?? null;
    }
    return { append, view, recent };
})();
