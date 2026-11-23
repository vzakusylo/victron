// Dashboard 1.x supplies the tab name and socket ID on change, and the ID on lost.
const tabs = ['Heat Pump', 'Heat Pump data'];
const viewers = context.get('viewers') || {};
const socket = typeof msg.socketid === 'string' && msg.socketid ? `socket:${msg.socketid}` : null;
const event = msg.payload;
let model;
let audience;

if (socket && typeof event === 'string') {
    if (event === 'lost' || event === 'connect') {
        delete viewers[socket];
        context.set('viewers', viewers);
        return null;
    }
    if (event !== 'change') return null;
    const page = tabs.indexOf(msg.name);
    if (page === -1) {
        delete viewers[socket];
        context.set('viewers', viewers);
        return null;
    }
    viewers[socket] = { page, id: msg.socketid };
    model = flow.get('heatPumpModel');
    audience = [viewers[socket]];
} else {
    model = event;
    audience = Object.values(viewers);
}
if (!audience.length || !model?.summary) {
    if (socket) context.set('viewers', viewers);
    return null;
}

function splitChart(chart) {
    if (!chart) return [null, null];
    const { table, svg, ...values } = chart;
    const { now, ...frame } = svg;
    return [{ ...values, svg: { now } }, { table, svg: frame }];
}

function project(page) {
    if (page === 1) {
        const { meterDps, powerSource } = model.summary;
        const { items, unknown } = model;
        return { live: { items, unknown, summary: { meterDps, powerSource } } };
    }
    const { updated, curveChart, dhwChart, items, unknown, ...values } = model;
    const { meterDps, ...summary } = model.summary;
    const [curveLive, curveStatic] = splitChart(curveChart);
    const [dhwLive, dhwStatic] = splitChart(dhwChart);
    return {
        live: { ...values, summary, curveChart: curveLive, dhwChart: dhwLive },
        staticPart: { curveChart: curveStatic, dhwChart: dhwStatic }
    };
}

const projected = [];
const out = [[], []];
for (const viewer of audience) {
    const page = viewer.page;
    if (!projected[page]) {
        const { live, staticPart } = project(page);
        // Timestamp and advancing ages describe the snapshot, not a change in readings.
        const liveKey = JSON.stringify(live, (key, value) => key === 'ageSeconds' ? undefined : value);
        projected[page] = { live, liveKey, staticPart, staticKey: JSON.stringify(staticPart) };
    }
    const { live, liveKey, staticPart, staticKey } = projected[page];
    const staticChanged = viewer.staticKey !== staticKey;
    if (viewer.liveKey === liveKey && !staticChanged) continue;
    const message = { socketid: viewer.id, payload: { ...live, updated: model.updated } };
    if (staticChanged) message.hpStatic = staticPart;
    viewer.liveKey = liveKey;
    viewer.staticKey = staticKey;
    out[page].push(message);
}
context.set('viewers', viewers);
return out.some(queue => queue.length) ? out.map(queue => queue.length ? queue : null) : null;
