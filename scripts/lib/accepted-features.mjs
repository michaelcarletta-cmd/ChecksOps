/**
 * Evaluate-only accepted-feature registry helpers.
 *
 * Does not deploy, acquire leases, issue receipts, call AWS, apply SQL,
 * or change Release Locks / Deployment Guard behavior.
 *
 * Enforcement is disabled. Findings are reported; callers must not treat
 * a finding as a merge/deploy block while evaluate_only is true.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FEATURE_STATUSES = Object.freeze([
  'accepted',
  'inventory_only',
  'missing_from_main',
  'superseded',
  'withdrawn',
]);

export const ENFORCEABLE_STATUS = 'accepted';

export const DEFAULT_PATHS = Object.freeze({
  registry: 'ops/accepted-features/registry.json',
  schema: 'ops/accepted-features/schema/registry.schema.json',
  readme: 'ops/accepted-features/README.md',
});

export const CODES = Object.freeze({
  INVALID_REGISTRY: 'INVALID_REGISTRY',
  INVARIANT_FAILED: 'INVARIANT_FAILED',
  FEATURE_MISSING: 'FEATURE_MISSING',
  ATTESTATION_REJECTED: 'ATTESTATION_REJECTED',
  UNAUTHORIZED_SUPERSESSION: 'UNAUTHORIZED_SUPERSESSION',
  COMPOSITION_GAP: 'COMPOSITION_GAP',
  STALE_SOURCE: 'STALE_SOURCE',
  SELF_ATTESTATION_INSUFFICIENT: 'SELF_ATTESTATION_INSUFFICIENT',
});

const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const FEATURE_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

export function repoRootFrom(metaUrl = import.meta.url) {
  const here = path.dirname(fileURLToPath(metaUrl));
  if (path.basename(here) === 'lib') return path.resolve(here, '..', '..');
  return path.resolve(here, '..');
}

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function inventoryAuthority(notes = 'Inventory only. A recorded SHA is not restore authority.') {
  return {
    kind: 'inventory_note',
    git_sha: null,
    merged_pr: null,
    evidence_path: null,
    restore_authority: false,
    notes,
  };
}

export function readRepoFile(root, rel, overlay = null) {
  if (overlay && Object.prototype.hasOwnProperty.call(overlay, rel)) {
    const value = overlay[rel];
    return value == null ? null : String(value);
  }
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return fs.readFileSync(abs, 'utf8');
}

export function sha256Text(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function regionText(src, invariant) {
  if (!src) return null;
  if (!invariant.region_start && !invariant.region_end) return src;
  let start = 0;
  if (invariant.region_start) {
    start = src.indexOf(invariant.region_start);
    if (start < 0) return null;
  }
  let end = src.length;
  if (invariant.region_end) {
    const found = src.indexOf(invariant.region_end, start + (invariant.region_start || '').length);
    if (found < 0) return null;
    end = found;
  }
  return src.slice(start, end);
}

function finding(code, featureId, invariantId, message, details = {}) {
  return {
    code,
    feature_id: featureId || null,
    invariant_id: invariantId || null,
    message,
    details,
  };
}

export function validateAuthority(authority, { status, label }) {
  const errors = [];
  if (!authority || typeof authority !== 'object') {
    errors.push(`${label}: accepted_source_authority is required`);
    return errors;
  }
  if (authority.restore_authority === true) {
    if (status !== ENFORCEABLE_STATUS) {
      errors.push(`${label}: restore_authority may be true only when status is accepted`);
    }
    if (!GIT_SHA_RE.test(String(authority.git_sha || ''))) {
      errors.push(`${label}: restore_authority requires a 40-character git SHA`);
    }
  }
  if (authority.git_sha != null && !GIT_SHA_RE.test(String(authority.git_sha))) {
    errors.push(`${label}: git_sha must be a 40-character git SHA or null`);
  }
  if (status !== ENFORCEABLE_STATUS && authority.kind === 'accepted_source') {
    errors.push(`${label}: accepted_source authority is reserved for status=accepted`);
  }
  return errors;
}

export function validateSupersessionRecord(row, featureId) {
  const errors = [];
  if (!row || typeof row !== 'object') {
    errors.push(`${featureId}: supersession record is required`);
    return errors;
  }
  if (row.from_feature_id !== featureId) {
    errors.push(`${featureId}: supersession.from_feature_id must match the feature`);
  }
  if (!row.reason || String(row.reason).trim().length < 20) {
    errors.push(`${featureId}: supersession.reason must be at least 20 characters`);
  }
  if (!row.approving_workstream_id) {
    errors.push(`${featureId}: supersession.approving_workstream_id is required`);
  }
  if (!Number.isInteger(row.review_pr) || row.review_pr < 1) {
    errors.push(`${featureId}: supersession.review_pr is required`);
  }
  if (!ISO_RE.test(String(row.committed_at || ''))) {
    errors.push(`${featureId}: supersession.committed_at must be ISO-8601 UTC`);
  }
  if (!GIT_SHA_RE.test(String(row.commit || ''))) {
    errors.push(`${featureId}: supersession.commit must be a 40-character git SHA`);
  }
  if (!row.to_authority || row.to_authority.restore_authority !== true) {
    errors.push(`${featureId}: supersession.to_authority.restore_authority must be true`);
  }
  if (!Array.isArray(row.updated_invariant_ids) || !Array.isArray(row.updated_tests)) {
    errors.push(`${featureId}: supersession must list updated invariants and tests`);
  }
  return errors;
}

export function validateRegistry(registry) {
  const errors = [];
  if (!registry || typeof registry !== 'object') {
    return { ok: false, errors: ['registry is missing'] };
  }
  if (registry.version !== 1) errors.push('version must be 1');
  if (registry.evaluate_only !== true) errors.push('evaluate_only must be true in this foundation');
  const enforcement = registry.enforcement || {};
  if (enforcement.enabled !== false) errors.push('enforcement.enabled must be false');
  if (enforcement.block_merge !== false) errors.push('enforcement.block_merge must be false');
  if (enforcement.block_deploy !== false) errors.push('enforcement.block_deploy must be false');
  if (enforcement.accept_self_attestation !== false) {
    errors.push('enforcement.accept_self_attestation must be false');
  }
  if (!Array.isArray(registry.features) || registry.features.length === 0) {
    errors.push('features must be a non-empty array');
    return { ok: false, errors };
  }
  const seen = new Set();
  for (const feature of registry.features) {
    const id = feature?.feature_id;
    if (!FEATURE_ID_RE.test(String(id || ''))) {
      errors.push(`invalid feature_id: ${id}`);
      continue;
    }
    if (seen.has(id)) errors.push(`duplicate feature_id: ${id}`);
    seen.add(id);
    if (!FEATURE_STATUSES.includes(feature.status)) {
      errors.push(`${id}: status must be one of ${FEATURE_STATUSES.join(', ')}`);
    }
    errors.push(...validateAuthority(feature.accepted_source_authority, {
      status: feature.status,
      label: id,
    }));
    if (!Array.isArray(feature.source_paths)) errors.push(`${id}: source_paths must be an array`);
    if (!Array.isArray(feature.semantic_invariants)) errors.push(`${id}: semantic_invariants must be an array`);
    if (!Array.isArray(feature.required_tests)) errors.push(`${id}: required_tests must be an array`);
    if (!Array.isArray(feature.applicable_artifact_types) || feature.applicable_artifact_types.length === 0) {
      errors.push(`${id}: applicable_artifact_types is required`);
    }
    if (!Array.isArray(feature.supersession_history)) {
      errors.push(`${id}: supersession_history must be an array`);
    } else {
      for (const row of feature.supersession_history) {
        errors.push(...validateSupersessionRecord(row, id));
      }
    }
    if (feature.status === 'superseded' && !(feature.supersession_history || []).length) {
      errors.push(`${id}: superseded features require an explicit supersession_history record`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function evaluateInvariant(root, feature, invariant, overlay = null) {
  const id = invariant.id;
  const featureId = feature.feature_id;
  if (invariant.all_of && invariant.all_of.length) {
    const children = invariant.all_of.map((childId) => {
      const child = (feature.semantic_invariants || []).find((row) => row.id === childId);
      if (!child) {
        return {
          ok: false,
          finding: finding(CODES.INVARIANT_FAILED, featureId, id, `compound invariant missing child ${childId}`),
        };
      }
      return evaluateInvariant(root, feature, child, overlay);
    });
    const failed = children.filter((row) => row.ok !== true);
    if (failed.length) {
      return {
        ok: false,
        finding: finding(CODES.INVARIANT_FAILED, featureId, id, invariant.title || 'compound invariant failed', {
          failed_children: failed.map((row) => row.finding?.invariant_id || null),
        }),
      };
    }
    return { ok: true, finding: null };
  }

  if (invariant.kind === 'source_file' || invariant.kind === 'lambda_member' || invariant.kind === 'sql_contract') {
    const src = readRepoFile(root, invariant.file, overlay);
    if (src == null) {
      return {
        ok: false,
        finding: finding(CODES.FEATURE_MISSING, featureId, id, `${invariant.kind} file is missing: ${invariant.file}`),
      };
    }
    if (invariant.must_export && !new RegExp(`export (function|const|async function) ${invariant.must_export}\\b`).test(src)) {
      return {
        ok: false,
        finding: finding(CODES.INVARIANT_FAILED, featureId, id, `missing export ${invariant.must_export} in ${invariant.file}`),
      };
    }
    if (invariant.must_match && !new RegExp(invariant.must_match).test(src)) {
      return {
        ok: false,
        finding: finding(CODES.INVARIANT_FAILED, featureId, id, `missing required marker in ${invariant.file}`),
      };
    }
    return { ok: true, finding: null };
  }

  const src = invariant.file ? readRepoFile(root, invariant.file, overlay) : '';
  if (invariant.file && src == null) {
    return {
      ok: false,
      finding: finding(CODES.FEATURE_MISSING, featureId, id, `source file is missing: ${invariant.file}`),
    };
  }
  const haystack = regionText(src || '', invariant);
  if (haystack == null) {
    return {
      ok: false,
      finding: finding(CODES.INVARIANT_FAILED, featureId, id, `required region not found in ${invariant.file}`),
    };
  }
  if (invariant.must_match && !new RegExp(invariant.must_match).test(haystack)) {
    return {
      ok: false,
      finding: finding(CODES.INVARIANT_FAILED, featureId, id, invariant.title || `required marker missing: ${invariant.must_match}`),
    };
  }
  if (invariant.must_not_match && new RegExp(invariant.must_not_match).test(haystack)) {
    return {
      ok: false,
      finding: finding(CODES.INVARIANT_FAILED, featureId, id, invariant.title || `forbidden marker present: ${invariant.must_not_match}`),
    };
  }
  return { ok: true, finding: null };
}

function requiredPathFindings(root, feature, overlay) {
  return (feature.source_paths || [])
    .filter((rel) => readRepoFile(root, rel, overlay) == null)
    .map((rel) => finding(
      CODES.FEATURE_MISSING,
      feature.feature_id,
      null,
      `required source path is missing: ${rel}`,
      { file: rel },
    ));
}

function stableFeatureContract(feature) {
  return JSON.stringify({
    source_paths: [...(feature.source_paths || [])].sort(),
    semantic_invariants: feature.semantic_invariants || [],
    required_tests: [...(feature.required_tests || [])].sort(),
    applicable_artifact_types: [...(feature.applicable_artifact_types || [])].sort(),
  });
}

function validateBoundTestEvidence(attestation, acceptedFeatures, candidateCommit) {
  if (attestation == null || !acceptedFeatures.length) return [];
  const executions = Array.isArray(attestation.test_executions)
    ? attestation.test_executions
    : (attestation.test_execution ? [attestation.test_execution] : []);
  const findings = [];
  for (const feature of acceptedFeatures) {
    for (const requiredTest of feature.required_tests || []) {
      const match = executions.find((row) => row?.test === requiredTest);
      if (!match) {
        findings.push(finding(
          CODES.ATTESTATION_REJECTED,
          feature.feature_id,
          null,
          `missing bound execution for required test ${requiredTest}`,
        ));
        continue;
      }
      if (match.exit_code !== 0
        || !/^[0-9a-f]{64}$/.test(String(match.output_sha256 || ''))
        || !GIT_SHA_RE.test(String(match.candidate_commit || ''))
        || (candidateCommit && match.candidate_commit !== candidateCommit)) {
        findings.push(finding(
          CODES.ATTESTATION_REJECTED,
          feature.feature_id,
          null,
          `required test evidence is not bound to the candidate: ${requiredTest}`,
          { candidate_commit: candidateCommit || null },
        ));
      }
    }
  }
  return findings;
}

export function evaluateFeature(root, feature, overlay = null) {
  const presentPaths = (feature.source_paths || []).filter((rel) => readRepoFile(root, rel, overlay) != null);
  const missingPaths = (feature.source_paths || []).filter((rel) => readRepoFile(root, rel, overlay) == null);
  const invariantResults = (feature.semantic_invariants || []).map((invariant) => ({
    invariant,
    ...evaluateInvariant(root, feature, invariant, overlay),
  }));
  const failing = [
    ...requiredPathFindings(root, feature, overlay),
    ...invariantResults.filter((row) => row.ok !== true).map((row) => row.finding),
  ];
  const present = presentPaths.length > 0 || invariantResults.some((row) => row.ok === true);
  return {
    feature_id: feature.feature_id,
    status: feature.status,
    present,
    present_paths: presentPaths,
    missing_paths: missingPaths,
    failing_invariants: failing,
    passed_invariants: invariantResults.filter((row) => row.ok === true).map((row) => row.invariant.id),
  };
}

export function rejectSelfAttestation(attestation) {
  if (attestation == null) return { ok: true, finding: null };
  const executions = Array.isArray(attestation.test_executions)
    ? attestation.test_executions
    : (attestation.test_execution ? [attestation.test_execution] : []);
  const hasEvidence = executions.length > 0 && executions.every((row) => Boolean(
    GIT_SHA_RE.test(String(row?.candidate_commit || ''))
    && Number.isInteger(row?.exit_code)
    && /^[0-9a-f]{64}$/.test(String(row?.output_sha256 || ''))
    && row?.test,
  ));
  if (attestation.ok === true && !hasEvidence) {
    return {
      ok: false,
      finding: finding(
        CODES.ATTESTATION_REJECTED,
        null,
        null,
        'self-attestation {ok:true} is not evidence; bind a real test execution and candidate commit',
        { attestation },
      ),
    };
  }
  if (attestation.ok === true && hasEvidence && executions.some((row) => row.exit_code !== 0)) {
    return {
      ok: false,
      finding: finding(CODES.ATTESTATION_REJECTED, null, null, 'attested test execution did not pass'),
    };
  }
  return { ok: true, finding: null };
}

export function detectUnauthorizedSupersession(previousFeature, nextFeature) {
  if (!previousFeature || previousFeature.status !== ENFORCEABLE_STATUS) {
    return { ok: true, finding: null };
  }
  const changed = stableFeatureContract(previousFeature) !== stableFeatureContract(nextFeature)
    || previousFeature.status !== nextFeature.status;
  if (!changed) return { ok: true, finding: null };
  const history = nextFeature.supersession_history || [];
  const authorized = history.some((row) => (
    row.from_feature_id === previousFeature.feature_id
    && row.to_authority?.restore_authority === true
    && GIT_SHA_RE.test(String(row.commit || ''))
    && Number.isInteger(row.review_pr)
    && String(row.reason || '').trim().length >= 20
  ));
  if (!authorized) {
    return {
      ok: false,
      finding: finding(
        CODES.UNAUTHORIZED_SUPERSESSION,
        nextFeature.feature_id,
        null,
        'accepted feature changed without an explicit supersession record',
      ),
    };
  }
  return { ok: true, finding: null };
}

export function evaluateAcceptedFeatures({
  root,
  registry,
  mode = 'evaluate-only',
  attestation = null,
  composition = null,
  previous_registry = null,
  overlay = null,
} = {}) {
  const schemaCheck = validateRegistry(registry);
  const findings = [];
  if (!schemaCheck.ok) {
    for (const message of schemaCheck.errors) {
      findings.push(finding(CODES.INVALID_REGISTRY, null, null, message));
    }
  }

  const attestationCheck = rejectSelfAttestation(attestation);
  if (!attestationCheck.ok) findings.push(attestationCheck.finding);

  if (composition?.accepted_source_composition === true) {
    findings.push(finding(
      CODES.SELF_ATTESTATION_INSUFFICIENT,
      null,
      null,
      'accepted_source_composition=true is not feature membership; evaluate explicit feature_ids',
    ));
  }

  const evaluated = [];
  for (const feature of registry.features || []) {
    evaluated.push(evaluateFeature(root, feature, overlay));
  }

  if (previous_registry?.features) {
    for (const prev of previous_registry.features) {
      const next = (registry.features || []).find((row) => row.feature_id === prev.feature_id);
      if (!next) continue;
      const supersession = detectUnauthorizedSupersession(prev, next);
      if (!supersession.ok) findings.push(supersession.finding);
    }
  }

  const accepted = (registry.features || []).filter((row) => row.status === ENFORCEABLE_STATUS);
  const expectedAccepted = accepted.map((row) => row.feature_id);
  findings.push(...validateBoundTestEvidence(
    attestation,
    accepted,
    composition?.candidate_commit || null,
  ));
  const byId = Object.fromEntries(evaluated.map((row) => [row.feature_id, row]));
  const presentAccepted = expectedAccepted.filter((id) => byId[id]?.present && byId[id].failing_invariants.length === 0);
  const missingAccepted = expectedAccepted.filter((id) => !presentAccepted.includes(id));
  const failingInvariants = evaluated.flatMap((row) => row.failing_invariants);
  findings.push(...failingInvariants);

  const declared = [...new Set(composition?.declared_feature_ids || [])];
  if (composition && expectedAccepted.length && expectedAccepted.some((id) => !declared.includes(id))) {
    findings.push(finding(
      CODES.COMPOSITION_GAP,
      null,
      null,
      'composition omitted one or more accepted feature_ids',
      {
        omitted: expectedAccepted.filter((id) => !declared.includes(id)),
      },
    ));
  }

  const foundationLocked = registry.evaluate_only === true
    || registry.enforcement?.enabled !== true
    || registry.enforcement?.block_merge !== true
    || registry.enforcement?.block_deploy !== true;
  const evaluateOnly = foundationLocked || mode !== 'enforce';
  const blocking = evaluateOnly ? false : (findings.length > 0);
  return {
    evaluate_only: evaluateOnly,
    blocking,
    exit_code: evaluateOnly ? 0 : (blocking ? 2 : 0),
    registry_ok: schemaCheck.ok,
    expected_accepted: expectedAccepted,
    present_accepted: presentAccepted,
    missing_accepted: missingAccepted,
    inventory_only: evaluated.filter((row) => row.status === 'inventory_only').map((row) => row.feature_id),
    missing_from_main: evaluated.filter((row) => row.status === 'missing_from_main').map((row) => row.feature_id),
    superseded: evaluated.filter((row) => row.status === 'superseded').map((row) => row.feature_id),
    withdrawn: evaluated.filter((row) => row.status === 'withdrawn').map((row) => row.feature_id),
    features: evaluated,
    failing_invariants: failingInvariants,
    findings,
    composition: {
      declared_feature_ids: declared,
      candidate_commit: composition?.candidate_commit || null,
      boolean_flag_ignored: composition?.accepted_source_composition === true,
    },
    attestation: attestationCheck.ok ? 'not_used_or_bound' : 'rejected',
  };
}

export function loadRegistry(root, rel = DEFAULT_PATHS.registry) {
  return loadJson(path.join(root, rel));
}

export function evaluateRepo(root = repoRootFrom(import.meta.url), extras = {}) {
  const registry = extras.registry || loadRegistry(root);
  return evaluateAcceptedFeatures({
    root,
    registry,
    mode: extras.mode || 'evaluate-only',
    attestation: extras.attestation || null,
    composition: extras.composition || null,
    previous_registry: extras.previous_registry || null,
    overlay: extras.overlay || null,
  });
}

export function evaluateForDeployGuard(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const result = evaluateRepo(root, {
    attestation: input.attestation || input.contract_results || null,
    composition: {
      accepted_source_composition: input.accepted_source_composition,
      declared_feature_ids: input.declared_feature_ids || [],
      candidate_commit: input.candidate_commit || null,
    },
  });
  return {
    ok: true,
    evaluate_only: true,
    blocking: false,
    code: null,
    message: 'accepted-feature registry is evaluate-only and does not authorize or block deployment',
    details: result,
  };
}
