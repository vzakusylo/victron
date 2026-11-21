#!/usr/bin/env node
// PostToolUse hook (Edit / Write): after a numbered flow source (`NN Name.js` / `.html`) changes, run
// `node tools/flows.js check` and tell Claude when flows.json is out of sync (run `node tools/flows.js sync`).
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
    let file = '';
    try { file = (JSON.parse(raw).tool_input || {}).file_path || ''; } catch { return; }
    if (!/^\d\d [^/\\]+\.(js|html)$/.test(path.basename(file))) return;
    const root = path.resolve(__dirname, '..', '..');
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'flows.js'), 'check'], { cwd: root, encoding: 'utf8' });
    if (r.status === 0) return;
    const msg = (r.stdout + r.stderr).trim().split(/\r?\n/).slice(-6).join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse',
        additionalContext: 'flows.json is out of sync with ' + path.basename(file) + '. Run `node tools/flows.js sync` (bumps d#) before tests / commit.\n' + msg } }));
});
