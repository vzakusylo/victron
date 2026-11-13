// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `54 Air quality history.js` and the embedded `func` for "Air quality history" in `flows.json`
//   must always stay synchronized.
// Purpose:
// - Backend of the "Air quality" dashboard page (53): reads one day file of the Qingping Air
//   Monitor (written by "Air monitor", 52) and builds the day chart and day statistics.
// Files:
// - /data/home/nodered/grid-control-logs/air/YYYY-MM-DD.csv, line HH:MM:SS,co2,pm25,pm10,tvoc,
//   temperature,humidity (see 52). A reading written twice (after a restart) counts once.
// Input (msg.topic):
// - 'ui'   (page 53) payload { action: 'open' | 'day' | 'refresh', day: 'YYYY-MM-DD' } -> read that day
//          (open: the day shown last, today at first)
// - 'tick' (inject, 2 min) -> read again when today is shown
// - 'read' (exec stdout, msg.day) -> parse, build the model, output 1
// Output (2):
// - output 1 -> ui_template "Air quality page", msg.payload = model
// - output 2 -> exec node "Read air quality day" (`sh -c <payload>`), msg.day
// Model: { day, today, days: [days with a file, newest first], count, first, last,
//   stats: { key: { min, avg, max, last } }, series: { key: [avg of each BUCKET_MIN bucket | null] },
//   bucketMin }
// Change notes:
// 1. Initial version (d#159).
// ==========================

const DIR = '/data/home/nodered/grid-control-logs/air';
const COLS = ['co2', 'pm25', 'pm10', 'tvoc', 'temperature', 'humidity'];
const BUCKET_MIN = 5;
const MIN_READ_GAP_MS = 5000;

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const validDay = (s) => /^\d{4}-\d\d-\d\d$/.test(String(s || ''));
const r1 = (x) => Math.round(x * 10) / 10;

function readCmd(day) {
    // day is checked by validDay, so it is safe in the command
    return "ls -1 " + DIR + " 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\\.csv$'; echo '@@DATA'; cat " + DIR + '/' + day + '.csv 2>/dev/null; true';
}

function build(text, day, today) {
    const [list, data] = String(text || '').split('@@DATA');
    const days = (list || '').split(/\r?\n/).map((s) => s.trim().replace(/\.csv$/, '')).filter(validDay).sort().reverse();
    // one value per second of the day: a reading written twice counts once
    const bySec = new Map();
    for (const line of (data || '').split(/\r?\n/)) {
        const f = line.trim().split(',');
        const m = /^(\d\d):(\d\d):(\d\d)$/.exec(f[0] || '');
        if (!m) continue;
        const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        const row = {};
        COLS.forEach((k, i) => {
            const s = f[i + 1];
            if (s !== undefined && s !== '' && Number.isFinite(Number(s))) row[k] = Number(s);
        });
        bySec.set(sec, row);
    }
    const secs = Array.from(bySec.keys()).sort((a, b) => a - b);
    const n = Math.ceil(1440 / BUCKET_MIN);
    const series = {}, sum = {}, cnt = {}, stats = {};
    COLS.forEach((k) => { sum[k] = new Array(n).fill(0); cnt[k] = new Array(n).fill(0); stats[k] = { min: null, avg: null, max: null, last: null, s: 0, c: 0 }; });
    for (const sec of secs) {
        const row = bySec.get(sec);
        const b = Math.min(n - 1, Math.floor(sec / 60 / BUCKET_MIN));
        for (const k of COLS) {
            if (row[k] === undefined) continue;
            const v = row[k], st = stats[k];
            sum[k][b] += v; cnt[k][b] += 1;
            st.min = st.min === null ? v : Math.min(st.min, v);
            st.max = st.max === null ? v : Math.max(st.max, v);
            st.s += v; st.c += 1; st.last = v;
        }
    }
    COLS.forEach((k) => {
        series[k] = sum[k].map((s, i) => (cnt[k][i] ? r1(s / cnt[k][i]) : null));
        const st = stats[k];
        stats[k] = { min: st.min, avg: st.c ? r1(st.s / st.c) : null, max: st.max, last: st.last };
    });
    const hhmm = (s) => pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60));
    if (!days.includes(today)) days.unshift(today);
    return {
        day, today, days, count: secs.length, bucketMin: BUCKET_MIN,
        first: secs.length ? hhmm(secs[0]) : '', last: secs.length ? hhmm(secs[secs.length - 1]) : '',
        stats, series
    };
}

const now = new Date();
const today = dayOf(now);

if (msg.topic === 'read') {
    const day = validDay(msg.day) ? msg.day : today;
    const model = build(msg.payload, day, today);
    context.set('model', model);
    node.status({ fill: model.count ? 'green' : 'yellow', shape: 'dot', text: day + ': ' + model.count + ' readings' });
    return [{ topic: 'airHistory', payload: model }, null];
}

let day = context.get('day') || today;
if (msg.topic === 'ui') {
    const p = msg.payload || {};
    if ((p.action === 'day' || p.action === 'open') && validDay(p.day)) day = p.day;
} else if (msg.topic === 'tick') {
    if (day !== today && context.get('day')) return null;   // an old day does not change
    day = context.get('day') || today;
} else {
    return null;
}
context.set('day', day);
const lastRead = context.get('lastRead') || 0;
const cached = context.get('model');
if (msg.topic === 'tick' && Date.now() - lastRead < MIN_READ_GAP_MS) return null;
context.set('lastRead', Date.now());
return [msg.topic === 'ui' && cached && cached.day === day ? { topic: 'airHistory', payload: cached } : null, { topic: 'read', day, payload: readCmd(day) }];
