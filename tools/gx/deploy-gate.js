#!/usr/bin/env node
'use strict';
// Decides whether a finished "Test GX scenarios" run may trigger the automatic GX deploy.
// CLI: reads the triggering run and current master from env, then writes the
// workflow outputs, a job summary and a ::warning when the deploy is skipped.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const validSha = sha => /^[0-9a-f]{40}$/.test(sha || '');

function decide({ conclusion, headBranch, event, headRepository, repository, headSha, masterSha, pinnedSha },
  { isAncestor, eligibleHistory, greenShas } = {}) {
  if (conclusion !== 'success') return skip(`Test GX conclusion is ${conclusion || 'unknown'}.`);
  if (headBranch !== 'master' || event !== 'push' || !headRepository || headRepository !== repository) {
    return skip('Test GX run was not a push to master of this repository.');
  }
  if (!validSha(headSha)) return skip('Invalid head SHA.');
  if (!validSha(masterSha)) return skip('Could not read the current master SHA.');
  let sha = masterSha;
  if (masterSha !== headSha) {
    if (!isAncestor(headSha, masterSha)) return skip(`${headSha} is no longer an ancestor of master ${masterSha}.`);
    const history = eligibleHistory(masterSha);
    if (!history.length) return skip(`Could not establish the production history of master ${masterSha}.`);
    const green = new Set([headSha, ...greenShas(repository)]);
    sha = history.find(commit => green.has(commit));
    if (!sha) return skip(`No green master push at or after the latest production flow change (${history.at(-1)}); wait for its Test GX run.`);
  }
  if (pinnedSha && sha !== pinnedSha) return skip(`The selected green commit changed from ${pinnedSha} to ${sha}; its own run can deploy it.`);
  return { deploy: true, reason: '', sha };
}

function skip(reason) {
  return { deploy: false, reason };
}

const exec = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...args) => exec('git', args);
const lines = text => text ? text.split(/\r?\n/) : [];

function eligibleHistory(tip, runGit = git) {
  // The flow blob carries d#; also stop for any unversioned change or intervening revert.
  const production = runGit('log', '--first-parent', '-1', '--format=%H', tip, '--', 'flows.json');
  if (!validSha(production)) return [];
  return [...lines(runGit('rev-list', '--first-parent', `${production}..${tip}`)), production];
}

const sources = {
  isAncestor: (sha, tip) => {
    try { git('merge-base', '--is-ancestor', sha, tip); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  },
  eligibleHistory,
  greenShas: repo => lines(exec('gh', ['api', '--paginate',
    `repos/${repo}/actions/workflows/test-gx.yml/runs?branch=master&event=push&status=success&per_page=100`,
    '--jq', `.workflow_runs[] | select(.head_repository.full_name == ${JSON.stringify(repo)} and .head_branch == "master" and .event == "push" and .conclusion == "success") | .head_sha`]))
};

function main(env = process.env, lookup = sources) {
  const result = decide({
    conclusion: env.CONCLUSION,
    headBranch: env.HEAD_BRANCH,
    event: env.HEAD_EVENT,
    headRepository: env.HEAD_REPO,
    repository: env.REPO,
    headSha: env.HEAD_SHA,
    masterSha: env.MASTER_SHA,
    pinnedSha: env.PINNED_SHA,
  }, lookup);
  if (result.deploy) {
    console.log(`Automatic GX deploy selected green master commit ${result.sha}.`);
    append(env.GITHUB_OUTPUT, `run=true\nsha=${result.sha}\n`);
    return 0;
  }
  console.log(`::warning::Automatic GX deploy skipped: ${result.reason}`);
  append(env.GITHUB_OUTPUT, 'run=false\n');
  append(env.GITHUB_STEP_SUMMARY, `## Automatic GX deploy skipped\n\n${result.reason}\n\n` +
    'If newer production code is pending, wait for its Test GX run. For manual recovery, see docs/gx-deploy.md.\n');
  return 0;
}

function append(file, text) {
  if (file) fs.appendFileSync(file, text);
}

if (require.main === module) process.exit(main());

module.exports = { decide, eligibleHistory, main };
