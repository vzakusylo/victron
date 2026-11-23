// #include lib/grid/health.js

const clock = () => Number(gridClock.hrtime.bigint() / 1000000n);
const started = clock();
let sampleAt = started;
let publishAt = started;
let pulse;
let heartbeat = {};
let alerts = 0;
let alarmAgeMs = null;
const lag = [];
const intervals = [];

setInterval(() => {
    const now = clock();
    lag.push(Math.max(0, now - sampleAt - 100));
    if (lag.length > 200) lag.shift();
    sampleAt = now;
    const next = flow.get('gridDecisionPulse');
    if (Number.isFinite(next) && next <= now && next !== pulse) {
        if (pulse !== undefined && next > pulse) {
            intervals.push(next - pulse);
            if (intervals.length > 30) intervals.shift();
        }
        pulse = next;
    }
    const ageMs = now - (pulse ?? started);
    const wasSilent = heartbeat.silent;
    heartbeat = gridHeartbeat(heartbeat, pulse ?? started, now);
    if (heartbeat.notify) {
        alerts++;
        alarmAgeMs = ageMs;
        const t = Date.now();
        const date = new Date(t);
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const text = 'grid decision heartbeat silent for 10 s';
        const event = { t, kind: 'fail', rule: 'grid_heartbeat', live: true, text };
        node.send([
            { topic: 'log', filename: `/data/home/nodered/grid-control-logs/automations/${day}.jsonl`,
                event, payload: JSON.stringify(event) + '\n' },
            { notification: { title: 'Grid control', type: 'alarm', message: text }, payload: text }
        ]);
    }
    if (now < publishAt && wasSilent === heartbeat.silent && !heartbeat.notify) return;
    publishAt = now + 1000;
    const lagP95Ms = gridP95(lag);
    const intervalP95Ms = gridP95(intervals);
    const silent = heartbeat.silent;
    const health = { ageMs, lagP95Ms, intervalP95Ms, silent, alerts, alarmAgeMs };
    context.set('gridLoopHealth', health);
    flow.set('gridLoopHealth', health);
    node.status({ fill: silent ? 'red' : lagP95Ms >= 100 ? 'yellow' : 'green', shape: 'dot',
        text: `${silent ? 'SILENT' : 'Grid loop'} ${(ageMs / 1000).toFixed(1)} s ago / p95 interval ${intervalP95Ms ?? '-'} ms / lag ${lagP95Ms} ms` });
}, 100);
