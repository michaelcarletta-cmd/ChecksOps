import fs from 'node:fs';
import path from 'node:path';
import { CODES, failMany, ok } from './errors.mjs';
import { createForbiddenAwsAdapter, assertNoLiveAwsCalls } from './aws-adapter.mjs';
import { buildManifest, gitIdentity, validateWorkstreamIdentity } from './identity.mjs';
import { evaluateLambdaOverlay, planLambdaApply } from './lambda-overlay.mjs';
import { evaluateSpaPromote } from './spa-promote.mjs';
import { evaluateSqlApply } from './sql-apply.mjs';
import { evaluateSqlExecutorAuthorization } from './sql-executor-auth.mjs';
import { acquireLease, inspectLease, releaseLease } from './lease.mjs';
import { loadContractRegistry } from './contracts.mjs';
import { evaluateProductionGate } from './production.mjs';
import { verifyLiveState } from './verify-live.mjs';
import { receiptDir, repoRootFrom } from './paths.mjs';
import { issueReceipt } from './receipt.mjs';
import { loadCompositionRegistry } from './source-composition.mjs';
import { evaluatePreserveBuilds, evaluateRequiredRegressionChecks } from './preserve-builds.mjs';

function loadRegistryFromRoots(loader, ...roots) {
  for (const candidate of roots) {
    if (!candidate) continue;
    try {
      return loader(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

export function loadJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

export function evaluateDeployment(input = {}, ctx = {}) {
  const root = ctx.root;
  const aws = ctx.aws || createForbiddenAwsAdapter();
  const identityInput = {
    workstream_id: input.workstream_id,
    branch: input.branch,
    commit: input.commit,
    operator: input.operator,
    target_environment: input.target_environment,
    deployment_type: input.deployment_type,
    owned_components: input.owned_members || input.owned_components,
    preflight_live_fingerprint: input.preflight || input.preflight_live_fingerprint,
    build_timestamp: input.build_timestamp,
  };
  const identity = validateWorkstreamIdentity(identityInput);
  if (!identity.ok) return withAws(identity, aws);

  const production = evaluateProductionGate(input);
  if (!production.ok) return withAws(production, aws);

  const fallbackRoot = repoRootFrom(import.meta.url);
  const registry = ctx.registry || (ctx.skip_contracts === true
    ? null
    : loadRegistryFromRoots(loadContractRegistry, root, fallbackRoot));
  const compositionRegistry = ctx.compositionRegistry || (ctx.skip_preserve_builds === true
    ? null
    : loadRegistryFromRoots(loadCompositionRegistry, root, fallbackRoot));

  if (ctx.skip_preserve_builds !== true) {
    const preserve = evaluatePreserveBuilds(input, {
      root,
      registry,
      compositionRegistry,
      skip_contracts: true,
    });
    if (!preserve.ok) return withAws(preserve, aws);
  }

  if (root && ctx.skip_contracts !== true) {
    const contracts = evaluateRequiredRegressionChecks({
      registry: registry || loadContractRegistry(root),
      compositionRegistry: compositionRegistry || (root ? loadCompositionRegistry(root) : null),
      environment: input.target_environment,
      component: input.target_component,
      deployment_type: input.deployment_type,
      results: input.contract_results || {},
      previously_accepted: input.previously_accepted,
    });
    if (!contracts.ok) return withAws(contracts, aws);
  }

  let specific;
  if (input.deployment_type === 'lambda-overlay') {
    specific = evaluateLambdaOverlay(input);
    if (specific.ok) specific = planLambdaApply(specific, { apply: input.apply === true, env: ctx.env || process.env });
  } else if (input.deployment_type === 'spa-promote') {
    specific = evaluateSpaPromote(input);
  } else if (input.deployment_type === 'sql-apply') {
    specific = evaluateSqlApply(input);
  } else if (input.deployment_type === 'sql-executor-invoke') {
    specific = evaluateSqlExecutorAuthorization(input);
  } else if (input.deployment_type === 'verify-only') {
    specific = verifyLiveState(input);
  } else {
    specific = ok({ skipped_specific: true });
  }
  if (!specific.ok) return withAws(specific, aws);

  const manifest = buildManifest({
    ...identityInput,
    operator: input.operator,
    target_component: input.target_component,
    owned_files: input.owned_members || input.owned_components,
    accepted_contracts: input.previously_accepted || [],
    package: input.package || input.dist || null,
  }, { generated_at: input.generated_at });

  const result = ok({
    identity: identity.details,
    production: production.details,
    evaluation: specific.details,
    manifest: manifest.ok ? manifest.details : null,
    aws_calls: aws.calls || [],
  });
  return withAws(result, aws);
}

function withAws(result, aws) {
  try {
    assertNoLiveAwsCalls(aws);
  } catch (error) {
    return failMany([{
      code: error.code || CODES.GUARD_NO_AWS,
      message: error.message,
      details: error.details || {},
    }], CODES.GUARD_NO_AWS);
  }
  result.details = result.details || {};
  result.details.aws_adapter = aws.kind;
  result.details.aws_calls = aws.calls || [];
  return result;
}

export function writeReceipt(root, result, extras = {}) {
  const identity = result.details?.identity || {};
  const issued = issueReceipt(root, {
    workstream_id: extras.workstream_id || identity.workstream_id,
    branch: extras.branch || identity.branch,
    commit: extras.commit || identity.commit,
    operator: extras.operator || identity.operator,
    target_environment: extras.target_environment || identity.target_environment,
    target_component: extras.target_component || extras.component || identity.target_component,
    deployment_type: extras.deployment_type || identity.deployment_type,
    owned_components: extras.owned_components || identity.owned_components,
    preflight_live_fingerprint: extras.preflight_live_fingerprint || identity.preflight_live_fingerprint,
    lease: extras.lease || result.details?.lease || null,
  }, { now: extras.now, ttlMs: extras.ttl_ms });
  if (!issued.ok) return issued;
  const dir = receiptDir(root);
  fs.mkdirSync(dir, { recursive: true });
  return issued.details.file;
}

export {
  acquireLease,
  inspectLease,
  releaseLease,
  gitIdentity,
  verifyLiveState,
};
