/**
 * Official production-spa-upload pins for the approved QDJi→DSb recovery.
 * Historical bundles are provenance, not rollback targets.
 * Never writes AWS.
 */
import { ACCEPTED_PRODUCTION_SPA, SUPERSEDED_PRODUCTION_SPA_BUNDLES, normalizeSpaBundle } from './production-spa-baseline.mjs';

export const WORKSTREAM_ID = 'regression-recovery-matrix-f477';

export const CURRENT_LIVE_PRODUCTION_SPA = Object.freeze({
  host: 'https://checksops.com',
  spa_bundle: '/assets/index-DSbVZXu8.js',
  spa_sha256: '8da351ee4060d065e626b382fec06acf9a7099317184980979b95468e7e4bbe5',
  index_html_sha256: 'e93fe5488c013aed91626da1ee608978f702796a24e08350306ccb4c3163e75f',
  s3_version: 'Jc2Nyp5THf1j30gf21cQHeMoApSs8uDw',
  etag: 'f92d3a12bd1f8eec9c200dbe71c05ae3',
  last_modified: '2026-09-30T21:20:11+00:00',
  source_pr: 582,
});

export const COMPOSED_SPA_CANDIDATE = Object.freeze({
  spa_bundle: '/assets/index-CvCKsSsX.js',
  spa_sha256: 'cd55efcde625c03ab8bba60decec3c4d6b3bb53e3a8e45dd6a4c2b9991065007',
  index_html_sha256: '0dac8cbceba15a086567511c447279c6a439c9c120079ebebb19309a8bf24e89',
  based_on_live: '/assets/index-DSbVZXu8.js',
  walletops: '/assets/WalletOps-B4ZiFA_r.js',
  walletops_sha256: '5a7268c2779bb2cf10712a57d96179e9f2e199647f1917831efd1d77376ffb01',
  deposits: '/assets/BankDepositReconciliation-CowUe23o.js',
  deposits_sha256: 'd64fa27c35369e30bebac484ad113f42812a8c48d8576917186745b7c3525615',
  ccc: '/assets/CheckCommandCenter-BfeHKvNb.js',
});

export const HISTORICAL_SPA_BUNDLES = Object.freeze([
  ...SUPERSEDED_PRODUCTION_SPA_BUNDLES,
  ACCEPTED_PRODUCTION_SPA.spa_bundle,
  '/assets/index-DvVldu_B.js',
  '/assets/index-CfEPSd2I.js',
  '/assets/index-C_fh5VBD.js',
  '/assets/index-CEKjixtZ.js',
  '/assets/index-C9QrEEkl.js',
  '/assets/index-C8adM6cZ.js',
  '/assets/index-DbYbvb6d.js',
  '/assets/index-QDJiUFF1.js',
  '/assets/index-DSbVZXu8.js',
]);

export function isHistoricalSpaBundle(bundle) {
  const normalized = normalizeSpaBundle(bundle);
  return Boolean(normalized && HISTORICAL_SPA_BUNDLES.includes(normalized));
}

export function fingerprintDiffs(reviewed, live, fields) {
  const diffs = [];
  for (const field of fields) {
    const expected = reviewed?.[field];
    const actual = live?.[field];
    if (expected !== actual) {
      diffs.push({ field, reviewed: expected ?? null, live: actual ?? null });
    }
  }
  return diffs;
}

export function evaluateReviewedBaselineMatch({ kind, reviewed, live }) {
  if (!live || typeof live !== 'object') {
    return {
      ok: false,
      code: 'DEPLOYMENT_COLLISION',
      message: `${kind} live fingerprint is missing; stop and do not apply`,
      diffs: [],
    };
  }
  const fields = kind === 'lambda'
    ? ['codeSha256', 'revisionId']
    : ['spa_bundle', 'spa_sha256', 'index_html_sha256', 's3_version'];
  const diffs = fingerprintDiffs(reviewed, live, fields);
  if (diffs.length) {
    return {
      ok: false,
      code: 'DEPLOYMENT_COLLISION',
      message: `${kind} live fingerprint differs from the reviewed baseline; stop and do not restore or overwrite newer work`,
      diffs,
    };
  }
  return { ok: true, code: null, message: 'reviewed baseline matches live', diffs: [] };
}

export function evaluateHistoricalRestore({ candidateBundle, restoreHistorical = false } = {}) {
  if (restoreHistorical === true || isHistoricalSpaBundle(candidateBundle)) {
    return {
      ok: false,
      code: 'STALE_PACKAGE',
      message: 'historical artifact hashes are provenance, not rollback targets; refuse restore of an older SPA or Lambda package',
      candidate_bundle: candidateBundle || null,
    };
  }
  return { ok: true, code: null, message: 'candidate is not a historical restore' };
}
