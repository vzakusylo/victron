'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMail, groupFiles, MAX_COMMITS } = require('../tools/gx/deploy-mail.js');

const OLD = 'a'.repeat(40);
const NEW = '523ba74' + 'b'.repeat(33);
const base = {
    oldLabel: 'd#204', oldCommit: OLD, newLabel: 'd#205', newCommit: NEW,
    commits: [{ sha: 'c'.repeat(40), subject: 'Heat pump: defrost outdoor' }, { sha: 'd'.repeat(40), subject: 'Docs' }],
    files: ['40 Heat pump automations.js', 'lib/heat-pump/kick.js', 'flows.json', '39 Heat pump history page.html', 'tools/gx/deploy.js', 'docs/x.md'],
    trigger: { kind: 'automatic', testRunUrl: 'https://github.com/o/r/actions/runs/1' },
    testRunUrl: 'https://github.com/o/r/actions/runs/1',
    deployRunUrl: 'https://github.com/o/r/actions/runs/2',
    overwriteDrift: false
};

test('subject and old -> new line', () => {
    const mail = buildMail(base);
    assert.equal(mail.subject, 'GX deployed d#205 (523ba74)');
    assert.match(mail.text, /^d#204 \(aaaaaaa\) -> d#205 \(523ba74\)\n/);
});

test('text has grouped files, commits and both links', () => {
    const { text } = buildMail(base);
    assert.match(text, /flow sources: 40 Heat pump automations\.js/);
    assert.match(text, /lib: lib\/heat-pump\/kick\.js, flows\.json/);
    assert.match(text, /pages: 39 Heat pump history page\.html/);
    assert.match(text, /tools: tools\/gx\/deploy\.js/);
    assert.match(text, /other: 1 file\(s\), not deployed/);
    assert.match(text, /Commits \(2\):\n {2}ccccccc Heat pump: defrost outdoor\n {2}ddddddd Docs/);
    assert.match(text, /Test GX run: https:\/\/github\.com\/o\/r\/actions\/runs\/1/);
    assert.match(text, /Deploy run: https:\/\/github\.com\/o\/r\/actions\/runs\/2/);
});

test('automatic vs manual trigger', () => {
    assert.match(buildMail(base).text, /Trigger: automatic after Test GX run https:\/\/github\.com\/o\/r\/actions\/runs\/1/);
    const manual = buildMail({ ...base, trigger: { kind: 'manual', actor: 'vzakusylo' }, testRunUrl: '' });
    assert.match(manual.text, /Trigger: manual dispatch by vzakusylo/);
    assert.doesNotMatch(manual.text, /Test GX run:/);
});

test('the mail identifies an enabled drift override', () => {
    assert.doesNotMatch(buildMail(base).text, /overwrite_drift/);
    assert.match(buildMail({ ...base, overwriteDrift: true }).text, /overwrite_drift: ENABLED/);
});

test('a failed post-deploy check is visible in the subject and body of the deploy mail', () => {
    const { subject, text } = buildMail({ ...base, health: { status: 'FAIL', checks: [
        { level: 'FAIL', name: 'Outdoor average recovered', detail: 'No fresh outdoor average' }
    ] } });
    assert.match(subject, /health FAIL$/);
    assert.match(text, /Post-deploy health: FAIL\n  FAIL Outdoor average recovered: No fresh outdoor average/);
});

test('empty commit list and unknown previous version', () => {
    const empty = buildMail({ ...base, commits: [], files: [] });
    assert.match(empty.text, /Commits \(0\):\n {2}none/);
    assert.match(empty.text, /Changed files \(0\):\n {2}none/);
    const unknown = buildMail({ ...base, oldLabel: null, oldCommit: null, commits: [], files: null });
    assert.match(unknown.text, /^not recorded -> d#205/);
    assert.match(unknown.text, /comparison unavailable/);
});

test('long commit lists are truncated with +N more', () => {
    const commits = Array.from({ length: MAX_COMMITS + 7 }, (_, i) => ({ sha: String(i).padStart(40, '0'), subject: 'c' + i }));
    const { text } = buildMail({ ...base, commits });
    assert.match(text, new RegExp(`Commits \\(${MAX_COMMITS + 7}\\):`));
    assert.match(text, /\+7 more/);
    assert.equal(text.split('\n').filter((l) => /^ {2}[0-9a-f]{7} c\d+$/.test(l)).length, MAX_COMMITS);
});

test('no host, IP, address or token reaches the mail', () => {
    const { subject, text } = buildMail({
        ...base,
        commits: [{ sha: 'e'.repeat(40), subject: 'Use root@gx-host.tailnet.ts.net and 100.64.1.2\nsecond line' }],
        trigger: { kind: 'manual', actor: 'a@b.com' }
    });
    for (const part of [subject, text]) {
        assert.doesNotMatch(part, /root@|tailnet|\d+\.\d+\.\d+\.\d+|@/);
    }
    assert.match(text, /<address> and <ip> second line/);
});

test('groupFiles puts flows.json with lib and everything else in other', () => {
    const g = groupFiles(['flows.json', 'README.md', 'scripts/gx-deploy.ps1']);
    assert.deepEqual([g.lib, g.tools, g.other], [['flows.json'], ['scripts/gx-deploy.ps1'], ['README.md']]);
});

test('example mail text', () => {
    if (process.env.SHOW_MAIL) console.log(buildMail(base).text);
});
