#!/usr/bin/env node
/**
 * GitHub-hosted SQL 53 production evaluate entry.
 *
 * Reuses the official production apply pin and trusted-runner check.
 * Never applies SQL, never targets Lambda, and never loads issuer.key
 * onto checksops-production-prep-api.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printResult } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import {
  evaluateSql53TrustedRunner,
  loadSql53ProductionApplyPin,
} from './lib/sql53-production-apply.mjs';

export function githubSql53Identity(env = process.env) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    return fail(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main' && env.GITHUB_REF !== 'refs/heads/main') {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 53 GitHub evaluate may only run from main', { branch });
  }
  return ok({
    commit,
    branch: 'main',
    operator: actor,
    workstream_id: `github-sql53-production-evaluate-${runId}`,
  });
}

export function evaluateGithubSql53ProductionApply(env = process.env, { root } = {}) {
  const mode = String(env.CHECKSOPS_SQL53_GITHUB_MODE || 'evaluate').trim();
  if (mode !== 'evaluate') {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'SQL 53 GitHub entry is evaluate-only; apply stays on the official CLI',
      { mode },
    );
  }
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY === '1') {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'SQL 53 GitHub evaluate refuses CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1',
    );
  }
  const functionName = String(env.CHECKSOPS_SQL53_FUNCTION_NAME || '').trim();
  if (functionName === 'checksops-production-prep-api'
    || functionName === 'checksops-staging-guarded-sql-executor') {
    return fail(
      CODES.UNRELATED_MUTATION,
      'SQL 53 GitHub evaluate must not retarget the production API or staging executor',
    );
  }
  const resolvedRoot = root || repoRootFrom(import.meta.url);
  const pin = loadSql53ProductionApplyPin(resolvedRoot);
  const identity = githubSql53Identity(env);
  if (!identity.ok) return identity;
  const runner = evaluateSql53TrustedRunner(env, { root: resolvedRoot, pin });
  if (!runner.ok) return runner;
  return ok({
    ...runner.details,
    identity: identity.details,
    filename: pin.filename,
    function_identity: pin.function_identity,
    apply_executed: false,
    sql_not_executed: true,
  });
}

function appendGithubOutput(values, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`);
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

export function main(env = process.env, deps = {}) {
  const result = (deps.evaluate || evaluateGithubSql53ProductionApply)(env, {
    root: deps.root || repoRootFrom(import.meta.url),
  });
  if (result.ok) {
    appendGithubOutput({
      recommended_environment: result.details.recommended_environment,
      github_can_apply: String(result.details.github_can_apply),
      pin_execute: String(result.details.pin_execute),
      source_sha256: result.details.source_sha256,
    }, env);
  }
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
