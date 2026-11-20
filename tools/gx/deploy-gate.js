#!/usr/bin/env node
'use strict';
// Decides whether a finished "Test GX scenarios" run may trigger the automatic GX deploy.
// Library: decide(inputs) -> { deploy, reason }. CLI: reads the inputs from env, writes the
// workflow outputs, a job summary and a ::warning when the deploy is skipped.
const fs = require('node:fs');

function decide({ conclusion, headBranch, event, headRepository, repository, headSha, masterSha } = {}) {
  if (conclusion !== 'success') return skip(`Test GX conclusion is ${conclusion || 'unknown'}.`);
  if (headBranch !== 'master' || event !== 'push' || !headRepository || headRepository !== repository) {
    return skip('Test GX run was not a push to master of this repository.');
  }
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) return skip('Invalid head SHA.');
  if (!/^[0-9a-f]{40}$/.test(masterSha || '')) return skip('Could not read the current master SHA.');
  if (masterSha !== headSha) return skip(`master moved on to ${masterSha}; ${headSha} is not the tip any more.`);
  return { deploy: true, reason: '' };
}

function skip(reason) {
  return { deploy: false, reason };
}

function main(env = process.env) {
  const result = decide({
    conclusion: env.CONCLUSION,
    headBranch: env.HEAD_BRANCH,
    event: env.HEAD_EVENT,
    headRepository: env.HEAD_REPO,
    repository: env.REPO,
    headSha: env.HEAD_SHA,
    masterSha: env.MASTER_SHA,
  });
  if (result.deploy) {
    append(env.GITHUB_OUTPUT, `run=true\nsha=${env.HEAD_SHA}\n`);
    return 0;
  }
  console.log(`::warning::Automatic GX deploy skipped: ${result.reason}`);
  append(env.GITHUB_OUTPUT, 'run=false\n');
  append(env.GITHUB_STEP_SUMMARY, `## Automatic GX deploy skipped\n\n${result.reason}\n\n` +
    'Deploy by hand if this commit should go live: Actions > Deploy GX code (see docs/gx-deploy.md).\n');
  return 0;
}

function append(file, text) {
  if (file) fs.appendFileSync(file, text);
}

if (require.main === module) process.exit(main());

module.exports = { decide, main };
