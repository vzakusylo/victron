'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Only counts and validated commit IDs may leave the private run folder.
function publicSummary(before, after, { commit, mode, outcome }) {
    if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('Expected a full deployment commit SHA.');
    if (!['dry-run', 'apply'].includes(mode)) throw new Error('Unexpected deployment mode.');
    if (!['success', 'failure', 'cancelled', 'skipped'].includes(outcome)) throw new Error('Unexpected deployment outcome.');
    const sha = (value) => /^[0-9a-f]{40}$/.test(value || '') ? value : null;
    const counts = (summary) => summary === null ? null : Object.fromEntries(
        ['code', 'trailing', 'config', 'onlyLive', 'onlyRepo', 'liveOnlyLines'].map((key) => {
            if (!Array.isArray(summary[key])) throw new Error('Invalid comparison summary field: ' + key);
            return [key, summary[key].length];
        }));
    return {
        commit, mode, outcome,
        previous: {
            dashboard: sha(before?.live?.source?.dashboard),
            automations: sha(before?.live?.source?.automations)
        },
        before: counts(before),
        after: counts(after)
    };
}

module.exports = { publicSummary };

if (require.main === module) {
    const [runFolder, output] = process.argv.slice(2);
    if (!runFolder || !output) throw new Error('Usage: deploy-report.js RUN_FOLDER OUTPUT.json');
    const read = (name) => {
        const file = path.join(runFolder, name);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    };
    const report = publicSummary(read('summary-before.json'), read('summary-after.json'), {
        commit: process.env.GITHUB_SHA, mode: process.env.MODE, outcome: process.env.DEPLOY_OUTCOME
    });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
