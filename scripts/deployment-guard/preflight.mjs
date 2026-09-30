#!/usr/bin/env node
/**
 * Official ChecksOps deployment preflight.
 * Evaluates workstream identity, leases, live-state rules, and contracts.
 * Does not deploy, write AWS, mutate SQL, or change staging/production.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { evaluateDeployment, gitIdentity, writeReceipt } from './lib/guard.mjs';
import { acquireLease } from './lib/lease.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url), env = process.env) {
  const { flags, opts } = parseArgs(argv);
  const input = readInput(opts, {});
  const git = gitIdentity(root, env);
  const payload = {
    workstream_id: opts['workstream-id'] || input.workstream_id,
    branch: opts.branch || input.branch || git.branch,
    commit: opts.commit || input.commit || git.commit,
    operator: opts.operator || input.operator || git.operator,
    target_environment: opts.environment || input.target_environment,
    target_component: opts.component || input.target_component,
    deployment_type: opts.type || input.deployment_type,
    owned_members: input.owned_members || input.owned_components,
    owned_components: input.owned_components || input.owned_members,
    preflight: input.preflight || input.preflight_live_fingerprint,
    preflight_live_fingerprint: input.preflight || input.preflight_live_fingerprint,
    immediately_before: input.immediately_before,
    live_members: input.live_members,
    candidate_members: input.candidate_members,
    peer_sources: input.peer_sources,
    package: input.package,
    dist: input.dist,
    clean_build: input.clean_build,
    frontend_workstreams: input.frontend_workstreams,
    accepted_composition: input.accepted_composition,
    accepted_source_composition: input.accepted_source_composition,
    source_composition_manifest: input.source_composition_manifest,
    filename: input.filename,
    migration_id: input.migration_id,
    source_sha256: input.source_sha256,
    intended_replacement_sha256: input.intended_replacement_sha256,
    expected_live_definition_sha256: input.expected_live_definition_sha256,
    live_definition_sha256: input.live_definition_sha256,
    live_definition: input.live_definition,
    one_use_id: input.one_use_id,
    expiry: input.expiry,
    action: input.action,
    function_name: input.function_name,
    plan: input.plan,
    production_fingerprint: input.production_fingerprint,
    immediately_before_fingerprint: input.immediately_before_fingerprint,
    staging_acceptance: input.staging_acceptance,
    approval: input.approval,
    contract_results: input.contract_results,
    previously_accepted: input.previously_accepted,
    build_timestamp: opts['build-timestamp'] || input.build_timestamp || new Date().toISOString(),
    apply: false,
  };

  if (flags['acquire-lease'] || opts['acquire-lease']) {
    const lease = acquireLease(root, {
      workstream_id: payload.workstream_id,
      component: payload.target_component,
      environment: payload.target_environment,
      commit: payload.commit,
      operator: payload.operator,
      ttl_ms: opts.ttl ? Number(opts.ttl) : undefined,
    });
    if (!lease.ok) return printResult(lease);
    payload.lease = lease.details.lease;
  }

  const result = evaluateDeployment(payload, { root, env, skip_contracts: flags['skip-contracts'] === true });
  if (result.ok && (flags.receipt || payload.lease)) {
    const file = writeReceipt(root, result, {
      workstream_id: payload.workstream_id,
      branch: payload.branch,
      commit: payload.commit,
      operator: payload.operator,
      target_environment: payload.target_environment,
      target_component: payload.target_component,
      deployment_type: payload.deployment_type,
      owned_components: payload.owned_components,
      preflight_live_fingerprint: payload.preflight_live_fingerprint,
      lease: payload.lease,
    });
    result.details.receipt = file;
    result.details.lease = payload.lease || result.details.lease;
  }
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
