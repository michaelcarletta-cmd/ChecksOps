/**
 * Production SPA lock for the M7.5 money-test hold.
 * Reuses the existing cutover lock files/mechanism. Does not upload by itself.
 *
 * The previous CheckAlt overwrite used CHECKSOPS_PRODUCTION_SPA_UNLOCK=RELEASE_CUTOVER_LOCK
 * plus an old fingerprint while building different source. This hold:
 *   1. no longer honors RELEASE_CUTOVER_LOCK
 *   2. requires the compiled dist to pass the M7.5 money-path scan
 *   3. does not treat an old fingerprint as authority for a new build
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProductionSpaArtifact } from './validate-production-spa-artifact.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCTION_SPA_LOCK_PATH = path.join(ROOT, 'aws/cutover/PRODUCTION_SPA_LOCK.json');

export const loadProductionSpaLock = () => JSON.parse(fs.readFileSync(PRODUCTION_SPA_LOCK_PATH, 'utf8'));

export const PRODUCTION_SPA_LOCK = loadProductionSpaLock();

export const lockedError = (error, extra = {}) => {
  const err = new Error(error);
  err.code = error;
  err.extra = extra;
  return err;
};

export const assertMoneyTestSpaArtifact = (validation) => {
  if (!validation?.ok) {
    throw lockedError('production_spa_artifact_rejected', validation);
  }
  const counts = validation.moneyCounts || {};
  if ((counts['moov-transfer-create'] || 0) > 0) {
    throw lockedError('moov_transfer_create_forbidden_during_money_test', counts);
  }
  for (const key of ['moov-wallet-fund', 'moov-disburse', 'wallet.fund', 'wallet.disburse']) {
    if ((counts[key] || 0) < 1) {
      throw lockedError('money_ui_marker_missing', { key, counts });
    }
  }
  return true;
};

export const assertNotSupabaseArtifact = (validation) => {
  if (!validation?.ok) {
    throw lockedError('production_spa_artifact_rejected', validation);
  }
  if ((validation.forbidden || []).includes('supabase_host')
    || (validation.forbidden || []).includes('supabase_functions_host')) {
    throw lockedError('supabase_artifact_forbidden_for_production', validation);
  }
};

export const assertProductionSpaApplyAllowed = ({
  env = process.env,
  validation = null,
} = {}) => {
  const lock = loadProductionSpaLock();
  const provided = String(env[lock.unlockEnv] || '');
  if (provided === lock.cutoverUnlockValueNoLongerHonored) {
    throw lockedError(lock.applyRefusedError, {
      hint: 'RELEASE_CUTOVER_LOCK is no longer accepted. The live SPA is held for the M7.5 1-cent dark wallet.fund test. Do not deploy CheckAlt or other workstream SPAs over it.',
    });
  }
  if (provided !== lock.unlockValue) {
    throw lockedError(lock.applyRefusedError, {
      hint: 'Production SPA is locked for the M7.5 money test. Do not use raw s3 sync. Apply requires CHECKSOPS_PRODUCTION_SPA_UNLOCK=M75_MONEY_TEST_HOLD_RELEASE and a dist that contains wallet.fund / moov-wallet-fund with zero moov-transfer-create.',
    });
  }
  if (validation) {
    assertNotSupabaseArtifact(validation);
    assertMoneyTestSpaArtifact(validation);
  }
  return lock;
};

export const scanAndRejectSupabase = (distDir) => {
  const validation = scanProductionSpaArtifact(distDir);
  assertNotSupabaseArtifact(validation);
  assertMoneyTestSpaArtifact(validation);
  return validation;
};
