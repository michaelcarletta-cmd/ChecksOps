import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { DEFAULT_PATHS } from './paths.mjs';

const GIT_SHA_RE = /^[0-9a-f]{40}$/;

export function loadCompositionRegistry(root, rel = DEFAULT_PATHS.composition) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

export function passingCompositionResults(registry) {
  const out = {};
  for (const row of acceptedManifests(registry)) {
    out[`composition:${row.id}`] = { ok: true };
    if (row.test) out[row.test] = { ok: true };
    for (const testPath of row.tests || []) out[testPath] = { ok: true };
  }
  return out;
}

export function acceptedManifests(registry = {}) {
  return (registry.manifests || []).filter((row) => row.accepted === true && row.enabled !== false);
}

export function manifestApplies(row, { deployment_type } = {}) {
  const kind = String(row.kind || '');
  if (!deployment_type) return true;
  if (deployment_type === 'spa-promote') return kind.includes('spa');
  if (deployment_type === 'lambda-overlay') return kind.includes('lambda');
  if (deployment_type === 'sql-apply' || deployment_type === 'sql-executor-invoke') return kind.includes('sql');
  return true;
}

export function requiredPreservedPaths(registry, opts = {}) {
  const paths = new Set();
  for (const row of acceptedManifests(registry)) {
    if (!manifestApplies(row, opts)) continue;
    for (const file of row.preserved_paths || []) paths.add(file);
  }
  return [...paths].sort();
}

export function compositionFiles(manifest) {
  if (!manifest) return [];
  if (Array.isArray(manifest.files)) return manifest.files.filter(Boolean);
  if (Array.isArray(manifest.preserved_paths)) return manifest.preserved_paths.filter(Boolean);
  if (Array.isArray(manifest.paths)) return manifest.paths.filter(Boolean);
  return [];
}

export function evaluateSourceComposition({
  frontend_workstreams = [],
  accepted_composition = false,
  composition_manifest = null,
} = {}) {
  const distinct = [...new Set(frontend_workstreams.filter(Boolean))];
  if (distinct.length > 1 && accepted_composition !== true) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'multiple workstreams contain frontend changes; build one combined source candidate before SPA promote',
      {
        workstreams: distinct,
        composition_manifest: composition_manifest || null,
      },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  return ok({
    workstreams: distinct,
    accepted_composition: accepted_composition === true || distinct.length <= 1,
  });
}

export function evaluateAcceptedSourceComposition({
  registry,
  deployment_type,
  composition_manifest = null,
  accepted_composition = false,
  frontend_workstreams = [],
} = {}) {
  const simple = evaluateSourceComposition({
    frontend_workstreams,
    accepted_composition,
    composition_manifest,
  });
  if (!simple.ok) return simple;

  const errors = [];
  if (!registry || !Array.isArray(registry.manifests)) {
    errors.push(errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'accepted source-composition registry is required; a boolean flag is not enough',
    ));
    return failMany(errors, CODES.SOURCE_COMPOSITION_REQUIRED);
  }

  const files = new Set(compositionFiles(composition_manifest));
  if (!files.size && (deployment_type === 'spa-promote' || frontend_workstreams.length > 1)) {
    errors.push(errorEntry(
      CODES.INVALID_MANIFEST,
      'source composition manifest must list the composed files',
    ));
  }

  const missing = [];
  const required = requiredPreservedPaths(registry, { deployment_type });
  if (deployment_type === 'spa-promote' || frontend_workstreams.length > 1) {
    for (const file of required) {
      if (!files.has(file)) missing.push(file);
    }
    if (missing.length) {
      errors.push(errorEntry(
        CODES.SOURCE_COMPOSITION_REQUIRED,
        'composed SPA source is missing accepted preserved paths; do not promote a partial or stale frontend',
        { missing_preserved_paths: missing },
      ));
    }
  }

  if (accepted_composition === true && missing.length) {
    errors.push(errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'accepted_composition=true is ignored unless the manifest includes every accepted preserved path',
      { missing_preserved_paths: missing },
    ));
  }

  if (errors.length) return failMany(errors, errors[0].code);
  return ok({
    ...simple.details,
    preserved_paths: required,
    composition_files: [...files].sort(),
    registry_manifests: acceptedManifests(registry).map((row) => row.id),
  });
}

export function evaluateMainReconciliation(input = {}) {
  const errors = [];
  const currentMain = String(input.current_main_sha || input.origin_main_sha || '').trim();
  const mergeBase = String(input.merge_base_sha || '').trim();
  const claimed = String(input.claimed_main_sha || '').trim();

  if (!GIT_SHA_RE.test(currentMain)) {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'mutating deploy must reconcile against current origin/main (40-character SHA)',
    ));
  }
  if (!GIT_SHA_RE.test(mergeBase)) {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'mutating deploy must declare merge_base_sha against current main',
    ));
  }
  if (GIT_SHA_RE.test(currentMain) && GIT_SHA_RE.test(mergeBase) && currentMain !== mergeBase) {
    if (input.reconciled_with_main !== true) {
      errors.push(errorEntry(
        CODES.MAIN_RECONCILIATION_REQUIRED,
        'branch is not based on current main; rebase/compose onto current main before deploy',
        { current_main_sha: currentMain, merge_base_sha: mergeBase },
      ));
    }
  }
  if (claimed && GIT_SHA_RE.test(currentMain) && claimed !== currentMain && input.reconciled_with_main !== true) {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'claimed main SHA is stale versus current origin/main',
      { current_main_sha: currentMain, claimed_main_sha: claimed },
    ));
  }

  const pathRows = input.accepted_paths_vs_main || input.path_reconciliation || [];
  const owned = new Set(input.owned_members || input.owned_components || []);
  const diverged = [];
  for (const row of pathRows) {
    const file = row.path || row.file;
    if (!file) continue;
    if (row.main && row.candidate && row.main !== row.candidate && !owned.has(file)) {
      diverged.push(file);
    }
  }
  if (diverged.length) {
    errors.push(errorEntry(
      CODES.SOURCE_RECONCILIATION_REQUIRED,
      'accepted or unrelated paths diverged from current main and are not owned by this workstream',
      { diverged_paths: diverged },
    ));
  }

  if (errors.length) return failMany(errors, errors[0].code);
  return ok({
    current_main_sha: currentMain,
    merge_base_sha: mergeBase,
    reconciled_with_main: true,
  });
}

export function evaluatePreservedMemberIntegrity({
  liveMembers = {},
  candidateMembers = {},
  ownedMembers = [],
  preservedPaths = [],
} = {}) {
  const owned = new Set(ownedMembers || []);
  const errors = [];
  const unexpected = [];
  for (const file of preservedPaths || []) {
    const live = liveMembers[file];
    const candidate = candidateMembers[file];
    if (live == null && candidate == null) continue;
    if (owned.has(file)) continue;
    if (candidate != null && live != null && candidate !== live) {
      unexpected.push(file);
    }
    if (live != null && candidate == null) {
      unexpected.push(file);
    }
  }
  if (unexpected.length) {
    errors.push(errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      'accepted preserved members would be overwritten or dropped; overlay only owned files',
      { unexpected_preserved_changes: unexpected },
    ));
  }
  if (errors.length) return failMany(errors, CODES.DEPLOYMENT_COLLISION);
  return ok({ preserved: (preservedPaths || []).filter((file) => !owned.has(file)) });
}
