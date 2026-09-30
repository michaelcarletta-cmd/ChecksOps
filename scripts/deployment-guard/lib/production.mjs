import { CODES, errorEntry, failMany, ok } from './errors.mjs';

export function evaluateProductionGate(input = {}) {
  const errors = [];
  const environment = input.target_environment || input.environment;
  if (environment !== 'production') {
    return ok({ production_gate: 'not_applicable', environment });
  }

  if (!input.production_fingerprint) {
    errors.push(errorEntry(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production deployment requires the current production fingerprint'));
  }
  if (!input.accepted_source_composition && input.deployment_type === 'spa-promote') {
    errors.push(errorEntry(CODES.SOURCE_COMPOSITION_REQUIRED, 'production SPA requires accepted source composition'));
  }
  if (!input.staging_acceptance || input.staging_acceptance.ok !== true || !input.staging_acceptance.reference) {
    errors.push(errorEntry(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production deployment requires a successful staging acceptance reference'));
  }
  if (!input.immediately_before_fingerprint) {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'production requires a second fingerprint immediately before write'));
  }
  if (input.production_fingerprint && input.immediately_before_fingerprint) {
    const a = JSON.stringify(input.production_fingerprint);
    const b = JSON.stringify(input.immediately_before_fingerprint);
    if (a !== b) {
      const driftCode = input.deployment_type === 'spa-promote'
        ? CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED
        : CODES.DEPLOYMENT_COLLISION;
      errors.push(errorEntry(driftCode, 'production changed between checks; stop and recompose onto the NEW live baseline', {
        preflight: input.production_fingerprint,
        immediately_before: input.immediately_before_fingerprint,
      }));
    }
  }

  const approval = input.approval || {};
  if (approval.approved !== true) {
    errors.push(errorEntry(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production requires an explicit approval marker/input'));
  }
  if (!approval.workstream_id || approval.workstream_id !== input.workstream_id) {
    errors.push(errorEntry(CODES.PRODUCTION_APPROVAL_REQUIRED, 'never infer production approval from a previous workstream; approval.workstream_id must match the current workstream', {
      approval_workstream: approval.workstream_id || null,
      current_workstream: input.workstream_id || null,
    }));
  }
  if (approval.inherited === true || approval.from_previous_workstream === true) {
    errors.push(errorEntry(CODES.PRODUCTION_APPROVAL_REQUIRED, 'inherited/previous-workstream production approval is forbidden'));
  }

  if (errors.length) {
    const code = errors.some((row) => row.code === CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED)
      ? CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED
      : errors.some((row) => row.code === CODES.DEPLOYMENT_COLLISION)
        ? CODES.DEPLOYMENT_COLLISION
        : errors[0].code;
    return failMany(errors, code);
  }
  return ok({
    production_gate: 'allowed',
    staging_acceptance: input.staging_acceptance.reference,
    approval_workstream: approval.workstream_id,
  });
}
