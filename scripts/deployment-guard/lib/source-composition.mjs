import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { DEFAULT_PATHS } from './paths.mjs';

const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ANCESTRY_METHODS = new Set(['git-merge-base', 'merge-base']);
export const LAMBDA_SOURCE_PREFIX = 'aws/functions/api/';

function normalizeRel(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isSqlSourcePath(rel) {
  return normalizeRel(rel).endsWith('.sql');
}

export function isLambdaSourcePath(rel) {
  return normalizeRel(rel).startsWith(LAMBDA_SOURCE_PREFIX);
}

export function isSpaSourcePath(rel) {
  const n = normalizeRel(rel);
  return n.startsWith('src/') || n === 'index.html' || n.startsWith('public/');
}

export function repoPathToLambdaMember(repoPath) {
  const n = normalizeRel(repoPath);
  if (!n.startsWith(LAMBDA_SOURCE_PREFIX)) return null;
  return n.slice(LAMBDA_SOURCE_PREFIX.length);
}

export function compiledSpaDeployedMembers(entryBundle) {
  const bundle = String(entryBundle || '').trim().replace(/^\//, '');
  const members = ['index.html'];
  if (bundle) members.push(bundle);
  return members;
}

export function sourceToDeployedMap(sourcePaths = [], {
  deployment_type,
  entry_bundle,
} = {}) {
  const map = {};
  if (deployment_type === 'spa-promote') {
    const compiled = compiledSpaDeployedMembers(entry_bundle);
    const bundle = compiled[1] || compiled[0];
    for (const src of sourcePaths) {
      map[normalizeRel(src)] = bundle;
    }
    return map;
  }
  if (deployment_type === 'sql-apply' || deployment_type === 'sql-executor-invoke') {
    for (const src of sourcePaths) {
      if (isSqlSourcePath(src)) map[normalizeRel(src)] = normalizeRel(src);
    }
    return map;
  }
  if (deployment_type === 'lambda-overlay') {
    for (const src of sourcePaths) {
      const member = repoPathToLambdaMember(src);
      if (member) map[normalizeRel(src)] = member;
    }
    return map;
  }
  return map;
}

export function deployedMembersFromSourcePaths(sourcePaths = [], opts = {}) {
  if (opts.deployment_type === 'spa-promote') {
    return compiledSpaDeployedMembers(opts.entry_bundle);
  }
  return [...new Set(Object.values(sourceToDeployedMap(sourcePaths, opts)))];
}

export function hashContent(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function evidenceForPreservedPaths(registry, deploymentType, { seed = 'main' } = {}) {
  const files = requiredPreservedPaths(registry, { deployment_type: deploymentType });
  const members = {};
  const accepted_paths_vs_main = [];
  for (const file of files) {
    const digest = hashContent(`${seed}:${file}`);
    members[file] = digest;
    accepted_paths_vs_main.push({ path: file, main: digest, candidate: digest });
  }
  return {
    files,
    members,
    live_members: { ...members },
    candidate_members: { ...members },
    accepted_paths_vs_main,
  };
}

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

export function compositionMemberHashes(manifest = null, candidateMembers = {}, candidateContents = null) {
  const members = {
    ...(candidateMembers || {}),
    ...(manifest?.members || {}),
    ...(manifest?.hashes || {}),
  };
  if (candidateContents && typeof candidateContents === 'object') {
    for (const [file, text] of Object.entries(candidateContents)) {
      members[file] = hashContent(text);
    }
  }
  return members;
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
  candidate_members = null,
  candidate_contents = null,
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

  const members = compositionMemberHashes(composition_manifest, candidate_members, candidate_contents);
  const missingHashes = [];
  const invalidHashes = [];
  for (const file of required) {
    const digest = members[file];
    if (digest == null || digest === '') {
      missingHashes.push(file);
    } else if (!SHA256_RE.test(String(digest))) {
      invalidHashes.push(file);
    }
  }
  if (missingHashes.length) {
    errors.push(errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'accepted composition requires candidate content hashes; file names alone are not evidence',
      { missing_content_hashes: missingHashes },
    ));
  }
  if (invalidHashes.length) {
    errors.push(errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'accepted composition content hashes must be SHA-256 hex digests of the candidate bytes',
      { invalid_content_hashes: invalidHashes },
    ));
  }

  if (errors.length) return failMany(errors, errors[0].code);
  return ok({
    ...simple.details,
    preserved_paths: required,
    composition_files: [...files].sort(),
    composition_members: Object.fromEntries(required.map((file) => [file, members[file]])),
    registry_manifests: acceptedManifests(registry).map((row) => row.id),
  });
}

export function evaluateGitAncestry(input = {}) {
  const currentMain = String(input.current_main_sha || input.origin_main_sha || '').trim();
  const mergeBase = String(input.merge_base_sha || '').trim();
  const commit = String(input.commit || '').trim();
  const ancestry = input.git_ancestry || input.ancestry || null;
  const errors = [];

  if (!ancestry || typeof ancestry !== 'object') {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'mutating deploy requires verified git-merge-base ancestry; reconciled_with_main=true is not evidence',
    ));
    return failMany(errors, CODES.MAIN_RECONCILIATION_REQUIRED);
  }
  if (!ANCESTRY_METHODS.has(String(ancestry.method || ''))) {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'git ancestry method must be git-merge-base',
      { method: ancestry.method || null },
    ));
  }
  if (ancestry.is_ancestor !== true) {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'current origin/main is not an ancestor of this commit; rebase/compose onto current main',
      { current_main_sha: currentMain, commit },
    ));
  }
  if (String(ancestry.current_main_sha || '') !== currentMain
    || String(ancestry.merge_base_sha || '') !== mergeBase) {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'git ancestry SHAs do not match the declared current_main_sha/merge_base_sha',
      {
        ancestry_main: ancestry.current_main_sha || null,
        ancestry_merge_base: ancestry.merge_base_sha || null,
        current_main_sha: currentMain,
        merge_base_sha: mergeBase,
      },
    ));
  }
  if (commit && ancestry.commit && String(ancestry.commit) !== commit) {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'git ancestry commit does not match this workstream commit',
      { ancestry_commit: ancestry.commit, commit },
    ));
  }
  if (errors.length) return failMany(errors, CODES.MAIN_RECONCILIATION_REQUIRED);
  return ok({
    method: ancestry.method,
    current_main_sha: currentMain,
    merge_base_sha: mergeBase,
    is_ancestor: true,
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
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'branch is not based on current main; reconciled_with_main=true cannot substitute for git-merge-base',
      { current_main_sha: currentMain, merge_base_sha: mergeBase },
    ));
  }
  if (claimed && GIT_SHA_RE.test(currentMain) && claimed !== currentMain) {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'claimed main SHA is stale versus current origin/main',
      { current_main_sha: currentMain, claimed_main_sha: claimed },
    ));
  }

  if (!errors.length) {
    const ancestry = evaluateGitAncestry(input);
    if (!ancestry.ok) return ancestry;
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
    ancestry_verified: true,
  });
}

export function evaluatePreservedMemberIntegrity({
  liveMembers = {},
  candidateMembers = {},
  ownedMembers = [],
  preservedPaths = [],
  livePaths = null,
  candidatePaths = null,
} = {}) {
  const owned = new Set(ownedMembers || []);
  const live = liveMembers && typeof liveMembers === 'object' ? liveMembers : {};
  const candidate = candidateMembers && typeof candidateMembers === 'object' ? candidateMembers : {};
  const errors = [];
  const unexpected = [];
  const missingEvidence = [];
  const requiredLive = livePaths == null ? (preservedPaths || []) : livePaths;
  const requiredCandidate = candidatePaths == null ? (preservedPaths || []) : candidatePaths;
  for (const file of requiredLive) {
    if (live[file] == null || live[file] === '') missingEvidence.push(file);
  }
  for (const file of requiredCandidate) {
    if ((candidate[file] == null || candidate[file] === '') && !missingEvidence.includes(file)) {
      missingEvidence.push(file);
    }
  }
  const comparePaths = [...new Set([...requiredLive, ...requiredCandidate])];
  for (const file of comparePaths) {
    if (owned.has(file)) continue;
    const liveHash = live[file];
    const candidateHash = candidate[file];
    if (liveHash == null || liveHash === '' || candidateHash == null || candidateHash === '') continue;
    if (candidateHash !== liveHash) unexpected.push(file);
  }
  if (missingEvidence.length) {
    errors.push(errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'preserved-member integrity requires live and candidate hashes; omitting both is not a pass',
      { missing_member_evidence: missingEvidence },
    ));
  }
  if (unexpected.length) {
    errors.push(errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      'accepted preserved members would be overwritten or dropped; overlay only owned files',
      { unexpected_preserved_changes: unexpected },
    ));
  }
  if (errors.length) return failMany(errors, errors[0].code);
  return ok({ preserved: (preservedPaths || []).filter((file) => !owned.has(file)) });
}

export { ISO_RE, SHA256_RE };
