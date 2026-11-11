#!/usr/bin/env node
// Editor layout of flows.json (d#149). Run from the repo root after adding nodes:
//   node tools/layout-flows.js flows.json flows.json layout-patch.json
// then deploy the patch (x / y / g of each node + the group nodes) to the GX by GET /flows, patch, POST.
// Assigning a node to a group changes its `g`, which Node-RED 3.1 treats as a config change: those
// nodes restart once on deploy, so do not deploy while the DHW controller is in a cycle.
// New node ids that match no group land in the group "Other"; add them to GROUPS below.
// Editor layout for the main tab: puts every node into a named Node-RED group by function and lays each group
// out left-to-right (layers by longest path, order by barycenter). Changes only x / y / g and adds `group`
// nodes; wires and logic stay as they are. Usage: node layout.js flows.json out-flows.json patch.json
const fs = require('fs');
const [inFile, outFile, patchFile] = process.argv.slice(2);
const raw = fs.readFileSync(inFile, 'utf8');
const flows = JSON.parse(raw);
const tab = flows.find((n) => n.type === 'tab' && /d#\d+/.test(n.label));
const Z = tab.id;

// ---- groups (column, name, colour, members) ------------------------------------------------------------
const ids = (s) => s.trim().split(/\s+/);
const GROUPS = [
    { col: 0, id: 'lay-g-ctrl', name: 'Energy controller: Victron inputs → Battery + Grid Controller → MultiPlus / ESS / DVCC', color: '#3f93cf',
      members: ids(`9217554766842bb8 7ec26167c492e338 8db34d06b6591d5e 3e6dccae307e4561 66951950bfa6d862 b85e512d33d6a7cc 70b033ccd4654b3e
        902ee92400d4d4af 07c74490cafdc55a 1d4e50f4d614e8a5 0ee582b64b26e2e7 fd95dc1c428330fb b2064b2168543e59 e84b0d054ca0f956 efb076ae80adc1c5
        e4766632305fb432 5545bd538ffe3183 1b39f33beca11607 75f48e33343da04e 87b4ad2bc3ec6903 751d13b6d943e5e5 704426f76aa6aa4c c1803b5fed00bfc2
        11e303e775ec959c ec0378c28791feff 4ae3639bc75d0d14 233d4e08d8a8fe38 f46ecea6668505f3 dc7f2a1c3e8b09c4 dc3b8e51a09c72d4 dc9d4c2e7a1b83f6
        pv-charger-input-01 pv-charger-tag-01 4c8d2e6b19f7a530 7a3e91c45d2b8f06`) },
    { col: 0, id: 'lay-g-hourly', name: 'Energy pages: hourly log, daily summary, Energy / Energy Detail widgets', color: '#62a8d8',
      members: ids(`69795160ade5462a 3e942ddd06fba83c 6b9848413d671fe5 137dd306ca7275e6 c45dc5b7ad338001 66c0ba36be6d13e1 e290ee7bdb1e8b5f
        ccf75f3c42b18fad e5c92ba1e1522207 182424972ce7160c fa6dc3252e5e9c91 384275af4f557f0a`) },
    { col: 0, id: 'lay-g-notify', name: 'GX notifications and daily log', color: '#9b9b9b',
      members: ids('ea80f613a4a9424a 58e14304c415b27e 1a26cadbd6ae5765 c125191024e87a94 76b6ca504877aa54 c2f366898ad94d9e 0af20cf90708f90d') },
    { col: 0, id: 'lay-g-solar', name: 'Solar forecast (forecast.solar, shade correction)', color: '#e2b93b',
      members: ids('0f01a2551ae68d2e e6a5ce1f50c59362 0af0cfe3fe0b6ad9 04915dfb9f203f67') },
    { col: 0, id: 'lay-g-analytics', name: 'Analytics page', color: '#62a8d8',
      members: ids('e55aa7c921171c88 e1128ba95b8412c8 1a1e8c9aa390c34f 23df4673183eb88f b4515d8f57614e49 c81df251c9407d61 b8eeb060d5bc345a') },
    { col: 0, id: 'lay-g-hv', name: 'Protection page: high-voltage settings', color: '#d9534f',
      members: ids('4fb37264764eecaa f5ddbb5af3f2529d 1ad973cf841f48cb ebf4f39d0f4ebd3a d649c2e4d8ca5f12 b14e612dcff7f196 5b862b2be571625a') },
    { col: 0, id: 'lay-g-const', name: 'Constants page: controller constants and tariff seasons', color: '#8e7cc3',
      members: ids('constants-template-01 constants-inject-startup-01 constants-exec-read-01 constants-build-fn-01 constants-save-fn-01 constants-file-write-01 constants-reload-01') },
    { col: 0, id: 'lay-g-files', name: 'Files page: logs and disk usage', color: '#9b9b9b',
      members: ids('2a4cce0a3d3c4f11 4a1600bd801f4f55 5a1f7d0be2c64f44 63b9b2d57b174422 7bca218a93c14789 9d2a7ed0c1bd4f21 af24074a74864f57 df94619fdb8449e7 842ce8fddd3f49b2') },
    { col: 0, id: 'lay-g-backup', name: 'Backup page: backup / restore, download, upload, data archive mail', color: '#5cb85c',
      members: (n) => /^backup-/.test(n.id) },
    { col: 0, id: 'lay-g-device', name: 'Device and Driver pages, BMS watchdog', color: '#9b9b9b',
      members: (n) => /^(device|bmswd|driver)-/.test(n.id) },
    { col: 0, id: 'lay-g-mcp', name: 'Agent (MCP): /mcp endpoint and page', color: '#8e7cc3',
      members: (n) => /^mcp-/.test(n.id) },
    { col: 1, id: 'lay-g-hp', name: 'Heat pump: Tuya devices (local) → state → Heat Pump page, commands', color: '#e8743b',
      members: ids('hp-comment-01 hp-poll-inject-01 hp-tuya-pump-01 hp-tuya-valve-01 hp-tuya-bypass-01 hp-topic-hp-01 hp-topic-valve-01 hp-topic-bypass-01 hp-state-fn-01 hp-page-template-01 hp-tuya-meter-01 hp-topic-meter-01 hp-cmd-fn-01') },
    { col: 1, id: 'lay-g-hplog', name: 'Heat pump recorder and history by day', color: '#f0a35e',
      members: (n) => /^hp-(log|hist)-/.test(n.id) },
    { col: 1, id: 'lay-g-sensors', name: 'Battery sensors: accumulator tank + exchange plate (local, cloud fallback)', color: '#f0a35e',
      members: (n) => /^(hpls|hpc)-/.test(n.id) },
    { col: 1, id: 'lay-g-auto', name: 'Heat pump automations (DHW controller, defrost, Er03) and Automation log', color: '#e8743b',
      members: (n) => /^(hpa|hpl)-/.test(n.id) },
    { col: 1, id: 'lay-g-cres', name: 'Compressor resource', color: '#f0a35e', members: (n) => /^cres-/.test(n.id) },
    { col: 1, id: 'lay-g-alerts', name: 'E-mail alerts on errors', color: '#d9534f', members: (n) => /^hpal-/.test(n.id) },
    { col: 1, id: 'lay-g-payback', name: 'Payback page', color: '#5cb85c', members: (n) => /^pb-/.test(n.id) }
];
const OTHER = { col: 1, id: 'lay-g-other', name: 'Other', color: '#9b9b9b', members: () => false };

// ---- node size estimate (Node-RED draws x / y as the node centre) ---------------------------------------
const VICTRON_LABEL = 34;
function label(n) {
    if (n.type === 'comment') return n.name || 'comment';
    if (n.name) return n.name;
    if (/^victron-/.test(n.type)) return 'x'.repeat(VICTRON_LABEL);
    if (n.type === 'tuya-smart-device') return n.deviceName || 'tuya-smart-device';
    if (n.type === 'delay') return 'delay 10s';
    if (n.type === 'change') return 'set msg.topic';
    if (n.type === 'debug') return 'msg.payload';
    if (n.type === 'inject') return (n.topic || 'timestamp') + ' ↻';
    return n.type;
}
const width = (n) => Math.max(100, Math.min(n.type === 'comment' ? 900 : 520, Math.round(label(n).length * 7.3 + 54)));
const height = (n) => Math.max(30, 15 * ((n.wires || []).length) + 10);

const GAP_X = 70, ROW = 48, PAD = 24, LABEL_H = 26, GROUP_GAP = 46, COL_GAP = 160, LEFT = 40, TOP = 40;

const tabNodes = flows.filter((n) => n.z === Z && n.type !== 'group');
const flowIndex = new Map(flows.map((n, i) => [n.id, i]));
const groupOf = new Map();
for (const n of tabNodes) {
    const g = GROUPS.find((g) => (typeof g.members === 'function' ? g.members(n) : g.members.includes(n.id))) || OTHER;
    groupOf.set(n.id, g);
}
const allGroups = GROUPS.concat(tabNodes.some((n) => groupOf.get(n.id) === OTHER) ? [OTHER] : []);

// in-group edges (wires + link nodes)
function edges(members) {
    const set = new Set(members.map((n) => n.id));
    const out = new Map(members.map((n) => [n.id, []]));
    for (const n of members) for (const port of n.wires || []) for (const t of port) if (set.has(t) && t !== n.id && !out.get(n.id).includes(t)) out.get(n.id).push(t);
    return out;
}

function layoutGroup(g) {
    const members = tabNodes.filter((n) => groupOf.get(n.id) === g);
    const comments = members.filter((n) => n.type === 'comment');
    const nodes = members.filter((n) => n.type !== 'comment');
    const out = edges(nodes);
    // remove back edges (DFS from sources, in original y order for stability)
    // stable order: the position in flows.json (not x / y), so a second run gives the same layout
    const order = nodes.slice().sort((a, b) => flowIndex.get(a.id) - flowIndex.get(b.id));
    const inDeg = new Map(nodes.map((n) => [n.id, 0]));
    for (const [, ts] of out) for (const t of ts) inDeg.set(t, inDeg.get(t) + 1);
    const state = new Map(), dag = new Map(nodes.map((n) => [n.id, []]));
    const visit = (id) => {
        state.set(id, 1);
        for (const t of out.get(id)) {
            if (state.get(t) === 1) continue; // back edge
            dag.get(id).push(t);
            if (!state.get(t)) visit(t);
        }
        state.set(id, 2);
    };
    for (const n of order.filter((n) => inDeg.get(n.id) === 0)) if (!state.get(n.id)) visit(n.id);
    for (const n of order) if (!state.get(n.id)) visit(n.id);
    // layers = longest path
    const layer = new Map(nodes.map((n) => [n.id, 0]));
    let changed = true, guard = 0;
    while (changed && guard++ < 200) {
        changed = false;
        for (const [s, ts] of dag) for (const t of ts) if (layer.get(t) < layer.get(s) + 1) { layer.set(t, layer.get(s) + 1); changed = true; }
    }
    // pull sinks-only sources right next to their first target (e.g. injects feeding a late node)
    const preds = new Map(nodes.map((n) => [n.id, []]));
    for (const [s, ts] of dag) for (const t of ts) preds.get(t).push(s);
    for (const n of nodes) {
        if (preds.get(n.id).length) continue;
        const ts = dag.get(n.id);
        if (ts.length) layer.set(n.id, Math.max(0, Math.min(...ts.map((t) => layer.get(t))) - 1));
    }
    const nL = Math.max(0, ...layer.values()) + 1;
    const layers = Array.from({ length: nL }, () => []);
    for (const n of order) layers[layer.get(n.id)].push(n);
    // barycenter ordering, a few sweeps
    const pos = new Map();
    layers.forEach((L) => L.forEach((n, i) => pos.set(n.id, i)));
    for (let sweep = 0; sweep < 6; sweep++) {
        for (let li = 1; li < nL; li++) {
            const L = layers[li];
            const bc = (n) => { const p = preds.get(n.id); return p.length ? p.reduce((s, q) => s + pos.get(q), 0) / p.length : pos.get(n.id); };
            L.sort((a, b) => bc(a) - bc(b));
            L.forEach((n, i) => pos.set(n.id, i));
        }
        for (let li = nL - 2; li >= 0; li--) {
            const L = layers[li];
            const bc = (n) => { const s = dag.get(n.id); return s.length ? s.reduce((a, t) => a + pos.get(t), 0) / s.length : pos.get(n.id); };
            L.sort((a, b) => bc(a) - bc(b));
            L.forEach((n, i) => pos.set(n.id, i));
        }
    }
    // coordinates relative to the group's top-left content corner
    const res = new Map();
    let cy = 0;
    for (const c of comments) { res.set(c.id, { x: width(c) / 2, y: cy + 15 }); cy += 40; }
    const top = cy + (comments.length ? 6 : 0);
    let cx = 0, maxY = top;
    for (const L of layers) {
        const w = Math.max(...L.map(width));
        let y = top;
        for (const n of L) {
            const h = height(n);
            res.set(n.id, { x: cx + w / 2, y: y + h / 2 });
            y += Math.max(ROW, h + 18);
        }
        maxY = Math.max(maxY, y);
        cx += w + GAP_X;
    }
    const contentW = Math.max(cx - GAP_X, ...comments.map(width));
    return { g, res, w: contentW, h: maxY - 18 + 6 };
}

// place groups: two columns, stacked
const laid = allGroups.map(layoutGroup).filter((l) => l.res.size);
const colW = [0, 1].map((c) => Math.max(0, ...laid.filter((l) => l.g.col === c).map((l) => l.w + 2 * PAD)));
const colX = [LEFT, LEFT + colW[0] + COL_GAP];
const colY = [TOP, TOP];
const newGroups = [];
const place = new Map();
for (const l of laid) {
    const c = l.g.col;
    const gx = colX[c], gy = colY[c];
    const gw = l.w + 2 * PAD, gh = l.h + LABEL_H + PAD;
    for (const [id, p] of l.res) place.set(id, { x: Math.round(gx + PAD + p.x), y: Math.round(gy + LABEL_H + 8 + p.y), g: l.g.id });
    newGroups.push({
        id: l.g.id, type: 'group', z: Z, name: l.g.name,
        style: { label: true, stroke: l.g.color, fill: l.g.color, 'fill-opacity': '0.08', color: '#3f3f3f' },
        nodes: [...l.res.keys()], x: gx, y: gy, w: gw, h: gh
    });
    colY[c] = gy + gh + GROUP_GAP;
}

// apply
const result = flows.filter((n) => !(n.type === 'group' && n.z === Z));
for (const n of result) {
    const p = place.get(n.id);
    if (!p) continue;
    n.x = p.x; n.y = p.y; n.g = p.g;
}
// group nodes go right after the tab node
const ti = result.indexOf(tab);
result.splice(ti + 1, 0, ...newGroups);
const seen = new Set(); for (const n of result) { if (seen.has(n.id)) throw new Error('dup ' + n.id); seen.add(n.id); }
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const m = raw.match(/^\[\r?\n( +)\{/), ind = m ? m[1].length : 2;
let s = JSON.stringify(result, null, ind); if (eol === '\r\n') s = s.replace(/\n/g, '\r\n');
fs.writeFileSync(outFile, s + (raw.endsWith('\n') ? eol : ''));
const patch = { groups: newGroups, nodes: [...place].map(([id, p]) => ({ id, x: p.x, y: p.y, g: p.g })) };
fs.writeFileSync(patchFile, JSON.stringify(patch));
for (const g of newGroups) console.log(g.id.padEnd(16), String(g.nodes.length).padStart(3), 'x', g.x, 'y', g.y, 'w', g.w, 'h', g.h, '|', g.name.slice(0, 50));
console.log('canvas', Math.max(...newGroups.map((g) => g.x + g.w)), 'x', Math.max(...newGroups.map((g) => g.y + g.h)), '| other:', tabNodes.filter((n) => groupOf.get(n.id) === OTHER).map((n) => n.id).join(' ') || '-');
