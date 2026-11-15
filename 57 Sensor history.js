// Read-only backend for the Temperatures page. Tools and logs remain on the GX.
const p = msg.payload || {};
if (msg.topic === 'read') {
    try {
        const model = JSON.parse(Buffer.isBuffer(msg.payload) ? msg.payload.toString('utf8') : msg.payload);
        if (model.error) node.warn('Sensor history: ' + model.error);
        return [{ topic: 'sensorHistory', payload: model }, null];
    } catch (e) {
        node.warn('Sensor history returned invalid JSON: ' + e.message);
        return [{ topic: 'sensorHistory', payload: { error: 'Cannot read sensor history; see Node-RED log.' } }, null];
    }
}
const now = new Date();
const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
const day = String(p.day || today);
const dt = new Date(day + 'T00:00:00Z');
if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(dt.getTime()) || dt.toISOString().slice(0, 10) !== day) {
    node.warn('Sensor history: invalid day');
    return [{ topic: 'sensorHistory', payload: { error: 'Invalid calendar day.' } }, null];
}
return [null, { topic: 'read', day, payload: '--day ' + day }];
