/**
 * Post-cutover production SPA lock. Shared by deploy, rollback, and verify.
 * Does not upload or mutate AWS by itself.
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

const fingerprintPath = (relOrAbs) => (
  path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs)
);

export const listValidatedProductionFingerprints = () => {
  const dir = path.join(ROOT, 'aws/cutover/production-spa-fingerprints');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith('production-spa-') && name.endsWith('.json'))
    .map((name) => {
      const full = path.join(dir, name);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      return { name, full, data };
    })
    .filter(({ data }) => isValidatedAwsCognitoFingerprint(data));
};

export const isValidatedAwsCognitoFingerprint = (data = {}) => {
  const lock = PRODUCTION_SPA_LOCK.knownGood;
  if (!data || data.authProvider !== 'cognito') return false;
  if (data.cognito?.userPoolId !== lock.cognitoPoolId) return false;
  if (data.cognito?.clientId !== lock.cognitoClientId) return false;
  if (data.apiTarget !== lock.apiTarget) return false;
  if (data.artifactValidation?.ok !== true) return false;
  if (data.gitCommit !== lock.gitCommit) return false;
  const assets = data.bundle?.assets || {};
  const hasLockedBundle = Object.keys(assets).some((rel) => rel.endsWith(`/${lock.spaBundle}`) || rel === `assets/${lock.spaBundle}`);
  if (!hasLockedBundle) return false;
  return true;
};

export const assertNotSupabaseArtifact = (validation) => {
  if (!validation?.ok) {
    throw lockedError('production_spa_artifact_rejected', validation);
  }
  if (validation.authProvider === 'supabase' || (validation.missing || []).includes('supabase_mode_selected')) {
    throw lockedError('supabase_artifact_forbidden_for_production', validation);
  }
  if ((validation.forbidden || []).includes('supabase_host')) {
    throw lockedError('supabase_artifact_forbidden_for_production', validation);
  }
};

export const assertCloudFrontOriginLocked = (distribution) => {
  const lock = PRODUCTION_SPA_LOCK.knownGood;
  const cfg = distribution?.DistributionConfig || distribution;
  const origins = cfg?.Origins?.Items || [];
  const spa = origins.find((origin) => origin.Id === lock.spaOriginId);
  if (!spa || spa.DomainName !== lock.spaOriginDomain) {
    throw lockedError('cloudfront_spa_origin_unlocked', {
      expected: lock.spaOriginDomain,
      actual: spa?.DomainName || null,
    });
  }
  const defaultOrigin = cfg?.DefaultCacheBehavior?.TargetOriginId;
  if (defaultOrigin !== lock.spaOriginId) {
    throw lockedError('cloudfront_default_origin_unlocked', { defaultOrigin });
  }
  const aliases = cfg?.Aliases?.Items || [];
  for (const alias of lock.aliases) {
    if (!aliases.includes(alias)) {
      throw lockedError('cloudfront_alias_missing', { alias, aliases });
    }
  }
  return true;
};

export const assertProductionSpaApplyAllowed = ({
  env = process.env,
  argv = process.argv,
  validation = null,
  fingerprintFile = null,
} = {}) => {
  const lock = PRODUCTION_SPA_LOCK;
  const unlocked = String(env[lock.unlockEnv] || '') === lock.unlockValue;
  const fromIdx = argv.indexOf('--from-fingerprint');
  const fromFile = fingerprintFile || (fromIdx >= 0 ? argv[fromIdx + 1] : null);

  if (!unlocked) {
    throw lockedError(lock.applyRefusedError, {
      hint: 'Production SPA cutover is locked. Do not use npm run build, vite build, or raw s3 sync. Rollback requires a previously validated AWS/Cognito fingerprint plus CHECKSOPS_PRODUCTION_SPA_UNLOCK=RELEASE_CUTOVER_LOCK.',
    });
  }
  if (!fromFile) {
    throw lockedError('production_spa_rollback_fingerprint_required', {
      hint: 'Unlock only allows restoring a previously validated AWS/Cognito fingerprint.',
    });
  }
  const full = fingerprintPath(fromFile);
  if (!fs.existsSync(full)) {
    throw lockedError('production_spa_fingerprint_missing', { full });
  }
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!isValidatedAwsCognitoFingerprint(data)) {
    throw lockedError('supabase_or_unvalidated_fingerprint_forbidden', {
      gitCommit: data.gitCommit || null,
      authProvider: data.authProvider || null,
    });
  }
  if (validation) assertNotSupabaseArtifact(validation);
  return data;
};

export const refuseCloudFrontMutation = () => {
  throw lockedError('production_cloudfront_cutover_locked', {
    hint: 'CloudFront origin must remain ProductionSpaS3 on the locked production bucket. Do not repoint to Lovable/Supabase/legacy frontend.',
  });
};

export const scanAndRejectSupabase = (distDir) => {
  const validation = scanProductionSpaArtifact(distDir);
  assertNotSupabaseArtifact(validation);
  return validation;
};
