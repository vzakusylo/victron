'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { decide, eligibleHistory, main } = require('../tools/gx/deploy-gate.js');

const SHA = 'a'.repeat(40);
const ok = {
  conclusion: 'success', headBranch: 'master', event: 'push',
  headRepository: 'o/r', repository: 'o/r', headSha: SHA, masterSha: SHA,
};

test('deploys a green push to master that is still the tip', () => {
  assert.deepEqual(decide(ok), { deploy: true, reason: '', sha: SHA });
});

test('selects the newest green master ancestor, but never crosses an untested flow change', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-gate-history-'));
  t.after(() => fs.rmSync(cwd, { force: true, recursive: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  const commit = (file, contents) => {
    fs.writeFileSync(path.join(cwd, file), contents);
    git('add', file);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', contents);
    return git('rev-parse', 'HEAD');
  };
  const older = commit('flows.json', '[{"label":"d#1 GX"}]');
  const newestGreen = commit('docs.txt', 'first doc');
  const tip = commit('docs.txt', 'second doc');
  const lookup = {
    isAncestor: () => true,
    eligibleHistory: sha => eligibleHistory(sha, git),
    greenShas: () => [older, 'f'.repeat(40), newestGreen],
  };
  assert.equal(decide({ ...ok, headSha: older, masterSha: tip }, lookup).sha, newestGreen);
  assert.match(decide({ ...ok, headSha: older, masterSha: tip, pinnedSha: older }, lookup).reason, /selected green commit changed/);
  const pending = commit('flows.json', '[{"label":"d#2 GX"}]');
  assert.match(decide({ ...ok, headSha: older, masterSha: pending }, lookup).reason, /latest production flow change/);
  assert.match(decide({ ...ok, headSha: older, masterSha: pending }, {
    ...lookup, isAncestor: () => false
  }).reason, /no longer an ancestor/);
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
    assert.equal(main(env, { isAncestor: () => false }), 0);
    assert.match(logged, /^::warning::Automatic GX deploy skipped: .*no longer an ancestor/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'run=false\n');
    assert.match(fs.readFileSync(summary, 'utf8'), /no longer an ancestor/);
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

test('deploy workflow: auto path requests verified replacement, not the manual override', () => {
  assert.match(deploy, /environment: \$\{\{ github\.event_name == 'workflow_run' && 'victron-gx-auto' \|\| 'victron-gx' \}\}/);
  assert.match(deploy, /MODE: \$\{\{ github\.event_name == 'workflow_run' && 'apply' \|\| inputs\.mode \}\}/);
  assert.match(deploy, /ALLOW_LIVE_ONLY_LINES: \$\{\{ github\.event_name == 'workflow_run' && 'false' \|\| inputs\.allow_live_only_lines \}\}/);
  assert.match(deploy, /if \(\$env:AUTO -ne 'true' -and \$env:ALLOW_LIVE_ONLY_LINES -eq 'true'\) \{ \$arguments \+= '-AllowLiveOnlyLines' \}\n\s+else \{ \$arguments \+= '-AllowReplaceDeployedLines' \}/);
  const script = fs.readFileSync(path.join(root, '..', '..', 'scripts', 'gx-deploy.ps1'), 'utf8');
  assert.match(script, /if \(\$AllowReplaceDeployedLines\) \{ \$planFlags \+= '--allow-replace-deployed-lines' \}/);
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

test('deploy workflow: reviewed removals are a dispatch-only allowlist', () => {
  assert.match(deploy, /^      allow_removed_nodes:\n        description: [^\n]+\n        type: string\n        default: ""$/m);
  assert.match(deploy, /ALLOW_REMOVED_NODES: \$\{\{ inputs\.allow_removed_nodes \}\}/);
  assert.match(deploy, /if \(\$env:AUTO -ne 'true' -and \$env:ALLOW_REMOVED_NODES\) \{ \$arguments \+= @\('-AllowRemovedNodes', \$env:ALLOW_REMOVED_NODES\) \}/);
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
  assert.match(final, /needs: \[build, run\]/);
  assert.match(final, /\[\[ "\$BUILD_RESULT" == success \]\]/);
  assert.match(final, /\[\[ "\$RESULT" == success \]\]/);
});

test('test-gx workflow: only PRs can skip scenarios based on changed paths', () => {
  const detect = testGx.split('name: Detect relevant changes')[1].split('\n      - ')[0];
  assert.match(detect, /relevant=true\s+(?:#[^\n]*\n\s*)?if \[\[ "\$EVENT" == "pull_request" &&/);
  assert.match(detect, /if \[\[ "\$EVENT" == "pull_request" &&[\s\S]+?git diff --name-only "\$BASE_SHA" HEAD[\s\S]+?relevant=false\s+fi\s+fi/);
  assert.doesNotMatch(detect, /github\.event\.before/);
  assert.match(testGx, /name: Run all scenarios\s+if: needs\.build\.outputs\.relevant == 'true'/);
});

test('test-gx workflow: matrix uses the build job artifact without rebuilding images', () => {
  const [, build, run] = testGx.split(/^  (?:build|run|scenarios):\r?$/m);
  assert.match(build, /docker compose .+ build nodered/);
  assert.match(build, /docker save mqtt:latest "test-gx-nodered:\$TEST_GX_TAG"/);
  assert.match(build, /image-artifact: \$\{\{ steps\.bundle\.outputs\.name \}\}/);
  assert.match(build, /uses: actions\/upload-artifact@[a-f0-9]+\s+[^\n]+\s+with:\s+name: \$\{\{ steps\.bundle\.outputs\.name \}\}/);
  assert.match(run, /name: scenarios \(\$\{\{ matrix\.files \}\}\)\s+needs: build/);
  assert.match(run, /uses: actions\/download-artifact@[a-f0-9]+\s+[^\n]+\s+with:\s+name: \$\{\{ needs\.build\.outputs\.image-artifact \}\}/);
  assert.match(run, /docker load --input "\$RUNNER_TEMP\/test-gx-images\.tar\.zst"[\s\S]+docker compose .+ up -d --no-build/);
  assert.doesNotMatch(run, /docker build|compose .+ build nodered|up .+ --build/);
});
