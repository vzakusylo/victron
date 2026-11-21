'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decide, main } = require('../tools/gx/deploy-gate.js');

const SHA = 'a'.repeat(40);
const ok = {
  conclusion: 'success', headBranch: 'master', event: 'push',
  headRepository: 'o/r', repository: 'o/r', headSha: SHA, masterSha: SHA,
};

test('deploys a green push to master that is still the tip', () => {
  assert.deepEqual(decide(ok), { deploy: true, reason: '' });
});

for (const [name, patch, reason] of [
  ['failure', { conclusion: 'failure' }, /conclusion is failure/],
  ['cancelled', { conclusion: 'cancelled' }, /conclusion is cancelled/],
  ['other branch', { headBranch: 'feature' }, /not a push to master/],
  ['pull_request event', { event: 'pull_request' }, /not a push to master/],
  ['fork repo', { headRepository: 'evil/r' }, /not a push to master/],
  ['missing head repo', { headRepository: '' }, /not a push to master/],
  ['malformed sha', { headSha: 'abc', masterSha: 'abc' }, /Invalid head SHA/],
  ['uppercase sha', { headSha: 'A'.repeat(40) }, /Invalid head SHA/],
  ['unreadable master', { masterSha: '' }, /current master SHA/],
  ['master moved', { masterSha: 'b'.repeat(40) }, /master moved on to b{40}/],
]) {
  test(`skips: ${name}`, () => {
    const result = decide({ ...ok, ...patch });
    assert.equal(result.deploy, false);
    assert.match(result.reason, reason);
  });
}

test('CLI writes outputs, a warning and a job summary when skipping', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const output = path.join(dir, 'out');
  const summary = path.join(dir, 'sum');
  const env = {
    CONCLUSION: 'success', HEAD_BRANCH: 'master', HEAD_EVENT: 'push', HEAD_REPO: 'o/r', REPO: 'o/r',
    HEAD_SHA: SHA, MASTER_SHA: 'b'.repeat(40), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
  };
  const log = console.log;
  let logged = '';
  console.log = (line) => { logged += line; };
  try {
    assert.equal(main(env), 0);
    assert.match(logged, /^::warning::Automatic GX deploy skipped: master moved on/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'run=false\n');
    assert.match(fs.readFileSync(summary, 'utf8'), /master moved on/);
    main({ ...env, MASTER_SHA: SHA });
    assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`run=true\\nsha=${SHA}\\n$`));
  } finally {
    console.log = log;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const root = path.join(__dirname, '..', '.github', 'workflows');
const deploy = fs.readFileSync(path.join(root, 'deploy-gx-code.yml'), 'utf8').replace(/\r\n/g, '\n');
const testGx = fs.readFileSync(path.join(root, 'test-gx.yml'), 'utf8');

test('deploy workflow: auto path is victron-gx-auto, apply, no live-only lines', () => {
  assert.match(deploy, /environment: \$\{\{ github\.event_name == 'workflow_run' && 'victron-gx-auto' \|\| 'victron-gx' \}\}/);
  assert.match(deploy, /MODE: \$\{\{ github\.event_name == 'workflow_run' && 'apply' \|\| inputs\.mode \}\}/);
  assert.match(deploy, /ALLOW_LIVE_ONLY_LINES: \$\{\{ github\.event_name == 'workflow_run' && 'false' \|\| inputs\.allow_live_only_lines \}\}/);
  assert.match(deploy, /node tools\/gx\/deploy-gate\.js/);
});

test('deploy workflow: manual path keeps master check and confirm', () => {
  assert.match(deploy, /'victron-gx'/);
  assert.match(deploy, /\[\[ "\$GITHUB_REF" == "refs\/heads\/master" \]\]/);
  assert.match(deploy, /"\$MODE" == "apply" && "\$CONFIRM" != "deploy-gx-code"/);
});

test('deploy workflow: reviewed additions are manual and default to off', () => {
  assert.match(deploy, /^      allow_new_nodes:\n        description: [^\n]+\n        type: boolean\n        default: false$/m);
  assert.match(deploy, /ALLOW_NEW_NODES: \$\{\{ github\.event_name == 'workflow_run' && 'false' \|\| inputs\.allow_new_nodes \}\}/);
  assert.match(deploy, /if \(\$env:ALLOW_NEW_NODES -eq 'true'\) \{ \$arguments \+= '-AllowNewNodes' \}/);
});

test('deploy workflow: the mail step is apply-only, after the apply, and never fails the deploy', () => {
  const step = deploy.split('- name: Send deploy mail')[1].split('\n      - name:')[0];
  assert.ok(deploy.indexOf('- name: Deploy from master') < deploy.indexOf('- name: Send deploy mail'));
  assert.match(step, /if: steps\.deploy\.outcome == 'success' && env\.MODE == 'apply'/);
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /node \/data\/home\/nodered\/tools\/send-mail\.js/);
  assert.match(step, /::warning::deploy mail: failed/);
  assert.match(step, /deploy mail: sent/);
  assert.doesNotMatch(step, /dry-run|MODE == 'dry/);
  assert.equal(deploy.split('send-mail.js').length - 1, 1, 'one mail step only');
});

test('test-gx workflow: required check always reports; only PRs cancel in-progress runs', () => {
  assert.doesNotMatch(testGx, /^\s+paths:/m);
  assert.match(testGx, /^  scenarios:/m);
  assert.match(testGx, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(testGx, /':\(glob\)tools\/\*\*'/);
  assert.match(testGx, /scripts\/gx-\*\.ps1/);
});

test('test-gx workflow: one parallel job per scenario file, final scenarios job needs all of them', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'tools', 'test-gx', 'scenarios')).filter(f => /\.ya?ml$/.test(f)).sort();
  const m = testGx.match(/files: \[([^\]]+)\]/);
  assert.ok(m, 'matrix of scenario files');
  assert.deepEqual(m[1].split(',').map(s => s.trim()).sort(), files, 'every scenario file runs in exactly one job');
  assert.match(testGx, /fail-fast: false/);
  assert.match(testGx, /run-scenarios\.js --file "\$FILES"/);
  const final = testGx.split(/^  scenarios:/m)[1];
  assert.match(final, /if: always\(\)/);
  assert.match(final, /needs: run/);
  assert.match(final, /\[\[ "\$RESULT" == success \]\]/);
});

test('test-gx workflow: only PRs can skip scenarios based on changed paths', () => {
  const detect = testGx.split('name: Detect relevant changes')[1].split('\n      - ')[0];
  assert.match(detect, /relevant=true\s+(?:#[^\n]*\n\s*)?if \[\[ "\$EVENT" == "pull_request" &&/);
  assert.match(detect, /if \[\[ "\$EVENT" == "pull_request" &&[\s\S]+?git diff --name-only "\$BASE_SHA" HEAD[\s\S]+?relevant=false\s+fi\s+fi/);
  assert.doesNotMatch(detect, /github\.event\.before/);
  assert.match(testGx, /name: Run all scenarios\s+if: steps\.changes\.outputs\.relevant == 'true'/);
});
