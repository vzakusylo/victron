'use strict';
// R5: build-time `// #include lib/…js` in the numbered sources (tools/includes.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { expand, includesOf } = require('../tools/includes');

function tmp(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-'));
    for (const [f, t] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), t);
    }
    return dir;
}

test('an include line is replaced by the file text; //! header and trailing blanks are dropped; CRLF ok', () => {
    const dir = tmp({ 'lib/a.js': '//! header\r\n//! more\r\nfunction a() { return 1; }\r\n\r\n' });
    assert.equal(expand('x\r\n// #include lib/a.js\r\ny', dir), 'x\nfunction a() { return 1; }\ny');
    assert.deepEqual(includesOf('// #include lib/a.js\nz'), ['lib/a.js']);
});

test('a source without includes is returned unchanged', () => {
    assert.equal(expand('a\r\nb', os.tmpdir()), 'a\r\nb');
});

test('missing files, nesting and paths outside lib/ are errors', () => {
    const dir = tmp({ 'lib/n.js': '// #include lib/a.js\n' });
    assert.throws(() => expand('// #include lib/none.js', dir), /not found/);
    assert.throws(() => expand('// #include lib/n.js', dir), /does not nest/);
    assert.throws(() => expand('// #include lib/../x.js', dir), /inside lib/);
});

test('the repository lib/ files are each included exactly once and flows.js check passes', () => {
    const root = path.join(__dirname, '..');
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'flows.js'), 'check'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const used = fs.readdirSync(root).filter((f) => /^\d\d .+\.(js|html)$/.test(f))
        .flatMap((f) => includesOf(fs.readFileSync(path.join(root, f), 'utf8')));
    assert.ok(used.includes('lib/heat-pump/heating-decide.js'));
    assert.ok(used.includes('lib/grid/helpers.js'));
    assert.equal(new Set(used).size, used.length);
});
