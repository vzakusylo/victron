const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'tools', 'test-gx', 'sanitize-backup.js');
const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// minimal fake GX backup; extra = { 'relative/path': content } is added under data/home/nodered
function makeBackup(name, extra) {
  const root = path.join(tmp, name + '-src');
  const nr = path.join(root, 'data', 'home', 'nodered');
  const files = {
    '.node-red/flows.json': JSON.stringify([{ id: 't1', type: 'tab', label: 'Grid d#1 [git aaaaaaaaaaaa]' }]),
    '.node-red/package.json': JSON.stringify({ dependencies: {} }),
    '.node-red/package-lock.json': '{}',
    '.node-red/.config.nodes.json': JSON.stringify({ 'node-red': { name: 'node-red', version: '3.1.15' } }),
    'grid-control-config/settings.json': '{}',
    ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(nr, rel)), { recursive: true });
    fs.writeFileSync(path.join(nr, rel), body);
  }
  const tar = path.join(tmp, name + '.tar.gz');
  execFileSync('tar', ['-czf', tar, '-C', root, 'data']);
  return tar;
}
const run = (tar, out) => spawnSync(process.execPath, [SCRIPT, tar, out], { encoding: 'utf8' });

test('refuses an output directory that is, contains or sits inside the repository', () => {
  const tar = makeBackup('guard', {});
  for (const out of [REPO, path.dirname(REPO), path.join(REPO, 'tools'), path.resolve(REPO, '..', '..'), '.', '..', os.homedir()]) {
    assert.strictEqual(run(tar, out).status, 64, out);
  }
  assert.ok(fs.existsSync(path.join(REPO, 'flows.json')));
});

test('refuses to wipe a non-empty directory it did not create', () => {
  const tar = makeBackup('foreign', {});
  const out = path.join(tmp, 'foreign-out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'keep.txt'), 'x');
  assert.strictEqual(run(tar, out).status, 64);
  assert.ok(fs.existsSync(path.join(out, 'keep.txt')));
});

test('writes a marker, and a second run over its own output works', () => {
  const tar = makeBackup('rerun', {});
  const out = path.join(tmp, 'rerun-out');
  const r1 = run(tar, out);
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.ok(fs.existsSync(path.join(out, '.test-gx-sanitized')));
  const r2 = run(tar, out);
  assert.strictEqual(r2.status, 0, r2.stderr);
});

test('the repository flows.json and tools/ pass the leftover scan (LAN broker address is allowed)', () => {
  const tools = {};
  for (const f of execFileSync('git', ['ls-files', 'tools'], { cwd: REPO, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)) {
    if (/\.(js|ps1|sh|py|json|md|yml)$/.test(f)) tools[f] = fs.readFileSync(path.join(REPO, f), 'utf8');
  }
  const registry = Object.fromEntries(['pump', 'valve', 'bypass', 'meter'].map(role => ['hp-tuya-' + role + '-01', { deviceId: 'fake-' + role }]));
  const tar = makeBackup('repo-flow', { ...tools, '.node-red/flows.json': fs.readFileSync(path.join(REPO, 'flows.json'), 'utf8'),
    'grid-control-config/tuya-nodes.json': JSON.stringify(registry) });
  const r = run(tar, path.join(tmp, 'repo-flow-out'));
  assert.strictEqual(r.status, 0, r.stderr);
});

test('stops (exit 3) when a token is left in flows.json or in tools/', () => {
  const tokenUrl = 'http://example.test/api?token=' + 'Zx9'.repeat(8);
  const inFlow = makeBackup('leak-flow', { '.node-red/flows.json': JSON.stringify([{ id: 't1', type: 'function', func: 'fetch("' + tokenUrl + '")' }]) });
  const inTool = makeBackup('leak-tool', { 'tools/x.js': 'const u = "' + tokenUrl + '";\n' });
  const tailnet = makeBackup('leak-ip', { 'tools/y.js': 'const h = "100.64.1.2:8080";\n' });
  for (const [tar, name] of [[inFlow, 'f'], [inTool, 't'], [tailnet, 'i']]) {
    assert.strictEqual(run(tar, path.join(tmp, 'out-' + name)).status, 3, name);
  }
});

test('compressed recorder logs survive sanitization and are scanned after decompression', () => {
  const zlib = require('node:zlib');
  const ip = '192.168.1.123';
  const tar = makeBackup('gzip-log', {
    'grid-control-config/example.json': JSON.stringify({ ip }),
    'grid-control-logs/heatpump/2099-01-01/00.csv.gz': zlib.gzipSync(Buffer.from('#hp1 t,st,108\n0,C,46\n# ' + ip + '\n')),
  });

  const out = path.join(tmp, 'gzip-log-out');
  const r = run(tar, out);
  assert.strictEqual(r.status, 0, r.stderr);
  const text = zlib.gunzipSync(fs.readFileSync(path.join(out, 'nodered', 'grid-control-logs', 'heatpump', '2099-01-01', '00.csv.gz'))).toString();
  assert.ok(text.includes('0,C,46'));
  assert.ok(!text.includes(ip));
  const leak = makeBackup('gzip-leak', {
    'grid-control-logs/heatpump/2099-01-01/00.csv.gz': zlib.gzipSync(Buffer.from('http://example.test/?token=' + 'Zx9'.repeat(8))),
  });
  assert.strictEqual(run(leak, path.join(tmp, 'gzip-leak-out')).status, 3);
});

test('sanitizer fails closed on a Tuya device with no proxy model', () => {
  const tar = makeBackup('unsupported-tuya', { '.node-red/flows.json': JSON.stringify([
    { id: 'unexpected-tuya', type: 'tuya-smart-device', deviceId: 'fake-id', wires: [[], []] },
  ]) });
  const out = path.join(tmp, 'unsupported-tuya-out');
  const r = run(tar, out);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /Unmodelled tuya-smart-device/);
  assert.ok(!fs.existsSync(out + '.map.json'));
  assert.ok(!fs.existsSync(path.join(out, 'nodered', '.node-red', 'flows.json')));
});

test('Tuya comparison source is sanitized and scanned even when a field is removed from the proxy', () => {
  const nodes = [
    { id: 'broker', type: 'mqtt-broker', broker: '192.168.1.94', port: '1883' },
    { id: 'hp-tuya-pump-01', type: 'tuya-smart-device', deviceId: 'fake-pump', deviceKey: 'private-key-for-test', wires: [[], []] },
  ];
  const tar = makeBackup('tuya-source-safe', { '.node-red/flows.json': JSON.stringify(nodes) });
  const out = path.join(tmp, 'tuya-source-safe-out');
  const r = run(tar, out);
  assert.strictEqual(r.status, 0, r.stderr);
  const source = fs.readFileSync(path.join(out, 'tuya-source-flows.json'), 'utf8');
  assert.ok(!source.includes('private-key-for-test'));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'sanitize-report.json'))).transformed.length, 4);
  nodes[1].unused = 'http://example.test/?token=' + 'Zx9'.repeat(8);
  const leak = makeBackup('tuya-source-leak', { '.node-red/flows.json': JSON.stringify(nodes) });
  assert.strictEqual(run(leak, path.join(tmp, 'tuya-source-leak-out')).status, 3);
});
