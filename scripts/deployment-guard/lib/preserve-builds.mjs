import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { evaluateAcceptedContracts, relevantContracts } from './contracts.mjs';
import {
  evaluateAcceptedSourceComposition,
  evaluateMainReconciliation,
  evaluatePreservedMemberIntegrity,
  manifestApplies,
  requiredPreservedPaths,
} from './source-composition.mjs';
import { evaluateWorktreeIsolation } from './worktree.mjs';
import { evaluateDistFreshness, evaluatePackageProvenance } from './packages.mjs';
import { evaluateInterruptedApply } from './verify-live.mjs';

const MUTATING_TYPES = new Set([
  'lambda-overlay',
  'spa-promote',
  'sql-apply',
  'sql-executor-invoke',
  'cloudfront-invalidation',
  'cloudfront-update',
  'cloudformation',
  's3-object-write',
  'apigateway-update',
  'infra-mutate',
]);

export function isMutatingDeployment(type) {
  return MUTATING_TYPES.has(type);
}

export function evaluateNoAutomaticRollback(input = {}) {
  if (
    input.rollback_to_previous === true
    || input.auto_rollback === true
    || input.reclaim === true
    || input.reclaim_staging === true
    || input.restore_previous_index === true
    || input.restore_baseline === true
    || input.package?.reclaim === true
  ) {
    return evaluateInterruptedApply({
      rollback_to_previous: true,
      reclaim: input.reclaim === true || input.reclaim_staging === true,
      mutated: input.mutated === true,
      verified: input.verified === true,
    });
  }
  return evaluateInterruptedApply({
    lease_acquired: input.lease_acquired === true,
    mutated: input.mutated === true,
    verified: input.verified === true,
  });
}

export function evaluateFreshLiveFingerprint(input = {}) {
  const errors = [];
  const preflight = input.preflight || input.preflight_live_fingerprint;
  const live = input.immediately_before || input.immediately_before_fingerprint || input.live;
  if (!preflight || typeof preflight !== 'object') {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'fresh live fingerprint requires a preflight snapshot'));
  }
  if (!live || typeof live !== 'object') {
    errors.push(errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      'mutation-boundary fingerprint (immediately_before) is required; preflight alone is not sufficient',
    ));
  }
  if (preflight && live) {
    const keys = new Set([...Object.keys(preflight), ...Object.keys(live)]);
    for (const key of keys) {
      if (preflight[key] != null && live[key] != null && String(preflight[key]) !== String(live[key])) {
        errors.push(errorEntry(
          CODES.DEPLOYMENT_COLLISION,
          `live ${key} changed after preflight; stop and never restore the previous build`,
          { field: key, preflight: preflight[key], live: live[key] },
        ));
      }
    }
  }
  const capturedAt = live?.captured_at || input.fingerprint_captured_at;
  const leaseAcquiredAt = input.lease?.acquired_at || input.lease_acquired_at;
  if (capturedAt && leaseAcquiredAt && Date.parse(capturedAt) < Date.parse(leaseAcquiredAt)) {
    errors.push(errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      'live fingerprint was captured before the exclusive lease; recapture CURRENT live state',
      { fingerprint_captured_at: capturedAt, lease_acquired_at: leaseAcquiredAt },
    ));
  }
  const maxAge = Number(input.fingerprint_max_age_ms || 0);
  const now = input.now || input.fingerprint_now;
  if (maxAge > 0 && capturedAt && now) {
    const age = Date.parse(now) - Date.parse(capturedAt);
    if (Number.isFinite(age) && age > maxAge) {
      errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'live fingerprint is older than the allowed window', {
        age_ms: age,
        max_age_ms: maxAge,
      }));
    }
  }
  if (errors.length) return failMany(errors, CODES.DEPLOYMENT_COLLISION);
  return ok({
    fresh: true,
    preflight,
    immediately_before: live,
  });
}

export function evaluateExclusiveDeployLock(input = {}) {
  if (input.require_exclusive_lock === false) {
    return ok({ lock: 'not_required' });
  }
  const lease = input.lease;
  if (!lease || typeof lease !== 'object') {
    return failMany([errorEntry(
      CODES.LEASE_EXPIRED,
      'shared-target deploy requires an exclusive lease for this environment/component',
    )], CODES.LEASE_EXPIRED);
  }
  if (lease.workstream_id && input.workstream_id && lease.workstream_id !== input.workstream_id) {
    return failMany([errorEntry(
      CODES.LEASE_HELD,
      'exclusive deployment lock is held by another workstream; do not reclaim it',
      { holder: lease.workstream_id },
    )], CODES.LEASE_HELD);
  }
  if (input.steal_lease === true || input.reclaim_lease === true) {
    return failMany([errorEntry(
      CODES.LEASE_HELD,
      'stealing or reclaiming another workstream lock is forbidden',
    )], CODES.LEASE_HELD);
  }
  return ok({ exclusive: true, lease });
}

export function evaluateRequiredRegressionChecks({
  registry,
  compositionRegistry,
  environment,
  component,
  deployment_type,
  results = {},
  previously_accepted,
} = {}) {
  const contracts = evaluateAcceptedContracts({
    registry,
    environment,
    component,
    deployment_type,
    results,
    previously_accepted,
  });
  if (!contracts.ok) return contracts;

  const errors = [];
  const extraIds = [];
  for (const row of (compositionRegistry?.manifests || [])) {
    if (row.accepted !== true || row.enabled === false) continue;
    if (!manifestApplies(row, { deployment_type })) continue;
    const tests = [...new Set([row.test, ...(row.tests || [])].filter(Boolean))];
    const key = `composition:${row.id}`;
    extraIds.push(key);
    const result = results[key] ?? results[row.id];
    if (result == null && tests.length) {
      const anyTestPass = tests.some((testPath) => {
        const hit = results[testPath];
        return hit === true || hit === 'pass' || hit?.ok === true;
      });
      if (!anyTestPass) {
        errors.push(errorEntry(
          CODES.REGRESSION_DETECTED,
          `accepted composition ${row.id} was not executed before deployment`,
          { composition_id: row.id, tests },
        ));
      }
    } else if (result != null && result !== true && result !== 'pass' && result?.ok !== true) {
      errors.push(errorEntry(
        CODES.REGRESSION_DETECTED,
        `accepted composition ${row.id} failed`,
        { composition_id: row.id, result },
      ));
    }
  }

  if (errors.length) return failMany(errors, CODES.REGRESSION_DETECTED);
  return ok({
    ...contracts.details,
    composition_checked: extraIds,
    relevant_contracts: relevantContracts(registry || { contracts: [] }, {
      environment,
      component,
      deployment_type,
    }).map((row) => row.id),
  });
}

export function evaluatePreserveBuilds(input = {}, ctx = {}) {
  const deploymentType = input.deployment_type;
  const mutating = isMutatingDeployment(deploymentType);
  if (!mutating && ctx.require_mutating_only !== false) {
    return ok({ skipped: true, reason: 'non-mutating' });
  }

  const isolation = evaluateWorktreeIsolation(input);
  if (!isolation.ok) return isolation;

  const rollback = evaluateNoAutomaticRollback(input);
  if (!rollback.ok) return rollback;

  const main = evaluateMainReconciliation(input);
  if (!main.ok) return main;

  if (input.package) {
    const pkg = evaluatePackageProvenance(input.package);
    if (!pkg.ok) return pkg;
  }
  if (input.dist || input.clean_build != null || deploymentType === 'spa-promote') {
    const dist = evaluateDistFreshness(input.dist || { clean_build: input.clean_build });
    if (!dist.ok) return dist;
  }

  const fingerprint = evaluateFreshLiveFingerprint(input);
  if (!fingerprint.ok) return fingerprint;

  if (input.require_exclusive_lock === true || input.lease) {
    const lock = evaluateExclusiveDeployLock(input);
    if (!lock.ok) return lock;
  }

  let composition = ok({ skipped: !ctx.compositionRegistry });
  if (ctx.compositionRegistry) {
    composition = evaluateAcceptedSourceComposition({
      registry: ctx.compositionRegistry,
      deployment_type: deploymentType,
      composition_manifest: input.source_composition_manifest,
      accepted_composition: input.accepted_composition === true,
      frontend_workstreams: input.frontend_workstreams || [],
    });
    if (!composition.ok) return composition;

    if (input.live_members || input.candidate_members) {
      const members = evaluatePreservedMemberIntegrity({
        liveMembers: input.live_members,
        candidateMembers: input.candidate_members,
        ownedMembers: input.owned_members || input.owned_components,
        preservedPaths: requiredPreservedPaths(ctx.compositionRegistry, { deployment_type: deploymentType }),
      });
      if (!members.ok) return members;
    }
  }

  let regressions = ok({ skipped: !ctx.registry || ctx.skip_contracts === true });
  if (ctx.registry && ctx.skip_contracts !== true) {
    regressions = evaluateRequiredRegressionChecks({
      registry: ctx.registry,
      compositionRegistry: ctx.compositionRegistry,
      environment: input.target_environment,
      component: input.target_component,
      deployment_type: deploymentType,
      results: input.contract_results || {},
      previously_accepted: input.previously_accepted,
    });
    if (!regressions.ok) return regressions;
  }

  return ok({
    preserve_builds: true,
    isolation: isolation.details,
    main: main.details,
    fingerprint: fingerprint.details,
    composition: composition.details,
    regressions: regressions.details,
    rollback: rollback.details,
    reclaim_forbidden: true,
  });
}
