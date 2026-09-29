/**
 * SPA / CloudFront promotion safety.
 *
 * Vite builds cannot be independently overlaid like Lambda members.
 * Fresh clean builds only. Re-read live index.html immediately before
 * switching. Never restore an old dist or reclaim staging.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTED_PRODUCTION_SPA,
  compareProductionSpaCandidate,
  PRODUCTION_SPA_ID,
} from '../lib/production-spa-baseline.mjs';
import {
  CODES,
  assertFreshPackage,
  assertNoReclaim,
  fail,
  fingerprintsEqual,
  ok,
  sha256Text,
} from './lib.mjs';

export function spaFingerprint(row = {}) {
  return {
    index_html_sha256: row.index_html_sha256 || row.indexHtmlSha256 || null,
    entry_bundle: row.entry_bundle || row.spa_bundle || row.entryBundle || null,
    etag: row.etag || null,
  };
}

export function assertFreshSpaBuild(dist = {}) {
  const reclaim = assertNoReclaim(dist);
  if (!reclaim.ok) return reclaim;
  if (dist.fresh_clean_build !== true && dist.source !== 'fresh_clean_build') {
    return fail(CODES.STALE_PACKAGE_REJECTED, 'SPA deploy requires a fresh clean build', { dist });
  }
  const provenance = assertFreshPackage({
    source: dist.source || (dist.fresh_clean_build ? 'fresh_clean_build' : null),
    previously_built_spa: dist.previously_built_spa,
    stale_dist: dist.stale_dist,
    from_tmp_cache: dist.from_tmp_cache,
  });
  if (!provenance.ok) return provenance;
  if (Number.isFinite(dist.age_ms) && dist.max_age_ms && dist.age_ms > dist.max_age_ms) {
    return fail(CODES.STALE_PACKAGE_REJECTED, 'SPA dist is older than the allowed fresh-build window', { dist });
  }
  return ok({ dist });
}

export function assertSpaComposition({ frontendWorkstreams = [], compositionAccepted = false } = {}) {
  const unique = [...new Set((frontendWorkstreams || []).filter(Boolean))];
  if (unique.length > 1 && compositionAccepted !== true) {
    return fail(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'multiple workstreams contain frontend changes; build one combined source candidate',
      { frontendWorkstreams: unique },
    );
  }
  return ok({ frontendWorkstreams: unique, compositionAccepted: unique.length <= 1 || compositionAccepted === true });
}

export function assertIndexHtmlCas({ preflight, live }) {
  const left = spaFingerprint(preflight);
  const right = spaFingerprint(live);
  if (!left.index_html_sha256 || !right.index_html_sha256) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'SPA CAS requires current and preflight index.html fingerprints');
  }
  if (!fingerprintsEqual(left, right, ['index_html_sha256'])) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'live index.html changed after preflight; never put the old index.html back', {
      preflight: left,
      live: right,
    });
  }
  return ok({ fingerprint: right });
}

export function planSpaPromote(input = {}) {
  const reclaim = assertNoReclaim(input.intent || input);
  if (!reclaim.ok) return reclaim;
  const fresh = assertFreshSpaBuild(input.dist || {});
  if (!fresh.ok) return fresh;
  const composition = assertSpaComposition({
    frontendWorkstreams: input.frontendWorkstreams || input.manifest?.frontend_workstreams,
    compositionAccepted: input.compositionAccepted,
  });
  if (!composition.ok) return composition;
  if (input.preflight && input.live) {
    const cas = assertIndexHtmlCas({ preflight: input.preflight, live: input.live });
    if (!cas.ok) return cas;
  }
  const required = input.requiredArtifacts || ['index.html', 'entry_bundle', 'source_composition_manifest'];
  const missing = required.filter((name) => {
    if (name === 'index.html') return !(input.dist?.index_html_sha256 || input.candidate?.index_html_sha256);
    if (name === 'entry_bundle') return !(input.dist?.entry_bundle || input.candidate?.spa_bundle || input.candidate?.entry_bundle);
    if (name === 'source_composition_manifest') return !input.sourceCompositionManifest && !input.compositionAccepted && (input.frontendWorkstreams || []).length > 1;
    return false;
  });
  if (missing.length) {
    return fail(CODES.INVALID_MANIFEST, `SPA promote is missing required artifacts: ${missing.join(', ')}`, { missing });
  }
  if (input.environment === 'production' && input.lockedComponent) {
    const errors = compareProductionSpaCandidate(input.lockedComponent, input.candidate || {});
    if (errors.length) {
      return fail(CODES.DEPLOYMENT_COLLISION, errors[0], { errors });
    }
  }
  return ok({
    composition,
    fingerprint: spaFingerprint(input.live || input.preflight || {}),
    acceptedProductionPins: ACCEPTED_PRODUCTION_SPA,
    productionSpaId: PRODUCTION_SPA_ID,
    note: 'SPA promote is plan-only; this workstream does not upload index.html or invalidate CloudFront',
  });
}

export function indexHtmlHash(body) {
  return sha256Text(body);
}

export function commitSpaPromote(_plan, aws) {
  if (!aws || typeof aws.putObject !== 'function') {
    return fail(CODES.AWS_WRITE_FORBIDDEN, 'no AWS adapter supplied; refusing SPA write');
  }
  try {
    aws.putObject();
  } catch (error) {
    return fail(error.code || CODES.AWS_WRITE_FORBIDDEN, error.message);
  }
  return fail(CODES.AWS_WRITE_FORBIDDEN, 'SPA write is not implemented in this safeguard workstream');
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('spa-promote plans a safe frontend promotion. It never uploads or invalidates.');
    return 0;
  }
  console.log(JSON.stringify({
    ok: true,
    message: 'spa-promote is plan-only; invoke planSpaPromote() from preflight',
  }, null, 2));
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
