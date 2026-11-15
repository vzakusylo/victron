// Record real, fresh Devices readings, not synthetic samples of sleeping sensors.
const model = msg.payload;
if (!model || !Array.isArray(model.temperatureSensors)) return null;
const dir = '/data/home/nodered/grid-control-logs/temperatures';
const logged = context.get('logged') || {};
const rows = {};
for (const s of model.temperatureSensors) {
    if (!s.online || !Number.isFinite(s.value) || !Number.isFinite(s.t) || s.t <= 0 || s.t > Date.now() + 5000) continue;
    const key = s.t + ':' + s.value;
    if (logged[s.key] === key) continue;
    const d = new Date(s.t);
    const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    (rows[day] = rows[day] || []).push(JSON.stringify(s));
    logged[s.key] = key;
}
context.set('logged', logged);
return [Object.entries(rows).map(([day, lines]) => ({ filename: dir + '/' + day + '.jsonl', payload: lines.join('\n') + '\n' })),
    { filename: dir + '/catalog.json', payload: JSON.stringify({ updated: model.updated, sensors: model.temperatureSensors, motionId: model.motionSensorId || '' }) }];
