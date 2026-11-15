// Record real, fresh Devices readings, not synthetic samples of sleeping sensors.
const model = msg.payload;
if (!model || !Array.isArray(model.temperatureSensors)) return null;
const dir = '/data/home/nodered/grid-control-logs/temperatures';
const logged = context.get('logged') || {};
const rows = {};
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (t) => {
    const p = Object.fromEntries(clock.formatToParts(t).map((p) => [p.type, p.value]));
    return p.year + '-' + p.month + '-' + p.day;
};
for (const s of model.temperatureSensors) {
    if (!s || typeof s.key !== 'string' || !s.online || !Number.isFinite(s.value) || !Number.isFinite(s.t) || s.t <= 0 || s.t > Date.now() + 5000) continue;
    if (s.key.startsWith('hp:') || s.key.startsWith('air-monitor:') || ['acc:Temperature', 'plate:Temperature'].includes(s.key)) continue;
    const key = s.t + ':' + s.value;
    if (logged[s.key] === key) continue;
    const day = dayOf(s.t);
    (rows[day] = rows[day] || []).push(JSON.stringify({ key: s.key, t: s.t, value: s.value }));
    logged[s.key] = key;
}
context.set('logged', logged);
const today = dayOf(Date.now());
const cleanup = context.get('pruneDay') === today ? null : { topic: 'prune', payload: '--prune' };
if (cleanup) context.set('pruneDay', today);
return [Object.entries(rows).map(([day, lines]) => ({ filename: dir + '/' + day + '.jsonl', payload: lines.join('\n') + '\n' })),
    { filename: dir + '/catalog.json', payload: JSON.stringify({ updated: model.updated, sensors: model.temperatureSensors, motionId: model.motionSensorId || '' }) }, cleanup];
