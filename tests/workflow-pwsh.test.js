'use strict';
// PowerShell passes `(expression), $variable` to a NATIVE program as literal text
// ("(Split-Path", "$dir),", "$dir"). The Windows test replaces chmod by a function, where the same
// line works, so the first real run of the deploy workflow on Linux failed on 14 Nov 2026.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./harness');

const NATIVE = /^\s*(?:&\s+)?(chmod|chown|tar|node|ssh|scp|gh|git|install)\b/;

test('workflow PowerShell steps never pass "(expression)," to a native program', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const bad = [];
    for (const file of fs.readdirSync(dir)) {
        fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).forEach((line, index) => {
            if (NATIVE.test(line) && /\)\s*,/.test(line)) bad.push(file + ':' + (index + 1) + ': ' + line.trim());
        });
    }
    assert.deepEqual(bad, []);
});

test('pwsh really passes a parenthesised expression followed by a comma literally (why the rule exists)', (t) => {
    const probe = spawnSync('pwsh', ['-NoProfile', '-Command',
        "$d = 'a/b'; & node -e 'console.log(JSON.stringify(process.argv.slice(1)))' 700 (Split-Path $d), $d; "
        + "& node -e 'console.log(JSON.stringify(process.argv.slice(1)))' 700 (Split-Path $d) $d"], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { t.skip('pwsh is not available here'); return; }
    const [withComma, withSpace] = probe.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(withComma, ['700', '(Split-Path', '$d),', '$d']);
    assert.deepEqual(withSpace, ['700', 'a', 'a/b']);
});
