#!/usr/bin/env node
// Turns a real GX backup (grid-backup-*.tar.gz) into a tree without private values for the test GX.
// Usage: node tools/test-gx/sanitize-backup.js <backup.tar.gz> <outDir> [--days 14] [--no-logs]
// <outDir> must be outside the repository. Writes <outDir>/nodered (the /data/home/nodered tree),
// <outDir>/versions.json and <outDir>/sanitize-report.json (paths and fields only, never values), and, BESIDE
// <outDir>, <name>.map.json: the original -> fake pairs for compare-image.js --live --map. That file is SECRET.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--days');
const [backup, out] = positional;
if (!backup || !out) { console.error('usage: sanitize-backup.js <backup.tar.gz> <outDir> [--days N] [--no-logs]'); process.exit(64); }
const REPO = path.resolve(__dirname, '..', '..');
const MARKER = '.test-gx-sanitized';
const MAP_FORMAT = 'test-gx-map-v1';
const real = (p) => { // realpath of the nearest existing ancestor, then the rest appended
    let cur = path.resolve(p); const rest = [];
    while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { rest.unshift(path.basename(cur)); cur = path.dirname(cur); }
    return path.join(fs.realpathSync(cur), ...rest);
};
const overlaps = (a, b) => { const r = path.relative(real(a), real(b)); return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); };
const outAbs = path.resolve(out);
if (overlaps(REPO, outAbs) || overlaps(outAbs, REPO)) { console.error('outDir must be outside the repository, and must not contain it'); process.exit(64); }
// The map is a secret alongside outDir. Validate it before the output tree can be erased.
const mapFile = path.join(path.dirname(outAbs), path.basename(outAbs) + '.map.json');
if (overlaps(REPO, mapFile)) { console.error('map file would be inside the repository: ' + mapFile); process.exit(64); }
if (fs.existsSync(mapFile)) {
    let prev = null; try { prev = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch { /* not ours */ }
    if (!prev || prev.format !== MAP_FORMAT) { console.error('refusing to overwrite ' + mapFile + ': not a ' + MAP_FORMAT + ' file'); process.exit(64); }
}
// out is wiped before every run: only an empty directory or one this tool wrote earlier qualifies
if (fs.existsSync(outAbs)) {
    const entries = fs.readdirSync(outAbs);
    const ours = fs.existsSync(path.join(outAbs, MARKER)) || (entries.includes('sanitize-report.json') && entries.includes('nodered'));
    if (entries.length && !ours) { console.error('refusing to delete ' + outAbs + ': not empty and not created by sanitize-backup.js (no ' + MARKER + ')'); process.exit(64); }
}
const days = Number(opt('--days', 14));

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gx-raw-'));
const cleanup = () => fs.rmSync(staging, { recursive: true, force: true });
try {
    // An old valid map belongs to the old output; remove it before replacing that tree.
    fs.rmSync(mapFile, { force: true });
    execFileSync('tar', ['-xzf', backup, '-C', staging, '--exclude', '*/.node-red/backup-*'], { stdio: 'inherit' });
    run();
} catch (e) {
    fs.rmSync(mapFile, { force: true });
    console.error('FAILED: ' + e.message); process.exitCode = 2;
}
finally { cleanup(); }

function run() {
    const src = path.join(staging, 'data', 'home', 'nodered');
    const dst = path.join(out, 'nodered');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(out, MARKER), 'created by tools/test-gx/sanitize-backup.js; safe to delete and recreate\n');
    const report = { source: path.basename(backup), replaced: [], deleted: [], written: [], logDays: days };
    const secrets = new Map();      // original value -> kind
    const SECRET_FIELDS = /^(key|localkey|secret|accesssecret|accessid|pass|password|token|apikey)$/i;
    const ID = /^[a-z0-9]{20,24}$/;
    const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    const MAC = /^(?:([0-9a-f]{2}:){5}[0-9a-f]{2}|[0-9a-f]{12})$/i;
    const EMAIL = /^[^@\s"]+@[^@\s"]+\.[a-z]+$/i;
    const add = (v, kind, where) => {
        if (typeof v !== 'string' || v.length < 4 || secrets.has(v)) return;
        secrets.set(v, kind); report.replaced.push({ where, kind });
    };
    const walk = (o, where) => {
        if (Array.isArray(o)) return o.forEach((x, i) => walk(x, where + '[' + i + ']'));
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
            if (ID.test(k) && /[0-9]/.test(k)) add(k, 'id', where + '.<deviceId>');
            if (typeof v === 'string') {
                if (['func', 'initialize', 'finalize'].includes(k)) {
                    for (const m of v.matchAll(/\bmac\s*:\s*['"]((?:[0-9a-f]{2}:){5}[0-9a-f]{2}|[0-9a-f]{12})['"]/gi))
                        add(m[1], 'mac', where + '.' + k + '.mac');
                    for (const m of v.matchAll(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi))
                        add(m[0], 'mac', where + '.' + k + '.mac');
                }
                if (SECRET_FIELDS.test(k)) add(v, 'secret', where + '.' + k);
                else if (/^(deviceid|id)$/i.test(k) && ID.test(v)) add(v, 'id', where + '.' + k);
                else if (/^(ip|deviceip)$/i.test(k) && IPV4.test(v)) add(v, 'ip', where + '.' + k);
                else if (/^mac$/i.test(k) && MAC.test(v)) add(v, 'mac', where + '.' + k);
                else if (EMAIL.test(v)) add(v, 'email', where + '.' + k);
            } else walk(v, where + '.' + (ID.test(k) ? '<deviceId>' : k));
        }
    };

    const nr = path.join(src, '.node-red');
    const originalFlows = JSON.parse(fs.readFileSync(path.join(nr, 'flows.json'), 'utf8'));
    walk(originalFlows, 'flows');
    const cfgSrc = path.join(src, 'grid-control-config');
    const keepCfg = (f) => !/\.(pre-|bak)/.test(f) && !/\.pre-d/.test(f);
    const cfgFiles = fs.existsSync(cfgSrc) ? fs.readdirSync(cfgSrc).filter(keepCfg) : [];
    for (const f of cfgFiles) {
        if (!f.endsWith('.json') || f === 'email.json') continue;
        try { walk(JSON.parse(fs.readFileSync(path.join(cfgSrc, f), 'utf8')), f); } catch { /* not JSON */ }
    }

    // deterministic fake of the same length and character class
    const fake = (v, kind, n) => {
        const identity = kind === 'mac' ? v.replace(/:/g, '').toLowerCase() : v;
        const h = crypto.createHash('sha256').update('test-gx:' + identity).digest();
        if (kind === 'ip') return '10.99.' + h[0] % 250 + '.' + (1 + h[1] % 250);
        if (kind === 'mac') {
            const mac = '02:00:' + [...h.subarray(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(':');
            return v.includes(':') ? mac : mac.replace(/:/g, '').toUpperCase();
        }
        if (kind === 'email') return 'test' + n + '@example.invalid';
        const abc = kind === 'id' ? 'abcdef0123456789' : 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        let s = ''; for (let i = 0; i < v.length; i++) s += abc[h[i % h.length] % abc.length];
        // ids are used as bare object keys in flow code, so the first character must not be a digit
        return kind === 'id' ? 'a' + s.slice(1) : s;
    };
    const mapping = new Map([...secrets].map(([v, kind], i) => [v, fake(v, kind, i)]));
    const ordered = [...mapping].sort((a, b) => b[0].length - a[0].length);
    const mapCounts = {};
    for (const kind of secrets.values()) mapCounts[kind] = (mapCounts[kind] || 0) + 1;
    report.mapFile = path.basename(mapFile);
    report.mapCounts = mapCounts;
    const apply = (text) => { for (const [from, to] of ordered) if (text.includes(from)) text = text.split(from).join(to); return text; };

    const put = (rel, data) => {
        const p = path.join(dst, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data); report.written.push(rel.replace(/\\/g, '/'));
    };
    const copyTree = (from, rel, filter, transform) => {
        if (!fs.existsSync(from)) return;
        for (const e of fs.readdirSync(from, { withFileTypes: true })) {
            const r = path.join(rel, e.name);
            if (!filter(r, e)) continue;
            if (e.isDirectory()) copyTree(path.join(from, e.name), r, filter, transform);
            else put(r, transform(path.join(from, e.name), r));
        }
    };
    const text = (f) => fs.readFileSync(f);
    const mapped = (f) => Buffer.from(apply(fs.readFileSync(f, 'utf8')));

    // .node-red: flow, palette list; credentials, runtime config and users are not copied
    for (const f of ['flows_cred.json', '.flows_cred.json.backup', '.config.runtime.json', '.config.runtime.json.backup', '.config.users.json', '.config.users.json.backup', 'settings-user.js'])
        if (fs.existsSync(path.join(nr, f))) report.deleted.push('.node-red/' + f);
    const flows = JSON.parse(apply(JSON.stringify(originalFlows)));
    for (const node of flows) {
        if (node.type === 'mqtt-broker') {
            node.broker = 'mosquitto';
            node.port = '1883';
            node.usetls = false;
            node.tls = '';
            report.replaced.push({ where: 'mqtt-broker', kind: 'test endpoint' });
        }
    }
    const tab = flows.find(n => n.type === 'tab' && /d#\d+/.test(n.label || ''));
    if (tab && !/TEST-GX/.test(tab.label)) tab.label += ' TEST-GX';
    put('.node-red/flows.json', JSON.stringify(flows, null, 4));
    for (const f of ['package.json', 'package-lock.json', '.config.nodes.json']) put('.node-red/' + f, text(path.join(nr, f)));
    put('.node-red/settings-user.js', "'use strict';\nmodule.exports = {};\n");

    // grid-control-config
    for (const f of cfgFiles) {
        const p = path.join(cfgSrc, f);
        if (f === 'email.json') { put('grid-control-config/' + f, '{"enabled":false}\n'); report.replaced.push({ where: f, kind: 'file' }); }
        else if (f === 'mcp-token.txt') { put('grid-control-config/' + f, crypto.randomBytes(32).toString('hex') + '\n'); report.replaced.push({ where: f, kind: 'file' }); }
        else put('grid-control-config/' + f, mapped(p));
    }

    // tools: code, with device ids replaced like everywhere else (backup copies *.pre-* / *.bak* are skipped)
    copyTree(path.join(src, 'tools'), 'tools', (r) => !/\.(pre-|bak)/.test(r) && !/\.pre-d/.test(r), mapped);

    // logs: last N days
    if (!flag('--no-logs')) {
        const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
        copyTree(path.join(src, 'grid-control-logs'), 'grid-control-logs', (r, e) => {
            if (e.isDirectory()) return true;
            const m = e.name.match(/(\d{4}-\d{2}-\d{2})/);
            return !m || m[1] >= cutoff;
        }, mapped);
    }

    // versions
    const pkg = JSON.parse(fs.readFileSync(path.join(nr, 'package.json'), 'utf8'));
    const nodes = JSON.parse(fs.readFileSync(path.join(nr, '.config.nodes.json'), 'utf8'));
    const palette = {};
    for (const v of Object.values(nodes)) if (v && v.name && v.version) palette[v.name] = v.version;
    const versions = { nodeRed: palette['node-red'], palette, packageJsonDependencies: pkg.dependencies };
    fs.writeFileSync(path.join(out, 'versions.json'), JSON.stringify(versions, null, 2));

    // leftover scan: every original value, plus generic patterns in every file; ALLOWED lists the legitimate matches
    const ALLOWED = [/^127\.\d+\.\d+\.\d+(:\d+)?$/, /^0\.0\.0\.0(:\d+)?$/, /^10\.99\.\d+\.\d+(:\d+)?$/, /@example\.invalid$/,
        /^(?:10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?$/,   // RFC 1918 private addresses (LAN broker etc.)
        /^0{31}1$/,                 // IPv6 loopback literal in the Victron client code
        /@victronenergy\.com$/];    // vendor address in the node package metadata
    const problems = [];
    const files = [];
    (function list(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? list(p) : files.push(p); } })(dst);
    for (const f of files) {
        const rel = path.relative(dst, f).replace(/\\/g, '/');
        if (/package-lock\.json$|\.config\.nodes\.json$/.test(rel)) continue;
        const t = fs.readFileSync(f, 'utf8');
        for (const v of mapping.keys()) if (t.includes(v)) problems.push(rel + ': original ' + secrets.get(v) + ' value still present');
        const generic = [
            [/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, 'tailscale address'],
            [/\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/g, 'ip:port'],
            [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, 'e-mail address'],
            [/\b[0-9a-f]{32}\b/gi, '32-char hex'],
            [/\b(?:token|apikey|api_key|access_token|secret)=[^&\s"'<>]{8,}/gi, 'token in URL/query'],
        ];
        for (const [re, label] of generic) {
            for (const m of t.match(re) || []) if (!ALLOWED.some((a) => a.test(m))) { problems.push(rel + ': ' + label); break; }
        }
    }
    report.problems = problems;
    fs.writeFileSync(path.join(out, 'sanitize-report.json'), JSON.stringify(report, null, 2));
    if (problems.length) {
        fs.rmSync(mapFile, { force: true });
        console.log('written ' + report.written.length + ' files, replaced ' + mapping.size + ' values, deleted ' + report.deleted.length + '; map not written');
        console.error('STOPPED: ' + problems.length + ' possible secret(s) left (see sanitize-report.json):');
        problems.slice(0, 20).forEach(p => console.error('  ' + p));
        process.exitCode = 3;
    } else {
        fs.writeFileSync(mapFile, JSON.stringify({ format: MAP_FORMAT, pairs: ordered.map(([from, to]) => ({ from, to, kind: secrets.get(from) })) }, null, 1));
        console.log('written ' + report.written.length + ' files, replaced ' + mapping.size + ' values, deleted ' + report.deleted.length
            + '; map ' + report.mapFile + ' (' + Object.entries(mapCounts).map(([k, n]) => n + ' ' + k).join(', ') + ')');
    }
}
