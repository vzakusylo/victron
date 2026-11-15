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

test('stops (exit 3) when a token is left in flows.json or in tools/', () => {
  const tokenUrl = 'http://example.test/api?token=' + 'Zx9'.repeat(8);
  const inFlow = makeBackup('leak-flow', { '.node-red/flows.json': JSON.stringify([{ id: 't1', type: 'function', func: 'fetch("' + tokenUrl + '")' }]) });
  const inTool = makeBackup('leak-tool', { 'tools/x.js': 'const u = "' + tokenUrl + '";\n' });
  const tailnet = makeBackup('leak-ip', { 'tools/y.js': 'const h = "100.64.1.2:8080";\n' });
  for (const [tar, name] of [[inFlow, 'f'], [inTool, 't'], [tailnet, 'i']]) {
    assert.strictEqual(run(tar, path.join(tmp, 'out-' + name)).status, 3, name);
  }
});
