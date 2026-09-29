import { CODES, errorEntry, failMany, ok } from './errors.mjs';

export const REJECTED_PACKAGE_ORIGINS = Object.freeze([
  'saved-live-zip',
  'tmp-deployment-package',
  'stale-dist',
  'previously-built-spa',
  'branch-local-full-lambda',
  'reused-old-zip',
  'reclaim-baseline',
]);

export const REQUIRED_PACKAGE_ORIGIN = 'fresh-live-download';

export function evaluatePackageProvenance(pkg = {}) {
  const errors = [];
  const origin = String(pkg.origin || '').trim();
  if (!origin) {
    errors.push(errorEntry(CODES.STALE_PACKAGE, 'package origin is required; every deployment begins from CURRENT live state'));
  } else if (REJECTED_PACKAGE_ORIGINS.includes(origin)) {
    errors.push(errorEntry(CODES.STALE_PACKAGE, `rejected package origin ${origin}; never reuse old saved ZIPs, /tmp packages, stale dist, or branch-local full Lambda baselines`, { origin }));
  } else if (origin !== REQUIRED_PACKAGE_ORIGIN) {
    errors.push(errorEntry(CODES.STALE_PACKAGE, `package origin must be ${REQUIRED_PACKAGE_ORIGIN}`, { origin }));
  }
  if (pkg.stale === true) {
    errors.push(errorEntry(CODES.STALE_PACKAGE, 'package is marked stale'));
  }
  if (pkg.reused === true) {
    errors.push(errorEntry(CODES.STALE_PACKAGE, 'reused package is forbidden'));
  }
  if (pkg.reclaim === true) {
    errors.push(errorEntry(CODES.STALE_PACKAGE, 'reclaim/restore packages are forbidden'));
  }
  if (pkg.downloaded_at && pkg.preflight_at && Date.parse(pkg.downloaded_at) < Date.parse(pkg.preflight_at)) {
    errors.push(errorEntry(CODES.STALE_PACKAGE, 'package was downloaded before this preflight; download CURRENT live state immediately before deployment', {
      downloaded_at: pkg.downloaded_at,
      preflight_at: pkg.preflight_at,
    }));
  }
  if (pkg.max_age_ms && pkg.downloaded_at && pkg.now) {
    const age = Date.parse(pkg.now) - Date.parse(pkg.downloaded_at);
    if (Number.isFinite(age) && age > pkg.max_age_ms) {
      errors.push(errorEntry(CODES.STALE_PACKAGE, 'live package download is older than the allowed window', {
        age_ms: age,
        max_age_ms: pkg.max_age_ms,
      }));
    }
  }
  if (errors.length) return failMany(errors, CODES.STALE_PACKAGE);
  return ok({ origin, accepted: true });
}

export function evaluateDistFreshness(dist = {}) {
  const errors = [];
  if (dist.stale === true || dist.origin === 'stale-dist' || dist.origin === 'previously-built-spa') {
    errors.push(errorEntry(CODES.STALE_PACKAGE, 'stale dist / previously built SPA artifact is rejected; require a fresh clean build', {
      origin: dist.origin || 'stale-dist',
    }));
  }
  if (dist.clean_build !== true) {
    errors.push(errorEntry(CODES.STALE_PACKAGE, 'SPA/frontend deployment requires a fresh clean build (clean_build=true)'));
  }
  if (dist.reused_index === true || dist.restore_previous_index === true) {
    errors.push(errorEntry(CODES.STALE_PACKAGE, 'never put an old index.html back or restore a previous dist'));
  }
  if (errors.length) return failMany(errors, CODES.STALE_PACKAGE);
  return ok({ clean_build: true });
}
