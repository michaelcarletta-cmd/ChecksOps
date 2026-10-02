/**
 * Production SPA baseline helpers.
 *
 * Protects the already-live checksops.com SPA so a stale branch, unreconciled
 * main, or destructive overlay cannot overwrite it. Never writes AWS.
 */
import { isSha256 } from './release-locks.mjs';

export const PRODUCTION_SPA_ID = 'production-spa';

export const ACCEPTED_PRODUCTION_SPA = Object.freeze({
  host: 'https://checksops.com',
  spa_bundle: '/assets/index-gYa_BW8r.js',
  spa_sha256: '71dcf3eb5f95eafcbc19e47897b0d106c1194044d4ef9c40f8f831fdfbecd280',
  index_html_sha256: '791bae2c9157442e0c7ea9f412db54bae482f57f476703c6434df57275f06805',
  s3_version: 'TYCJ6QSvW7E1bkW1sRdPbvpwJlWeCTsJ',
  cloudfront_id: 'E1B0ZWWO5559U5',
  last_modified: 'Fri, 02 Oct 2026 01:51:18 GMT',
  accepted_at: '2026-10-02T01:51:18Z',
  source_lineage: 'e3e4649478a0c3978065b71b0528dd93baa8dac1',
  banner_overlay: 'b39738cab7c1afd68e97c88781766b6cabe04896',
  s3_bucket: 'checksops-production-frontend-806168576068',
});

export const SUPERSEDED_PRODUCTION_SPA_BUNDLES = Object.freeze([
  '/assets/index-DSbVZXu8.js',
  '/assets/index-BPbQUNFr.js',
  '/assets/index-CTqMys28.js',
  '/assets/index-BAD1KYoF.js',
  '/assets/index-C24V_ODo.js',
  '/assets/index-reP2FWHf.js',
  '/assets/index-CiOVNYWh.js',
  '/assets/index-DyoF7zdg.js',
]);

export const SAFE_SPA_DEPLOY_MODE = 'per_object_put';

export const DESTRUCTIVE_SPA_DEPLOY_MODES = Object.freeze([
  's3_sync_delete',
  's3_sync',
  'sync_delete',
  'destructive',
]);

export function normalizeSpaBundle(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('/')) return trimmed;
  if (trimmed.startsWith('assets/')) return `/${trimmed}`;
  return trimmed;
}

export function lockedSpaPins(component) {
  const fp = component?.deployment_fingerprint || {};
  return {
    spa_bundle: normalizeSpaBundle(fp.spa_bundle || component?.artifact?.name),
    spa_sha256: fp.spa_sha256 || component?.artifact?.hash || null,
    index_html_sha256: fp.config_hash || null,
    s3_version: fp.cloudfront_deployment_fingerprint || component?.artifact?.version || null,
  };
}

export function snapshotPins(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    spa_bundle: normalizeSpaBundle(snapshot.spa_bundle),
    spa_sha256: snapshot.spa_sha256 || snapshot.hash || null,
    index_html_sha256: snapshot.index_html_sha256 || null,
    s3_version: snapshot.s3_version || null,
  };
}

export function pinsEqual(left, right) {
  if (!left || !right) return false;
  return left.spa_bundle === right.spa_bundle
    && left.spa_sha256 === right.spa_sha256
    && left.index_html_sha256 === right.index_html_sha256
    && left.s3_version === right.s3_version;
}

export function candidatePins(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    spa_bundle: normalizeSpaBundle(row.spa_bundle),
    spa_sha256: row.hash || row.spa_sha256 || null,
    index_html_sha256: row.index_html_sha256 || null,
    s3_version: row.s3_version || null,
  };
}

export function isSupersededSpaBundle(bundle) {
  const normalized = normalizeSpaBundle(bundle);
  if (!normalized) return false;
  return SUPERSEDED_PRODUCTION_SPA_BUNDLES.includes(normalized);
}

export function isDestructiveSpaDeploy(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.destructive === true) return true;
  const mode = String(row.deploy_mode || '').trim();
  if (DESTRUCTIVE_SPA_DEPLOY_MODES.includes(mode)) return true;
  return /sync/i.test(mode) && /delete/i.test(mode);
}

export function isUnreconciledMainSource(row, { matchesLockedIdentity, basedOnLocked }) {
  if (matchesLockedIdentity || basedOnLocked) return false;
  if (row?.reconciled_to_production_baseline === true) return false;
  if (row?.unreconciled_main === true) return true;
  const sourceRef = String(row?.source_branch || row?.source_ref || '').trim();
  return sourceRef === 'main' || sourceRef === 'origin/main' || sourceRef === 'refs/heads/main';
}

export function compareProductionSpaCandidate(component, row) {
  const errors = [];
  const prefix = PRODUCTION_SPA_ID;
  if (!row || typeof row !== 'object') {
    errors.push(`${prefix}: PRODUCTION_LOCKED component missing from candidate fingerprint`);
    return errors;
  }

  const locked = lockedSpaPins(component);
  const current = candidatePins(row);
  const basedOn = snapshotPins(row.based_on_baseline);
  const matchesLockedIdentity = Boolean(
    current?.spa_bundle
    && current?.spa_sha256
    && current.spa_bundle === locked.spa_bundle
    && current.spa_sha256 === locked.spa_sha256,
  );
  const basedOnLocked = pinsEqual(basedOn, locked);

  if (row.deploy === true) {
    const preflight = snapshotPins(row.preflight_production);
    const live = snapshotPins(row.live_production);
    if (!preflight || !live) {
      errors.push(`${prefix}: production SPA deploy requires preflight_production and live_production TOCTOU snapshots`);
    } else {
      if (!pinsEqual(preflight, live)) {
        errors.push(`${prefix}: production changed after preflight (TOCTOU); refuse deployment`);
      }
      if (!pinsEqual(live, locked)) {
        errors.push(`${prefix}: live production SPA does not match locked baseline; refuse deployment (do not auto-fix)`);
      }
    }
    if (isDestructiveSpaDeploy(row)) {
      errors.push(`${prefix}: destructive frontend deployment is forbidden (no s3 sync --delete)`);
    } else if (!row.deploy_mode) {
      errors.push(`${prefix}: production SPA deploy requires deploy_mode=${SAFE_SPA_DEPLOY_MODE}`);
    } else if (row.deploy_mode !== SAFE_SPA_DEPLOY_MODE) {
      errors.push(`${prefix}: production SPA deploy_mode must be ${SAFE_SPA_DEPLOY_MODE}`);
    }
  }

  if (isSupersededSpaBundle(current?.spa_bundle) || isSupersededSpaBundle(basedOn?.spa_bundle)) {
    errors.push(`${prefix}: stale SPA candidate is older than the accepted production baseline`);
  }

  if (isUnreconciledMainSource(row, { matchesLockedIdentity, basedOnLocked })) {
    errors.push(`${prefix}: unreconciled main/source is not the accepted production SPA baseline; refuse deployment`);
  }

  if (!matchesLockedIdentity) {
    if (!basedOn) {
      errors.push(`${prefix}: candidate is missing the accepted production baseline (based_on_baseline required when identity differs)`);
    } else if (!basedOnLocked) {
      errors.push(`${prefix}: based_on_baseline does not match the locked production SPA; refuse deployment`);
    }
    if (row.contains_accepted_baseline === false) {
      errors.push(`${prefix}: candidate drops accepted production baseline/source`);
    }
  }

  if (component.artifact?.hash && !isSha256(row.hash || row.spa_sha256 || '')) {
    errors.push(`${prefix}: candidate omitted artifact hash`);
  }

  return errors;
}

export function acceptedBaselineCandidate({ deploy = true } = {}) {
  const pins = {
    spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
    spa_sha256: ACCEPTED_PRODUCTION_SPA.spa_sha256,
    index_html_sha256: ACCEPTED_PRODUCTION_SPA.index_html_sha256,
    s3_version: ACCEPTED_PRODUCTION_SPA.s3_version,
  };
  return {
    environment: 'production',
    approved: true,
    components: {
      [PRODUCTION_SPA_ID]: {
        deploy,
        hash: ACCEPTED_PRODUCTION_SPA.spa_sha256,
        spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
        index_html_sha256: ACCEPTED_PRODUCTION_SPA.index_html_sha256,
        s3_version: ACCEPTED_PRODUCTION_SPA.s3_version,
        based_on_baseline: { ...pins },
        preflight_production: { ...pins },
        live_production: { ...pins },
        deploy_mode: SAFE_SPA_DEPLOY_MODE,
        contains_accepted_baseline: true,
        reconciled_to_production_baseline: true,
      },
    },
  };
}
