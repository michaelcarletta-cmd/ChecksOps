import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { evaluateAcceptedContracts, relevantContracts } from './contracts.mjs';
import {
  ISO_RE,
  evaluateAcceptedSourceComposition,
  evaluateMainReconciliation,
  evaluatePreservedMemberIntegrity,
  manifestApplies,
  requiredPreservedPaths,
} from './source-composition.mjs';
import { evaluateWorktreeIsolation } from './worktree.mjs';
import { evaluateDistFreshness, evaluatePackageProvenance } from './packages.mjs';
import { evaluateInterruptedApply } from './verify-live.mjs';
import { applyOfficialObservation } from './observe.mjs';

export const REQUIRED_FINGERPRINT_FIELDS = Object.freeze({
  'lambda-overlay': Object.freeze(['codeSha256', 'revisionId', 'captured_at']),
  'spa-promote': Object.freeze(['index_html_sha256', 'entry_bundle', 'captured_at']),
  'sql-apply': Object.freeze(['sql', 'captured_at']),
  'sql-executor-invoke': Object.freeze(['sql', 'captured_at']),
});

const FINGERPRINT_CAS_SKIP = new Set(['captured_at']);

export function requiredFingerprintFields(deploymentType) {
  return REQUIRED_FINGERPRINT_FIELDS[deploymentType] || ['captured_at'];
}

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

function fingerprintFieldErrors(snapshot, label, deploymentType) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return [errorEntry(CODES.DEPLOYMENT_COLLISION, `${label} fingerprint is required and must be an object`)];
  }
  const missing = [];
  const invalid = [];
  for (const field of requiredFingerprintFields(deploymentType)) {
    const value = snapshot[field];
    if (value == null || value === '') {
      missing.push(field);
    } else if (field === 'captured_at' && !ISO_RE.test(String(value))) {
      invalid.push(field);
    }
  }
  if (missing.length) {
    errors.push(errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      `${label} fingerprint is missing required fields; complete type-specific values and captured_at are required`,
      { missing_fingerprint_fields: missing, snapshot: label, deployment_type: deploymentType || null },
    ));
  }
  if (invalid.length) {
    errors.push(errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      `${label} fingerprint captured_at must be an ISO-8601 UTC timestamp`,
      { invalid_fingerprint_fields: invalid, snapshot: label },
    ));
  }
  return errors;
}

export function evaluateFreshLiveFingerprint(input = {}) {
  const errors = [];
  const deploymentType = input.deployment_type;
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
  if (preflight && typeof preflight === 'object') {
    errors.push(...fingerprintFieldErrors(preflight, 'preflight', deploymentType));
  }
  if (live && typeof live === 'object') {
    errors.push(...fingerprintFieldErrors(live, 'immediately_before', deploymentType));
  }
  if (preflight && live && typeof preflight === 'object' && typeof live === 'object') {
    const keys = new Set([...Object.keys(preflight), ...Object.keys(live)]);
    for (const key of keys) {
      if (FINGERPRINT_CAS_SKIP.has(key)) continue;
      if (preflight[key] != null && live[key] != null && String(preflight[key]) !== String(live[key])) {
        errors.push(errorEntry(
          CODES.DEPLOYMENT_COLLISION,
          `live ${key} changed after preflight; stop and never restore the previous build`,
          { field: key, preflight: preflight[key], live: live[key] },
        ));
      }
    }
    if (
      ISO_RE.test(String(preflight.captured_at || ''))
      && ISO_RE.test(String(live.captured_at || ''))
      && Date.parse(live.captured_at) < Date.parse(preflight.captured_at)
    ) {
      errors.push(errorEntry(
        CODES.DEPLOYMENT_COLLISION,
        'immediately_before captured_at is older than preflight; recapture CURRENT live state',
        {
          preflight_captured_at: preflight.captured_at,
          immediately_before_captured_at: live.captured_at,
        },
      ));
    }
  }
  const capturedAt = live?.captured_at;
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
  const errors = [];
  if (input.require_exclusive_lock !== true) {
    errors.push(errorEntry(
      CODES.LEASE_EXPIRED,
      'shared-target mutation requires require_exclusive_lock=true; omitting the requirement flag is not a pass',
      { require_exclusive_lock: Object.hasOwn(input, 'require_exclusive_lock') ? input.require_exclusive_lock : null },
    ));
  }
  const lease = input.lease;
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    errors.push(errorEntry(
      CODES.LEASE_EXPIRED,
      'shared-target deploy requires an exclusive lease for this environment/component',
    ));
  } else {
    if (!String(lease.workstream_id || '').trim()) {
      errors.push(errorEntry(
        CODES.LEASE_EXPIRED,
        'exclusive lease must identify the holding workstream',
      ));
    }
    if (!lease.acquired_at || !ISO_RE.test(String(lease.acquired_at))) {
      errors.push(errorEntry(
        CODES.LEASE_EXPIRED,
        'exclusive lease must include an ISO-8601 acquired_at timestamp',
      ));
    }
    if (lease.workstream_id && input.workstream_id && lease.workstream_id !== input.workstream_id) {
      errors.push(errorEntry(
        CODES.LEASE_HELD,
        'exclusive deployment lock is held by another workstream; do not reclaim it',
        { holder: lease.workstream_id },
      ));
    }
  }
  if (input.steal_lease === true || input.reclaim_lease === true) {
    errors.push(errorEntry(
      CODES.LEASE_HELD,
      'stealing or reclaiming another workstream lock is forbidden',
    ));
  }
  if (errors.length) return failMany(errors, errors[0].code);
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
  let payload = input;
  let officialObservation = null;
  if (ctx.official === true || ctx.require_trusted_observation === true) {
    const binding = applyOfficialObservation(input, ctx);
    if (!binding.ok) return binding;
    payload = binding.details.bound;
    officialObservation = binding.details.observation || null;
  }

  const deploymentType = payload.deployment_type;
  const mutating = isMutatingDeployment(deploymentType);
  if (!mutating && ctx.require_mutating_only !== false) {
    return ok({ skipped: true, reason: 'non-mutating' });
  }

  const isolation = evaluateWorktreeIsolation(payload);
  if (!isolation.ok) return isolation;

  const rollback = evaluateNoAutomaticRollback(payload);
  if (!rollback.ok) return rollback;

  const main = evaluateMainReconciliation(payload);
  if (!main.ok) return main;

  if (payload.package) {
    const pkg = evaluatePackageProvenance(payload.package);
    if (!pkg.ok) return pkg;
  }
  if (payload.dist || payload.clean_build != null || deploymentType === 'spa-promote') {
    const dist = evaluateDistFreshness(payload.dist || { clean_build: payload.clean_build });
    if (!dist.ok) return dist;
  }

  const fingerprint = evaluateFreshLiveFingerprint(payload);
  if (!fingerprint.ok) return fingerprint;

  const lock = evaluateExclusiveDeployLock(payload);
  if (!lock.ok) return lock;

  let composition = ok({ skipped: !ctx.compositionRegistry });
  if (ctx.compositionRegistry) {
    composition = evaluateAcceptedSourceComposition({
      registry: ctx.compositionRegistry,
      deployment_type: deploymentType,
      composition_manifest: payload.source_composition_manifest,
      accepted_composition: payload.accepted_composition === true,
      frontend_workstreams: payload.frontend_workstreams || [],
      candidate_members: payload.candidate_members,
      candidate_contents: payload.candidate_contents,
    });
    if (!composition.ok) return composition;

    const members = evaluatePreservedMemberIntegrity({
      liveMembers: payload.live_members,
      candidateMembers: payload.candidate_members || composition.details.composition_members,
      ownedMembers: payload.owned_members || payload.owned_components,
      preservedPaths: requiredPreservedPaths(ctx.compositionRegistry, { deployment_type: deploymentType }),
    });
    if (!members.ok) return members;
  }

  let regressions = ok({ skipped: !ctx.registry || ctx.skip_contracts === true });
  if (ctx.registry && ctx.skip_contracts !== true) {
    regressions = evaluateRequiredRegressionChecks({
      registry: ctx.registry,
      compositionRegistry: ctx.compositionRegistry,
      environment: payload.target_environment,
      component: payload.target_component,
      deployment_type: deploymentType,
      results: payload.contract_results || {},
      previously_accepted: payload.previously_accepted,
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
    observation: {
      candidate_source: 'deployment-artifact',
      live_source: 'fresh-live-baseline',
      ancestry_source: 'git-merge-base',
      build_evidence_source: officialObservation?.build_evidence_source || null,
      trusted: ctx.official === true || ctx.require_trusted_observation === true,
    },
  });
}
