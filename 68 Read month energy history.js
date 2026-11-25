// #libs [{"var":"fs","module":"fs"}]
// #replace-exec true
// #include lib/history/lines.js

const DIR = '/data/home/nodered/grid-control-logs';
const month = msg.monthKey;
if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    node.error('Energy history: expected a YYYY-MM month', msg);
    return null;
}

async function readMonth() {
    const prefix = 'energy-' + month;
    const names = (await historyNames(DIR)).filter(e => e.isFile() && e.name.startsWith(prefix + '-') && e.name.endsWith('.log'))
        .map(e => e.name).sort();
    // Both consumers apply last-row wins. The current CSV follows all legacy files.
    let payload = '';
    for (const name of names.concat(prefix + '.csv')) {
        for await (const { line, newline } of historyLines(await openHistoryFile(`${DIR}/${name}`))) {
            if (line.startsWith(month + '-')) payload += line + (newline ? '\n' : '');
        }
    }
    return { topic: 'tariff-history', payload };
}
return readMonth().catch(error => { node.error('Energy history: ' + error.message, msg); return null; });
