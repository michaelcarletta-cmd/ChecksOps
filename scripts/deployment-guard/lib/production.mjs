import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { evaluateSourceComposition } from './spa-promote.mjs';

export function normalizeCompositionWorkstreams(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(Boolean))];
}

/**
 * Validate production SPA composition evidence.
 * Does not infer acceptance from accepted_composition alone.
 * Does not grant production approval.
 */
export function evaluateAcceptedSourceComposition(input = {}) {
  const evidence = input.accepted_source_composition;
  if (evidence == null || evidence === false) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'production SPA requires accepted source composition',
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }

  const booleanTrue = evidence === true;
  const objectEvidence = Boolean(evidence) && typeof evidence === 'object' && !Array.isArray(evidence);
  if (!booleanTrue && !objectEvidence) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'accepted_source_composition must be true or an evidence object',
      { received_type: typeof evidence },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }

  if (objectEvidence && evidence.accepted !== true) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'accepted_source_composition.accepted must be true',
      { accepted: Object.hasOwn(evidence, 'accepted') ? evidence.accepted : null },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }

  const evidenceAccepted = booleanTrue || evidence.accepted === true;
  if (input.accepted_composition !== undefined && (input.accepted_composition === true) !== evidenceAccepted) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'accepted_source_composition does not match accepted_composition',
      {
        accepted_source_composition: evidenceAccepted,
        accepted_composition: input.accepted_composition === true,
      },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }

  const inputWorkstreams = normalizeCompositionWorkstreams(input.frontend_workstreams);
  const evidenceWorkstreams = objectEvidence && Array.isArray(evidence.workstreams)
    ? normalizeCompositionWorkstreams(evidence.workstreams)
    : null;
  if (evidenceWorkstreams) {
    const same = evidenceWorkstreams.length === inputWorkstreams.length
      && evidenceWorkstreams.every((id) => inputWorkstreams.includes(id));
    if (!same) {
      return failMany([errorEntry(
        CODES.SOURCE_COMPOSITION_REQUIRED,
        'accepted_source_composition workstreams do not match frontend_workstreams',
        {
          evidence_workstreams: evidenceWorkstreams,
          frontend_workstreams: inputWorkstreams,
        },
      )], CODES.SOURCE_COMPOSITION_REQUIRED);
    }
  }

  const manifest = (objectEvidence && evidence.manifest) || input.source_composition_manifest || null;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'production SPA composition requires a source composition manifest',
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }

  // Never hard-code acceptance. Boolean evidence still needs accepted_composition
  // for the existing multi-workstream contract. Object evidence may carry accepted.
  const acceptedForContract = objectEvidence
    ? evidence.accepted === true && (input.accepted_composition === undefined || input.accepted_composition === true)
    : input.accepted_composition === true;

  return evaluateSourceComposition({
    frontend_workstreams: evidenceWorkstreams || inputWorkstreams,
    accepted_composition: acceptedForContract,
    composition_manifest: manifest,
  });
}

export function evaluateProductionGate(input = {}) {
  const errors = [];
  const environment = input.target_environment || input.environment;
  if (environment !== 'production') {
    return ok({ production_gate: 'not_applicable', environment });
  }

  if (!input.production_fingerprint) {
    errors.push(errorEntry(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production deployment requires the current production fingerprint'));
  }
  if (input.deployment_type === 'spa-promote') {
    const composition = evaluateAcceptedSourceComposition(input);
    if (!composition.ok) {
      errors.push(...(composition.errors || [errorEntry(CODES.SOURCE_COMPOSITION_REQUIRED, composition.message)]));
    }
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
      errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'production changed between checks; stop', {
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
    const code = errors.some((row) => row.code === CODES.DEPLOYMENT_COLLISION)
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
