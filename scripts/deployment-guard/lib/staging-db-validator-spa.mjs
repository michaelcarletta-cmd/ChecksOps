/**
 * Evaluate-only plan for promoting the PR 808 /admin/db-validator SPA to staging.
 * Never uploads, invalidates, overlays Lambda, applies SQL, or mutates AWS.
 */
import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { evaluateSpaPromote } from './spa-promote.mjs';

export const WORKSTREAM_ID = 'pr-809-staging-db-validator-spa';
export const STAGING_COMPONENT = 'staging-frontend';
export const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
export const STAGING_DISTRIBUTION = 'E1CG52WRQZI7X1';
export const PRODUCTION_BUCKET = 'checksops-production-frontend-806168576068';

const FORBIDDEN_OWNED = new Set([
  'checksops-staging-api',
  'checksops-production-prep-api',
  'production-frontend',
  STAGING_DISTRIBUTION,
]);

function forbiddenOwned(item) {
  const value = String(item || '');
  if (FORBIDDEN_OWNED.has(value)) return true;
  if (value.includes('lambda') || value.includes('Lambda')) return true;
  if (value.endsWith('.sql')) return true;
  if (value === PRODUCTION_BUCKET) return true;
  return false;
}

export function evaluateDbValidatorStagingSpaPlan(input = {}) {
  const errors = [];

  if (input.apply === true || input.deploy === true || input.upload === true) {
    errors.push(errorEntry(
      CODES.DEPLOYMENT_GUARD_REQUIRED,
      'source-only db-validator follow-up must not apply, upload, or deploy',
    ));
  }
  if (input.target_environment === 'production' || input.bucket === PRODUCTION_BUCKET) {
    errors.push(errorEntry(
      CODES.PRODUCTION_APPROVAL_REQUIRED,
      'db-validator SPA plan must never target production',
    ));
  }
  if (input.reclaim_staging === true || input.restore_previous_index === true) {
    errors.push(errorEntry(
      CODES.STALE_PACKAGE,
      'never reclaim staging or restore a previous index.html/dist',
    ));
  }
  if (input.release_lock_mutation === true) {
    errors.push(errorEntry(
      CODES.UNRELATED_MUTATION,
      'this workstream must not modify release locks',
    ));
  }

  const owned = Array.isArray(input.owned_components) ? input.owned_components : [];
  for (const item of owned) {
    if (forbiddenOwned(item)) {
      errors.push(errorEntry(
        CODES.UNRELATED_MUTATION,
        `plan must not own unrelated live component ${item}`,
        { component: item },
      ));
    }
  }

  if (errors.length) return failMany(errors, errors[0].code);

  const base = {
    apply_forbidden: true,
    production_untouched: true,
    release_locks_untouched: true,
    concurrent_workstreams_preserved: true,
    lambda_untouched: true,
    sql_untouched: true,
    component: STAGING_COMPONENT,
    workstream_id: input.workstream_id || WORKSTREAM_ID,
  };

  if (input.evaluate_promote === false) {
    return ok(base);
  }

  const promote = evaluateSpaPromote({
    ...input,
    deployment_type: 'spa-promote',
    target_environment: input.target_environment || 'staging',
    owned_components: owned.length ? owned : ['index.html'],
  });
  if (!promote.ok) return promote;

  return ok({
    ...base,
    ...promote.details,
    spa_promote_allowed: true,
  });
}
