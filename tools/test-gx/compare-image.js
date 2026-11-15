#!/usr/bin/env node
// Compares the running Docker test GX with the sanitized backup it was built from.
// Runs on the PC, reads the container over ssh and the Node-RED admin API; changes nothing.
//
// Usage: node tools/test-gx/compare-image.js --backup <sanitized dir> [--ssh test-gx] [--api http://127.0.0.1:1881]
//          [--compose tools/test-gx] [--live LIVE.b64] [--report report.json]
//   --live  snapshot of a real GX (tools/gx/live-snapshot.js output): also compare the image with it (read-only on the GX).
// Exit code: 0 = OK / WARN / EXPECTED only, 1 = DIFF, 2 = the check itself failed.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const http = require('http');
const { spawnSync } = require('child_process');
const { snapshot } = require('../gx/live-snapshot.js');
const { diffSnapshots } = require('../gx/compare.js');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const backupDir = opt('--backup');
const sshHost = opt('--ssh', 'test-gx');
const api = opt('--api', 'http://127.0.0.1:1881');
const composeDir = opt('--compose', __dirname);
if (!backupDir) { console.error('Usage: node tools/test-gx/compare-image.js --backup <sanitized dir>'); process.exit(2); }

const rows = [];
const add = (status, what, detail) => rows.push({ status, what, detail: detail || '' });
const normalize = (text) => String(text).replace(/\r\n/g, '\n');

function ssh(command, input) {
    const result = spawnSync('ssh', [sshHost, command], { input, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (result.status !== 0) throw new Error('ssh ' + sshHost + ' "' + command + '": ' + (result.stderr || result.error || '').toString().trim());
    return result.stdout;
}
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, { headers: { 'Node-RED-API-Version': 'v2' } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error('GET ' + url + ' -> ' + res.statusCode))));
        }).on('error', reject);
    });
}
const decodeSnapshot = (b64) => JSON.parse(zlib.gunzipSync(Buffer.from(String(b64).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')).toString('utf8'));

// Nodes whose config legitimately differs between the GX and the test GX: Tuya (secrets) and anything with credentials.
const EXPECTED_CONFIG_TYPES = /^tuya/i;

function classifyFlow(name, diff, expectedTypes) {
    const real = diff.code.length + diff.trailing.length + diff.onlyLive.length + diff.onlyRepo.length;
    const config = diff.config.filter((item) => !expectedTypes.test(item.type));
    const expectedConfig = diff.config.length - config.length;
    if (real || config.length) {
        const list = diff.code.concat(diff.trailing, diff.onlyLive, diff.onlyRepo, config).slice(0, 5).map((item) => item.id + ' ' + (item.name || item.type));
        add('DIFF', name, 'code ' + diff.code.length + ', trailing ' + diff.trailing.length + ', only image ' + diff.onlyLive.length + ', only other ' + diff.onlyRepo.length + ', config ' + config.length + ': ' + list.join('; '));
    } else add('OK', name, 'no differences');
    if (expectedConfig) add('EXPECTED', name + ' (config)', expectedConfig + ' Tuya / credential node(s) differ in config');
}

function localHashes(root, dirs) {
    const out = new Map();
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) out.set(path.relative(root, full).replace(/\\/g, '/'), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
        }
    };
    for (const dir of dirs) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
    return out;
}

// Secret files: only their presence is compared (their content is random / fake on purpose).
const PRESENCE_ONLY = /(^|\/)(mcp-token\.txt|email\.json)$/;

async function main() {
    const redDir = path.join(backupDir, 'nodered');
    const flowsFile = path.join(redDir, '.node-red', 'flows.json');
    const versionsFile = path.join(backupDir, 'versions.json');

    // 1. flow: image (same live-snapshot.js as for the real GX) against the backup
    const imageSnap = decodeSnapshot(ssh('tr -d "\\r" | node -', fs.readFileSync(path.join(__dirname, '..', 'gx', 'live-snapshot.js'), 'utf8')));
    const backupSnap = snapshot(JSON.parse(fs.readFileSync(flowsFile, 'utf8')));
    classifyFlow('flow: image vs backup', diffSnapshots(imageSnap, backupSnap), EXPECTED_CONFIG_TYPES);

    // 2. versions
    const versions = JSON.parse(fs.readFileSync(versionsFile, 'utf8'));
    const settings = await getJson(api + '/settings');
    if (settings.version === versions.nodeRed) add('OK', 'Node-RED', settings.version);
    else add('DIFF', 'Node-RED', 'backup ' + versions.nodeRed + ', image ' + settings.version);
    const installed = JSON.parse(ssh('cd /data/home/nodered/.node-red && npm ls --depth=0 --json 2>/dev/null || true')).dependencies || {};
    for (const [pkg, want] of Object.entries(versions.palette)) {
        if (pkg === 'node-red') continue;
        const have = installed[pkg] && installed[pkg].version;
        if (have === want) add('OK', 'palette ' + pkg, have);
        else if (have && have.split('.').slice(0, 2).join('.') === want.split('.').slice(0, 2).join('.')) add('WARN', 'palette ' + pkg, 'backup ' + want + ', image ' + have + ' (same minor, patch differs)');
        else add('DIFF', 'palette ' + pkg, 'backup ' + want + ', image ' + (have || 'not installed'));
    }

    // 3. files
    const dirs = ['tools', 'grid-control-config'];
    const local = localHashes(redDir, dirs);
    const remote = new Map();
    for (const line of ssh('cd /data/home/nodered && find ' + dirs.join(' ') + ' -type f -exec sha256sum {} +').split('\n')) {
        const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
        if (m) remote.set(m[2], m[1]);
    }
    const missing = [], extra = [], changed = [];
    for (const [file, hash] of local) {
        if (!remote.has(file)) missing.push(file);
        else if (!PRESENCE_ONLY.test(file) && remote.get(file) !== hash) changed.push(file);
    }
    for (const file of remote.keys()) if (!local.has(file)) extra.push(file);
    // Files that the flow writes while it runs (state, logs) are not a difference.
    const runtime = (file) => /^grid-control-(config|logs)\//.test(file) && !local.has(file);
    const extraReal = extra.filter((file) => !runtime(file));
    // The flow rewrites its own state files in grid-control-config/ while it runs; code in tools/ never changes.
    const changedTools = changed.filter((file) => file.startsWith('tools/')), changedState = changed.filter((file) => !file.startsWith('tools/'));
    if (missing.length || changedTools.length) add('DIFF', 'files tools/ + grid-control-config/', 'missing ' + missing.length + ', changed in tools/ ' + changedTools.length + ': ' + missing.concat(changedTools).slice(0, 5).join(', '));
    else add('OK', 'files tools/ + grid-control-config/', local.size + ' files, none missing, tools/ equal');
    if (changedState.length) add('WARN', 'state files rewritten by the flow', changedState.length + ': ' + changedState.slice(0, 5).join(', '));
    if (extraReal.length) add('WARN', 'files created by the flow since start', extraReal.length + ': ' + extraReal.slice(0, 5).join(', '));

    // 4. global context keys
    const contextDir = path.join(redDir, '.node-red', 'context', 'global');
    if (fs.existsSync(contextDir)) {
        const want = fs.readdirSync(contextDir).filter((f) => f.endsWith('.json')).map((f) => Object.keys(JSON.parse(fs.readFileSync(path.join(contextDir, f), 'utf8'))).sort().join(','))[0];
        const contextNow = await getJson(api + '/context/global');
        const have = Object.keys(contextNow.default || contextNow.file || {}).sort().join(',');
        add(want === have ? 'OK' : 'DIFF', 'global context keys', want === have ? have.split(',').length + ' key(s)' : 'backup ' + want + ' | image ' + have);
    } else add('EXPECTED', 'global context keys', 'the backup has no context store (memory context); nothing to compare');

    // 5. start log: errors that are not known
    const logs = spawnSync('docker', ['compose', 'logs', 'nodered', '--no-log-prefix'], { cwd: composeDir, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (logs.status !== 0) throw new Error('docker compose logs: ' + logs.stderr);
    const KNOWN = [
        [/tuya-smart-device.*Key is missing or incorrect/, 'Tuya devices have fake keys'],
        // TEMPORARY: remove once step B (D-Bus emulator) covers these paths, or a real D-Bus error is hidden here.
        [/DBUS ERROR MESSAGE .*UnknownObject/, 'D-Bus path missing in the simulator (temporary, until step B)'],
        [/Error in setValue: No services available yet/, 'D-Bus service not up yet']
    ];
    const unknown = [], known = new Map();
    for (const line of logs.stdout.split('\n')) {
        if (!/\[error\]|SyntaxError|ReferenceError|TypeError|DBUS ERROR|Error in /.test(line)) continue;
        const hit = KNOWN.find(([re]) => re.test(line));
        if (hit) known.set(hit[1], (known.get(hit[1]) || 0) + 1);
        else unknown.push(line.trim().slice(0, 160));
    }
    if (unknown.length) add('DIFF', 'start log', unknown.length + ' unknown error(s): ' + unknown.slice(0, 3).join(' | '));
    else add('OK', 'start log', 'no unknown errors');
    for (const [why, count] of known) add('EXPECTED', 'start log', count + 'x ' + why);

    // 6. optional: the image against a real GX
    const liveFile = opt('--live');
    if (liveFile) {
        const live = decodeSnapshot(fs.readFileSync(liveFile, 'utf8'));
        classifyFlow('flow: image vs live GX', diffSnapshots(live, imageSnap), EXPECTED_CONFIG_TYPES);
        const tab = (s) => (s.nodes.find((n) => n.type === 'tab' && /d#\d+/.test(n.label || '')) || {}).label || '';
        const strip = (label) => label.replace(/ TEST-GX$/, '');
        add(live.rev === imageSnap.rev ? 'OK' : 'WARN', 'revision', 'live ' + String(live.rev).slice(0, 12) + ', image ' + String(imageSnap.rev).slice(0, 12) + (live.rev === imageSnap.rev ? '' : ' (rev differs when the GX was deployed after the backup)'));
        add(strip(tab(live)) === strip(tab(imageSnap)) ? 'OK' : 'WARN', 'tab label / git commit', 'live "' + tab(live) + '", image "' + tab(imageSnap) + '"');
    }
}

main().then(() => {
    const width = Math.max(...rows.map((r) => r.what.length));
    for (const r of rows) console.log(r.status.padEnd(9) + r.what.padEnd(width + 2) + r.detail);
    const diff = rows.filter((r) => r.status === 'DIFF').length, warn = rows.filter((r) => r.status === 'WARN').length;
    const status = diff ? 'FAIL' : warn ? 'WARN' : 'OK';
    console.log('\nSTATUS: ' + status + '  (DIFF ' + diff + ', WARN ' + warn + ')');
    const report = opt('--report');
    if (report) fs.writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), status, rows }, null, 2) + '\n');
    process.exitCode = diff ? 1 : 0;
}).catch((error) => { console.error('compare-image failed: ' + error.message); process.exit(2); });
