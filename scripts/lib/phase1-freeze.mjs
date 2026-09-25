/**
 * Phase 1 freeze and cross-build overwrite protection.
 *
 * Behavioral invariants stay in test:aws-api. Deployment safety compares a
 * candidate to the current live production package, not an old snapshot.
 * Does not pin production forever to the Phase 1 closure SHA.
 * Does not call AWS, apply SQL, or deploy unless a caller does so separately.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PHASE1_FREEZE_LABEL = 'Phase 1 Freeze';
export const STALE_BASELINE_LABEL = 'Stale Production Baseline Protection';
export const CROSS_BUILD_LABEL = 'Cross-Build Overwrite Protection';
export const TOCTOU_ABORT = 'ABORT. PRODUCTION CHANGED SINCE PREFLIGHT.';
export const MANIFEST_REL = 'aws/audit/phase1-freeze-manifest.json';
export const PRODUCTION_FUNCTION = 'checksops-production-prep-api';

export const CONFIG_KEYS = Object.freeze([
  'Environment',
  'Role',
  'VpcConfig',
  'MemorySize',
  'Timeout',
  'Layers',
  'Description',
  'Handler',
  'Runtime',
]);

export const freezeError = (label, message) => {
  const error = new Error(`${label}: ${message}`);
  error.phase1Freeze = true;
  error.label = label;
  return error;
};

export const loadPhase1FreezeManifest = (root) => {
  const abs = path.join(root, MANIFEST_REL);
  const manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (manifest.status !== 'COMPLETE / PASS') {
    throw freezeError(PHASE1_FREEZE_LABEL, 'manifest status is not COMPLETE / PASS');
  }
  if (manifest.officialScenarioIds?.length !== 15) {
    throw freezeError(PHASE1_FREEZE_LABEL, 'official matrix must remain S1–S15');
  }
  if (manifest.shaPinPolicy !== 'historical_provenance_only') {
    throw freezeError(PHASE1_FREEZE_LABEL, 'closure SHA must not be a permanent pin');
  }
  return manifest;
};

export const readRepoFile = (root, rel, overrides = {}) => {
  if (Object.prototype.hasOwnProperty.call(overrides, rel)) return String(overrides[rel] ?? '');
  return fs.readFileSync(path.join(root, rel), 'utf8');
};

export const eachProtectedFile = (component, visitor) => {
  for (const entry of component.files || []) {
    if (typeof entry === 'string') {
      visitor(entry, component.markers || []);
    } else if (entry?.path) {
      visitor(entry.path, entry.markers || []);
    }
  }
};

export const assertProtectedComponentsPresent = (root, manifest, overrides = {}) => {
  const errors = [];
  for (const component of Object.values(manifest.protectedRuntimeComponents || {})) {
    eachProtectedFile(component, (rel, markers) => {
      const source = readRepoFile(root, rel, overrides);
      if (!source.trim()) {
        errors.push(`${component.label}: protected file missing or empty: ${rel}`);
        return;
      }
      for (const marker of markers) {
        if (!source.includes(marker)) {
          errors.push(`${component.label}: candidate is missing accepted marker ${marker} in ${rel}`);
        }
      }
    });
    if (component.sqlContract) {
      const sql = readRepoFile(root, component.sqlContract, overrides);
      if (!sql.includes('admin_set_check_claim') || !sql.includes('SECURITY DEFINER')) {
        errors.push(`${component.label}: SQL contract/migration record is missing`);
      }
      if (component.sqlAutoExecute !== false) {
        errors.push(`${component.label}: SQL contract must remain sqlAutoExecute=false`);
      }
    }
  }
  if (errors.length) {
    throw freezeError(PHASE1_FREEZE_LABEL, errors.join('; '));
  }
};

export const requireCandidateBaselineSha = (baselineSha) => {
  if (!String(baselineSha || '').trim()) {
    throw freezeError(
      STALE_BASELINE_LABEL,
      'candidate baseline SHA is required; do not default to the current live SHA',
    );
  }
  return String(baselineSha).trim();
};

export const assertMandatorySafeguardsPresent = (root, manifest) => {
  for (const rel of manifest.mandatorySafeguardSuites || []) {
    if (!fs.existsSync(path.join(root, rel))) {
      throw freezeError(PHASE1_FREEZE_LABEL, `mandatory safeguard suite missing: ${rel}`);
    }
  }
};

export const assertCandidatePreservesPhase1 = (root, overrides = {}) => {
  const manifest = loadPhase1FreezeManifest(root);
  assertProtectedComponentsPresent(root, manifest, overrides);
  assertMandatorySafeguardsPresent(root, manifest);
  return { ok: true, manifest };
};

const unique = (values) => [...new Set(values.filter(Boolean))];

export const planNarrowOverlay = ({
  liveFiles = {},
  candidateFiles = {},
  intendedAdds = [],
  intendedModifies = [],
  intendedRemoves = [],
  liveSha = null,
  baselineSha = null,
  candidateMode = 'narrow-overlay',
  applyConfig = false,
  executeSql = false,
  liveConfig = null,
  candidateConfig = null,
} = {}) => {
  const errors = [];
  const intendedAddsSet = new Set(intendedAdds);
  const intendedModifiesSet = new Set(intendedModifies);
  const intendedRemovesSet = new Set(intendedRemoves);
  const declared = new Set([...intendedAddsSet, ...intendedModifiesSet, ...intendedRemovesSet]);

  const manifest = {
    productionShaBefore: liveSha,
    candidateBaselineSha: baselineSha,
    filesIntentionallyAdded: [],
    filesIntentionallyModified: [],
    filesIntentionallyRemoved: [],
    unexpectedLiveOnlyDifferences: [],
    unexpectedCandidateOnlyDifferences: [],
    candidateMode,
  };

  if (!liveSha || !baselineSha) {
    errors.push(`${STALE_BASELINE_LABEL}: production SHA and candidate baseline SHA are required`);
  } else if (liveSha !== baselineSha) {
    errors.push(
      `${STALE_BASELINE_LABEL}: live ${liveSha} differs from candidate baseline ${baselineSha}. `
      + 'Reconcile/rebase onto the current live package. Do not automatically resolve drift.',
    );
  }

  if (candidateMode === 'full-zip-replace') {
    for (const file of Object.keys(liveFiles)) {
      if (!(file in candidateFiles) && !intendedRemovesSet.has(file)) {
        manifest.unexpectedLiveOnlyDifferences.push(file);
        errors.push(
          `${CROSS_BUILD_LABEL}: live-only file ${file} is absent from the candidate and is not an explicit delete`,
        );
      }
    }
  }

  for (const file of Object.keys(candidateFiles)) {
    const liveHas = Object.prototype.hasOwnProperty.call(liveFiles, file);
    const same = liveHas && liveFiles[file] === candidateFiles[file];
    if (!liveHas && !intendedAddsSet.has(file)) {
      manifest.unexpectedCandidateOnlyDifferences.push(file);
      errors.push(`${CROSS_BUILD_LABEL}: candidate-only file ${file} is not declared as an intentional add`);
    } else if (liveHas && !same && !declared.has(file)) {
      manifest.unexpectedCandidateOnlyDifferences.push(file);
      errors.push(
        `${CROSS_BUILD_LABEL}: candidate would overwrite newer live ${file} without declaring it`,
      );
    }
  }

  for (const file of intendedRemoves) {
    if (!Object.prototype.hasOwnProperty.call(liveFiles, file)) {
      errors.push(`${CROSS_BUILD_LABEL}: explicit delete ${file} is not present in the live package`);
    } else {
      manifest.filesIntentionallyRemoved.push(file);
    }
  }
  for (const file of intendedAdds) {
    if (!Object.prototype.hasOwnProperty.call(candidateFiles, file)) {
      errors.push(`${CROSS_BUILD_LABEL}: intentional add ${file} is missing from the candidate`);
    } else {
      manifest.filesIntentionallyAdded.push(file);
    }
  }
  for (const file of intendedModifies) {
    if (!Object.prototype.hasOwnProperty.call(candidateFiles, file)) {
      errors.push(`${CROSS_BUILD_LABEL}: intentional modify ${file} is missing from the candidate`);
    } else {
      manifest.filesIntentionallyModified.push(file);
    }
  }

  if (applyConfig) {
    errors.push(`${PHASE1_FREEZE_LABEL}: code-only promotion cannot silently change Lambda configuration`);
  }
  if (liveConfig && candidateConfig && applyConfig) {
    for (const key of CONFIG_KEYS) {
      if (JSON.stringify(liveConfig[key]) !== JSON.stringify(candidateConfig[key])) {
        errors.push(`${PHASE1_FREEZE_LABEL}: configuration drift would be applied for ${key}`);
      }
    }
  }
  if (executeSql) {
    errors.push(`${PHASE1_FREEZE_LABEL}: SQL files cannot execute as a side effect of code promotion`);
  }

  const overlay = { ...liveFiles };
  if (errors.length === 0) {
    for (const file of intendedAddsSet) overlay[file] = candidateFiles[file];
    for (const file of intendedModifiesSet) overlay[file] = candidateFiles[file];
    for (const file of intendedRemovesSet) delete overlay[file];
  }

  return {
    ok: errors.length === 0,
    errors,
    manifest: {
      ...manifest,
      unexpectedLiveOnlyDifferences: unique(manifest.unexpectedLiveOnlyDifferences),
      unexpectedCandidateOnlyDifferences: unique(manifest.unexpectedCandidateOnlyDifferences),
    },
    overlay,
  };
};

export const assertDeployShaUnchanged = ({ preflightSha, currentSha }) => {
  if (!preflightSha || !currentSha || preflightSha !== currentSha) {
    throw freezeError(STALE_BASELINE_LABEL, TOCTOU_ABORT);
  }
};

export const refuseProductionOverlayBypass = (functionName) => {
  const name = String(functionName || '');
  if (name === PRODUCTION_FUNCTION || /production/i.test(name)) {
    throw freezeError(
      PHASE1_FREEZE_LABEL,
      `staging overlay must not target ${name}; use scripts/aws-production-overlay.mjs`,
    );
  }
};

export const reportConfigDrift = (liveConfig = {}, candidateConfig = {}) => {
  const drift = [];
  for (const key of CONFIG_KEYS) {
    if (JSON.stringify(liveConfig[key]) !== JSON.stringify(candidateConfig[key])) {
      drift.push(key);
    }
  }
  return drift;
};

export const assertCodeOnlyPromotion = ({
  applyConfig = false,
  executeSql = false,
  updateFunctionConfiguration = false,
  sqlRunner = null,
} = {}) => {
  const errors = [];
  if (applyConfig || updateFunctionConfiguration) {
    errors.push('UpdateFunctionCode work must remain code-only');
  }
  if (executeSql || typeof sqlRunner === 'function') {
    errors.push('a future code build must never automatically replay production SQL');
  }
  if (errors.length) throw freezeError(PHASE1_FREEZE_LABEL, errors.join('; '));
  return { ok: true, sqlExecuted: false, configurationUpdated: false };
};

export const assertPromotionScriptsRemainCodeOnly = (root) => {
  const overlay = readRepoFile(root, 'scripts/aws-production-overlay.mjs');
  const staging = readRepoFile(root, 'scripts/aws-overlay-staging-api.mjs');
  const errors = [];
  if (overlay.includes('UpdateFunctionConfiguration')) {
    errors.push('production overlay must not call UpdateFunctionConfiguration');
  }
  if (/\bpsql\b/.test(overlay) || overlay.includes('71_admin_set_check_claim.sql')) {
    errors.push('production overlay must not execute SQL as a code-promotion side effect');
  }
  if (!overlay.includes('assertDeployShaUnchanged') || !overlay.includes('update-function-code')) {
    errors.push('production overlay must recheck SHA immediately before UpdateFunctionCode');
  }
  if (!overlay.includes('requireCandidateBaselineSha')) {
    errors.push('production overlay must require an explicit candidate baseline SHA');
  }
  if (!staging.includes('refuseProductionOverlayBypass')) {
    errors.push('staging overlay must refuse a production function name');
  }
  if (errors.length) throw freezeError(PHASE1_FREEZE_LABEL, errors.join('; '));
  return { ok: true };
};
