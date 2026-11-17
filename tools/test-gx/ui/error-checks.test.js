'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyErrors } = require('./error-checks');

const known = { type: 'console', text: 'known', bug: 'bug-1', node: 'node-1' };
const boot = { type: 'console', text: 'boot', url: '/app.js', phase: 'before-first-menu-click' };
const allowlist = [{ ...boot, reason: 'boot only' }];

test('requires each expected error and accepts repeated matching occurrences', () => {
    assert.deepEqual(classifyErrors([known, known], [], [known]), { unexpected: [], missing: [] });
    assert.deepEqual(classifyErrors([], [], [known]), { unexpected: [], missing: [known] });
});

test('an expected error does not hide unrelated or inexact errors', () => {
    const other = { type: 'console', text: 'known changed' };
    assert.deepEqual(classifyErrors([known, other], [], [known]), { unexpected: [other], missing: [] });
});

test('the SideNav allowlist applies before the first click only', () => {
    const late = { ...boot, phase: 'after-first-menu-click' };
    assert.deepEqual(classifyErrors([boot, late], allowlist, []), { unexpected: [late], missing: [] });
});
