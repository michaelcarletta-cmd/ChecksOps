#!/usr/bin/env node
/**
 * Fail-closed entry for every repository-controlled shared-target writer.
 *
 * Direct invocation without a valid short-lived receipt must exit before
 * any AWS/SQL mutation. An environment variable alone cannot bypass this.
 */
import { evaluateDeployment } from './lib/guard.mjs';
import { inspectLease } from './lib/lease.mjs';
import { CODES, GuardError, fail, ok } from './lib/errors.mjs';
import { loadReceipt, validateReceipt } from './lib/receipt.mjs';
import { lookupSharedBucket, lookupSharedLambda } from './lib/shared-targets.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function resolveGuardRoot(ctx = {}, env = process.env) {
  return ctx.root || env.CHECKSOPS_DEPLOYMENT_GUARD_ROOT || repoRootFrom(import.meta.url);
}

function requestedIdentity(spec, env) {
  return {
    workstream_id: spec.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || null,
    commit: spec.commit || env.CHECKSOPS_COMMIT || null,
    target_environment: spec.target_environment || spec.environment,
    target_component: spec.target_component || spec.component,
    deployment_type: spec.deployment_type,
    preflight_live_fingerprint: spec.preflight_live_fingerprint || spec.live_fingerprint || null,
  };
}

export function refuseUnguardedDeploy(spec = {}, ctx = {}) {
  const env = ctx.env || process.env;
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_BYPASS || env.CHECKSOPS_SKIP_DEPLOYMENT_GUARD) {
    return fail(
      CODES.DEPLOYMENT_GUARD_REQUIRED,
      'environment-variable bypass of the deployment guard is forbidden',
      { refused_env: ['CHECKSOPS_DEPLOYMENT_GUARD_BYPASS', 'CHECKSOPS_SKIP_DEPLOYMENT_GUARD'] },
    );
  }
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY === '1' && !spec.receipt && !env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT) {
    return fail(
      CODES.DEPLOYMENT_GUARD_REQUIRED,
      'CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 is not a bypass; a valid receipt is required',
    );
  }

  const root = resolveGuardRoot(ctx, env);
  const expected = requestedIdentity(spec, env);
  if (!expected.target_environment || !expected.target_component || !expected.deployment_type) {
    return fail(
      CODES.DEPLOYMENT_GUARD_REQUIRED,
      'shared-target mutation must declare environment, component, and deployment_type',
      expected,
    );
  }

  const loaded = loadReceipt(root, {
    ...spec,
    target_environment: expected.target_environment,
    target_component: expected.target_component,
    receipt_path: spec.receipt_path,
    receipt: spec.receipt,
  }, env);

  if (!loaded.receipt) {
    return fail(
      CODES.DEPLOYMENT_GUARD_REQUIRED,
      'DEPLOYMENT_GUARD_REQUIRED: no valid guard receipt/manifest for this workstream, environment, component, commit, live fingerprint, lease, and owned files',
      {
        target_environment: expected.target_environment,
        target_component: expected.target_component,
        hint: 'node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input <manifest.json>',
      },
    );
  }

  const validated = validateReceipt(loaded.receipt, expected, { now: ctx.now || Date.now(), root });
  if (!validated.ok) {
    if (validated.code === CODES.RECEIPT_MISMATCH
      || validated.code === CODES.RECEIPT_EXPIRED
      || validated.code === CODES.LEASE_HELD
      || validated.code === CODES.LEASE_EXPIRED
      || validated.code === CODES.DEPLOYMENT_COLLISION) {
      return validated;
    }
    return fail(CODES.DEPLOYMENT_GUARD_REQUIRED, validated.message, validated.details);
  }
  return ok({
    receipt: validated.details.receipt,
    receipt_file: loaded.file,
    authorized: true,
  });
}

export function enforceScriptGuard(spec = {}, ctx = {}) {
  const result = refuseUnguardedDeploy(spec, ctx);
  if (!result.ok) {
    const payload = {
      ok: false,
      code: result.code || CODES.DEPLOYMENT_GUARD_REQUIRED,
      message: result.message,
      details: result.details || {},
      errors: result.errors || [],
    };
    try {
      process.stderr.write(`${JSON.stringify(payload)}\n`);
    } catch {
      /* ignore */
    }
    process.exit(2);
  }
  return result;
}

export function enforceSharedLambdaTarget(spec = {}, ctx = {}) {
  const shared = lookupSharedLambda(spec.functionName);
  if (!shared) {
    return ok({ classification: 'NON_SHARED/SAFE', functionName: spec.functionName });
  }
  return enforceScriptGuard({
    script: spec.script,
    ...shared,
    workstream_id: spec.workstream_id,
    commit: spec.commit,
    live_fingerprint: spec.live_fingerprint,
  }, ctx);
}

export function enforceS3Target(spec = {}, ctx = {}) {
  const shared = lookupSharedBucket(spec.bucket);
  if (!shared) {
    return fail(
      CODES.DEPLOYMENT_GUARD_REQUIRED,
      'S3 write to an unregistered shared/production bucket is refused; register the target or use the guard',
      { bucket: spec.bucket },
    );
  }
  return enforceScriptGuard({
    script: spec.script,
    ...shared,
    workstream_id: spec.workstream_id,
    commit: spec.commit,
    live_fingerprint: spec.live_fingerprint,
  }, ctx);
}

export function requireDeploymentGuard(input = {}, ctx = {}) {
  const root = resolveGuardRoot(ctx, ctx.env || process.env);
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
    required_wrapper: 'node scripts/deployment-guard/wrap-legacy.mjs --input manifest.json -- node <legacy-script>',
    fail_closed: inventoryRow.classification !== 'NON_SHARED/SAFE' && inventoryRow.classification !== 'SAFE',
    note: 'Direct invocation of a shared-target writer must fail with DEPLOYMENT_GUARD_REQUIRED unless a valid receipt exists.',
  };
}
