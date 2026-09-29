#!/usr/bin/env node
/**
 * Legacy deployment scripts must call this before any shared-target write.
 *
 *   import { requireDeploymentGuard } from '../../scripts/deployment-guard/require-guard.mjs';
 *   requireDeploymentGuard({ script: import.meta.url, environment, component, ...evaluationInput });
 *
 * Direct invocation of a listed bypass script without a passing guard
 * evaluation must fail closed. This module never talks to AWS.
 */
import { evaluateDeployment } from './lib/guard.mjs';
import { inspectLease } from './lib/lease.mjs';
import { CODES, GuardError } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function requireDeploymentGuard(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const evaluation = evaluateDeployment({
    ...input,
    apply: false,
    contract_results: input.contract_results || ctx.contract_results || {},
  }, { root, env: ctx.env || process.env, aws: ctx.aws, registry: ctx.registry, skip_contracts: ctx.skip_contracts });
  if (!evaluation.ok) {
    throw new GuardError(evaluation.code, evaluation.message, evaluation.details);
  }
  if (input.require_lease !== false && input.target_environment && input.target_component) {
    const lease = inspectLease(root, input.target_environment, input.target_component, ctx.now);
    if (!lease.ok) throw new GuardError(lease.code, lease.message, lease.details);
    if (!lease.details.present || lease.details.expired) {
      throw new GuardError(CODES.LEASE_EXPIRED, 'shared-target deploy requires an active lease held by this workstream', lease.details);
    }
    if (lease.details.lease.workstream_id !== input.workstream_id) {
      throw new GuardError(CODES.LEASE_HELD, 'active lease belongs to another workstream', lease.details);
    }
  }
  return evaluation;
}

export function wrapLegacyScript(inventoryRow) {
  return {
    classification: inventoryRow.classification,
    required_wrapper: 'node scripts/deployment-guard/preflight.mjs --input <manifest.json> && node scripts/deployment-guard/lease.mjs acquire ...',
    fail_closed: inventoryRow.classification !== 'SAFE',
    note: inventoryRow.classification === 'LEGACY/BYPASS'
      ? 'Do not invoke this script directly against a shared staging/production target. Run official deployment-guard tooling first; this script must call requireDeploymentGuard or fail.'
      : inventoryRow.note,
  };
}
