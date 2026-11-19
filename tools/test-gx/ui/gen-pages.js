'use strict';

const fs = require('node:fs');
const path = require('node:path');

let input = path.join(__dirname, '..', '..', '..', 'flows.json');
let check = false;
let specifiedFlows = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
    if (args[index] === '--check' && !check) {
        check = true;
    } else if (args[index] === '--flows' && !specifiedFlows && args[index + 1] && !args[index + 1].startsWith('--')) {
        input = path.resolve(args[++index]);
        specifiedFlows = true;
    } else {
        throw new Error('Usage: node gen-pages.js [--flows <file>] [--check]');
    }
}
const payload = JSON.parse(fs.readFileSync(input, 'utf8'));
const flows = Array.isArray(payload) ? payload : payload && payload.flows;
if (!Array.isArray(flows)) throw new Error('Expected a Node-RED flow array or a v2 object with a flows array.');
const disabledFlows = new Set(flows.filter(node => node.type === 'tab' && node.disabled).map(node => node.id));
const groups = new Map(flows.filter(node => node.type === 'ui_group').map(node => [node.id, node]));
const firstWidget = new Map();
for (const [index, node] of flows.entries()) {
    const group = groups.get(node.group);
    if (!group || !node.type.startsWith('ui_') || node.type === 'ui_ui_control' ||
        node.d || disabledFlows.has(node.z) || node.templateScope === 'global') continue;
    if (!firstWidget.has(group.tab)) firstWidget.set(group.tab, index);
}

const tabs = flows.filter(node => node.type === 'ui_tab').map(node => ({
    id: node.id,
    name: node.name,
    order: Number(node.order),
    disabled: Boolean(node.disabled),
    hidden: Boolean(node.hidden),
}));

const registered = tabs.filter(tab => firstWidget.has(tab.id)).sort((a, b) => {
    const orderA = a.order || Infinity;
    const orderB = b.order || Infinity;
    return orderA - orderB || firstWidget.get(a.id) - firstWidget.get(b.id);
});
const routes = new Map(registered.map((tab, index) => [tab.id, `#!/${index}`]));
const pages = tabs.map(tab => ({
    ...tab,
    ...(routes.has(tab.id) ? { route: routes.get(tab.id) } : { reason: 'No enabled dashboard widget references this tab.' }),
}));

const output = path.join(__dirname, 'pages.json');
const json = `${JSON.stringify(pages, null, 2)}\n`;
if (check) {
    if (fs.readFileSync(output, 'utf8') !== json) {
        throw new Error('pages.json is stale; run npm run gen:pages');
    }
} else {
    fs.writeFileSync(output, json);
}
