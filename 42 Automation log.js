// #libs [{"var":"fs","module":"fs"}]
// #no-template-replay ["Automation log page"]
// #bypass-exec ["Read automation log"]
// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `42 Automation log.js` and the embedded `func` for "Automation log" in `flows.json`
//   must always stay synchronized.
// Purpose:
// - Backend of the "Automation log" dashboard page (43): reads the day files written by
//   "Heat pump automations" (40) and groups the events like the Smart Life log — one entry per
//   rule run (start, steps, write results, end) plus single events (settings, flag, warnings).
// Files:
// - /data/home/nodered/grid-control-logs/automations/YYYY-MM-DD.jsonl, one JSON event per line:
//   { t, kind, text, rule?, cloud?, run?, live? }
//   kinds: test / start (rule run begins), dry / write / step (steps), ok / fail (write checked
//   against the device), done / stop (run ends), flag, setting, warn, info.
// Input (msg.topic):
// - 'ui'   (page 43)  -> payload { action: 'open' | 'day' | 'refresh', day: 'YYYY-MM-DD' }
// - 'log'  (from 40)  -> msg.event = a new event; added live when the page shows today
// Output:
// - output 1 -> ui_template "Automation log page", msg.log = page model
// Retention: day files older than KEEP_DAYS are deleted when the page reads a day.
// Change notes:
// 1. Initial version (d#126).
// 2. d#127: the shell script is quoted as one word for `sh -c` (the day file was never read);
//    day files older than KEEP_DAYS are deleted.
// 3. Stream the selected log and count lines only for days the selector can show.
// ==========================
// #include lib/history/lines.js

const DIR = '/data/home/nodered/grid-control-logs/automations';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 90;
const KEEP_DAYS = 400;

function pad(x) { return String(x).padStart(2, '0'); }
function dayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
const today = dayKey(Date.now());

async function readDay(day) {
    const events = [];
    let bad = 0;
    for await (const { line } of historyLines(await openHistoryFile(`${DIR}/${day}.jsonl`))) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line);
            if (event && typeof event === 'object' && Number.isFinite(event.t)) events.push(event);
            else bad++;
        } catch (error) { bad++; }
    }
    events.sort((a, b) => a.t - b.t);
    const files = new Map();
    for (const entry of await historyNames(DIR)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filename = `${DIR}/${entry.name}`;
        let stat;
        try { stat = await fs.promises.stat(filename); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (Date.now() - stat.mtimeMs >= (KEEP_DAYS + 1) * 86400000) {
            try { await fs.promises.unlink(filename); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else if (DAY_RE.test(entry.name.slice(0, -6))) files.set(entry.name, stat);
    }
    const days = [];
    const cached = context.get('dayCounts') || {};
    const dayCounts = {};
    for (const name of [...files.keys()].sort().slice(-MAX_DAYS)) {
        const key = name.slice(0, -6);
        const { mtimeMs, size } = files.get(name);
        const previous = cached[key];
        if (key !== today && previous?.mtimeMs === mtimeMs && previous.size === size) {
            dayCounts[key] = previous;
            days.push({ day: key, count: previous.count });
            continue;
        }
        const file = await openHistoryFile(`${DIR}/${name}`);
        if (!file) continue;
        let count = 0;
        for await (const { newline } of historyLines(file)) if (newline) count++;
        if (key !== today) dayCounts[key] = { mtimeMs, size, count };
        days.push({ day: key, count });
    }
    if (day !== (context.get('day') || today)) return null;
    context.set('events', events);
    context.set('days', days);
    context.set('dayCounts', dayCounts);
    context.set('loaded', day);
    node.status({ fill: 'green', shape: 'dot', text: day + ': ' + events.length + ' events' + (bad ? ', ' + bad + ' bad lines' : '') });
    return page(bad ? bad + ' unreadable lines skipped' : '');
}

// Group events (oldest first) into items, newest first.
function build(events) {
    const runs = {};
    const items = [];
    for (const e of events) {
        if (e.run) {
            let it = runs[e.run];
            if (!it) {
                it = { type: 'run', run: e.run, t: e.t, rule: e.rule, cloud: e.cloud || e.rule, live: !!e.live, steps: [] };
                runs[e.run] = it; items.push(it);
            }
            if (e.kind === 'setting') continue;
            it.steps.push({ t: e.t, kind: e.kind, text: e.text });
            it.last = e.t;
        } else {
            items.push({ type: 'event', t: e.t, kind: e.kind, text: e.text, cloud: e.cloud || '' });
        }
    }
    for (const it of items) if (it.type === 'run') {
        const k = it.steps.map((s) => s.kind);
        const fails = k.filter((x) => x === 'fail').length;
        const oks = k.filter((x) => x === 'ok').length;
        it.fails = fails; it.oks = oks;
        if (k.includes('stop')) it.status = 'stopped';
        else if (fails) it.status = 'failed';
        else if (!it.live) it.status = k.includes('done') ? 'test' : 'test running';
        else it.status = k.includes('done') ? 'ok' : 'running';
        const first = it.steps[0];
        it.summary = first ? first.text : '';
    }
    items.sort((a, b) => b.t - a.t);
    return items;
}
function counts(items) {
    const c = { runs: 0, ok: 0, failed: 0, test: 0, events: 0, errors: 0 };
    for (const it of items) {
        if (it.type !== 'run') { c.events++; if (it.kind === 'error' || it.kind === 'fail') c.errors++; continue; }
        c.runs++;
        if (it.status === 'failed' || it.status === 'stopped') c.failed++;
        else if (it.status === 'ok' || it.status === 'running') c.ok++;
        else c.test++;
    }
    return c;
}
function model(note) {
    const day = context.get('day') || today;
    const events = context.get('events') || [];
    const items = build(events);
    const days = (context.get('days') || []).slice();
    if (!days.find((d) => d.day === today)) days.push({ day: today, count: 0 });
    days.sort((a, b) => (a.day < b.day ? 1 : -1));
    return { day, today, isToday: day === today, items, counts: counts(items), days, note: note || '', updated: Date.now() };
}

function page(note) {
    // Dashboard stores msg.payload even without replay; this page requests its full model on open.
    return [{ payload: null, log: model(note) }, null];
}

// ---- page request ---------------------------------------------------------------
if (msg.topic === 'ui') {
    const p = msg.payload || {};
    let day = context.get('day') || today;
    if (p.action === 'open') day = today;
    if (p.action === 'day') {
        if (!DAY_RE.test(String(p.day || ''))) { node.warn('Automation log: bad day ' + JSON.stringify(p.day)); return null; }
        day = p.day;
    }
    context.set('day', day);
    return readDay(day).catch(error => { node.error('Automation log: ' + error.message, msg); return null; });
}

// ---- live event from "Heat pump automations" ---------------------------------------
if (msg.topic === 'log' && msg.event) {
    const e = msg.event;
    const day = dayKey(e.t);
    const days = context.get('days') || [];
    const d = days.find((x) => x.day === day);
    if (d) d.count++; else days.push({ day, count: 1 });
    context.set('days', days);
    if ((context.get('day') || today) !== day || context.get('loaded') !== day) return null;
    const events = context.get('events') || [];
    events.push(e);
    context.set('events', events);
    return page();
}
return null;
