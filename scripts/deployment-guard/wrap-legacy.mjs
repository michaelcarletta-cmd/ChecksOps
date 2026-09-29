#!/usr/bin/env node
/**
 * Approved wrapper for inventoried shared-target writers.
 * Validates identity/lease, issues a short-lived receipt, then optionally
 * execs the legacy script with CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT set.
 * This wrapper does not deploy on its own.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { evaluateDeployment, gitIdentity } from './lib/guard.mjs';
import { acquireLease } from './lib/lease.mjs';
import { issueReceipt } from './lib/receipt.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function prepareGuardedInvocation(input = {}, ctx = {}) {
  const root = ctx.root;
  const env = ctx.env || process.env;
  const git = gitIdentity(root, env);
  const payload = {
    ...input,
    workstream_id: input.workstream_id,
    branch: input.branch || git.branch,
    commit: input.commit || git.commit,
    operator: input.operator || git.operator,
    apply: false,
  };
  const lease = acquireLease(root, {
    workstream_id: payload.workstream_id,
    component: payload.target_component,
    environment: payload.target_environment,
    commit: payload.commit,
    operator: payload.operator,
    ttl_ms: input.ttl_ms,
  }, ctx.now);
  if (!lease.ok) return lease;
  payload.lease = lease.details.lease;
  const evaluation = evaluateDeployment(payload, {
    root,
    env,
    skip_contracts: input.skip_contracts === true || ctx.skip_contracts === true,
    aws: ctx.aws,
  });
  if (!evaluation.ok) return evaluation;
  const issued = issueReceipt(root, {
    workstream_id: payload.workstream_id,
    branch: payload.branch,
    commit: payload.commit,
    operator: payload.operator,
    target_environment: payload.target_environment,
    target_component: payload.target_component,
    deployment_type: payload.deployment_type,
    owned_components: payload.owned_components || payload.owned_members,
    preflight_live_fingerprint: payload.preflight || payload.preflight_live_fingerprint,
    lease: payload.lease,
  }, { now: ctx.now, ttlMs: input.ttl_ms });
  if (!issued.ok) return issued;
  return {
    ok: true,
    code: null,
    message: null,
    details: {
      ...evaluation.details,
      lease: payload.lease,
      receipt: issued.details.receipt,
      receipt_file: issued.details.file,
    },
    errors: [],
  };
}

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url), env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const input = readInput(opts, {});
  const prepared = prepareGuardedInvocation(input, { root, env, skip_contracts: true });
  if (!prepared.ok) return printResult(prepared);
  const childEnv = {
    ...env,
    CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: prepared.details.receipt_file,
    CHECKSOPS_DEPLOYMENT_GUARD_ROOT: root,
    CHECKSOPS_WORKSTREAM_ID: input.workstream_id,
    CHECKSOPS_COMMIT: input.commit || prepared.details.receipt.commit,
  };
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_EXEC_LEGACY === '1' && positional.length) {
    const child = spawnSync(positional[0], positional.slice(1), { cwd: root, env: childEnv, stdio: 'inherit' });
    return child.status ?? 1;
  }
  return printResult({
    ok: true,
    code: null,
    message: null,
    details: {
      ...prepared.details,
      legacy_exec_skipped: true,
      note: 'Receipt issued. Legacy child is not executed unless CHECKSOPS_DEPLOYMENT_GUARD_EXEC_LEGACY=1.',
    },
    errors: [],
  });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
