'use strict';

const DEVICES = Object.freeze({
    'hp-tuya-pump-01': 'pump',
    'hp-tuya-valve-01': 'valve',
    'hp-tuya-bypass-01': 'bypass',
    'hp-tuya-meter-01': 'meter',
});

function proxySource(device, deviceId, deviceName) {
    return `const base = ${JSON.stringify('tuya/' + device)};
const p = typeof msg.payload === 'string' || Buffer.isBuffer(msg.payload) ? JSON.parse(msg.payload.toString()) : msg.payload;
if (msg.topic === base + '/data') {
    if (!p || typeof p.dps !== 'object' || !p.dps || Array.isArray(p.dps)) { node.error('Invalid Tuya data envelope', msg); return null; }
    return [{ payload: { data: p, deviceId: ${JSON.stringify(deviceId)}, deviceName: ${JSON.stringify(deviceName)} } }, null, null];
}
if (msg.topic === base + '/state') {
    if (!p || !['CONNECTING', 'CONNECTED', 'DISCONNECTED', 'ERROR'].includes(p.state)) { node.error('Invalid Tuya state envelope', msg); return null; }
    return [null, { payload: p }, null];
}
if (!p || typeof p !== 'object' || Array.isArray(p)) { node.error('Invalid Tuya command', msg); return null; }
const operation = p.operation || 'SET';
if (!['GET', 'SET', 'REFRESH'].includes(operation)) { node.error('Unsupported test GX Tuya operation: ' + operation, msg); return null; }
return [null, null, { topic: base + '/command', payload: JSON.stringify(Object.assign({}, p, { operation })) }];`;
}

function transformTuya(flows, registry = {}) {
    const result = structuredClone(flows);
    const transformed = [];
    const occupied = new Set(result.map(n => n.id));
    if (occupied.size !== result.length) throw new Error('Duplicate node IDs before Tuya transformation');
    const broker = result.find(n => n.type === 'mqtt-broker' && n.broker === 'mosquitto' && String(n.port) === '1883' && !n.usetls);
    const add = (n, device) => {
        if (occupied.has(n.id)) throw new Error('Tuya generated ID collision: ' + n.id);
        occupied.add(n.id);
        result.push(n);
        transformed.push({ id: n.id, type: n.type, device });
    };
    for (let i = 0; i < flows.length; i++) {
        const n = flows[i];
        if (n.type !== 'tuya-smart-device') continue;
        const device = DEVICES[n.id];
        if (!device) throw new Error('Unmodelled tuya-smart-device: ' + n.id);
        if (!broker) throw new Error('Tuya proxy requires the sanitized mosquitto:1883 broker');
        const deviceId = registry[n.id]?.deviceId || n.deviceId;
        if (typeof deviceId !== 'string' || !deviceId || deviceId.includes('${')) throw new Error('Unresolved sanitized Tuya deviceId: ' + n.id);
        if (!Array.isArray(n.wires) || n.wires.length !== 2) throw new Error('Tuya proxy requires two original outputs: ' + n.id);
        const outputId = n.id + '-mqtt-out';
        const proxy = {
            id: n.id, type: 'function', z: n.z, name: 'Tuya proxy (test GX): ' + device,
            func: proxySource(device, deviceId, n.deviceName || n.name || device),
            outputs: 3, noerr: 0, initialize: '', finalize: '', libs: [],
            x: n.x, y: n.y, wires: [...structuredClone(n.wires), [outputId]],
        };
        if (n.d !== undefined) proxy.d = n.d;
        if (n.g !== undefined) proxy.g = n.g;
        result[i] = proxy;
        transformed.push({ id: n.id, from: n.type, type: 'function', device });
        for (const kind of ['data', 'state']) {
            add({
                id: n.id + '-mqtt-' + kind, type: 'mqtt in', z: n.z,
                name: 'Tuya ' + device + ' ' + kind, topic: 'tuya/' + device + '/' + kind,
                qos: '1', datatype: 'json', broker: broker.id, nl: false, rap: true, rh: 0,
                x: (n.x || 0) - 220, y: (n.y || 0) + (kind === 'data' ? -20 : 20), wires: [[n.id]],
            }, device);
        }
        add({
            id: outputId, type: 'mqtt out', z: n.z, name: 'Tuya ' + device + ' command',
            topic: 'tuya/' + device + '/command', qos: '1', retain: 'false',
            broker: broker.id, x: (n.x || 0) + 220, y: n.y, wires: [],
        }, device);
    }
    if (result.some(n => n.type === 'tuya-smart-device')) throw new Error('Active tuya-smart-device survived transformation');
    return { flows: result, transformed };
}

module.exports = { DEVICES, transformTuya };
