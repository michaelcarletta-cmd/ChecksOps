import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { evaluateDistFreshness } from './packages.mjs';
import { validateWorkstreamIdentity } from './identity.mjs';
import {
  evaluateAcceptedSourceComposition,
  evaluateSourceComposition,
} from './source-composition.mjs';

export { evaluateSourceComposition };

export function evaluateIndexToctou({ preflight, immediatelyBefore }) {
  const errors = [];
  if (!preflight?.index_html_sha256 || !immediatelyBefore?.index_html_sha256) {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'SPA promote requires current and immediately-before index.html fingerprints'));
    return failMany(errors, CODES.DEPLOYMENT_COLLISION);
  }
  if (preflight.index_html_sha256 !== immediatelyBefore.index_html_sha256) {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'live index.html changed after preflight; stop and never put the old index.html back', {
      preflight_index_html_sha256: preflight.index_html_sha256,
      live_index_html_sha256: immediatelyBefore.index_html_sha256,
    }));
  }
  if (preflight.entry_bundle && immediatelyBefore.entry_bundle && preflight.entry_bundle !== immediatelyBefore.entry_bundle) {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'live entry bundle changed after preflight', {
      preflight_entry_bundle: preflight.entry_bundle,
      live_entry_bundle: immediatelyBefore.entry_bundle,
    }));
  }
  if (errors.length) return failMany(errors, CODES.DEPLOYMENT_COLLISION);
  return ok({ index_html_sha256: immediatelyBefore.index_html_sha256 });
}

export function evaluateSpaPromote(input = {}) {
  const identity = validateWorkstreamIdentity({
    workstream_id: input.workstream_id,
    branch: input.branch,
    commit: input.commit,
    operator: input.operator,
    target_environment: input.target_environment,
    deployment_type: input.deployment_type || 'spa-promote',
    owned_components: input.owned_components || ['index.html'],
    preflight_live_fingerprint: input.preflight || input.preflight_live_fingerprint,
    build_timestamp: input.build_timestamp,
  });
  if (!identity.ok) return identity;

  const dist = evaluateDistFreshness(input.dist || { clean_build: input.clean_build });
  if (!dist.ok) return dist;

  if (!input.preflight?.index_html_sha256 || !input.preflight?.entry_bundle) {
    return failMany([errorEntry(CODES.INVALID_MANIFEST, 'SPA preflight must record current index.html fingerprint and entry bundle')], CODES.INVALID_MANIFEST);
  }
  if (!input.source_composition_manifest) {
    return failMany([errorEntry(CODES.INVALID_MANIFEST, 'SPA promote requires a source composition manifest')], CODES.INVALID_MANIFEST);
  }

  const composition = input.composition_registry
    ? evaluateAcceptedSourceComposition({
      registry: input.composition_registry,
      deployment_type: 'spa-promote',
      composition_manifest: input.source_composition_manifest,
      accepted_composition: input.accepted_composition === true,
      frontend_workstreams: input.frontend_workstreams || [],
    })
    : evaluateSourceComposition({
      frontend_workstreams: input.frontend_workstreams || [],
      accepted_composition: input.accepted_composition === true,
      composition_manifest: input.source_composition_manifest,
    });
  if (!composition.ok) return composition;

  if (!input.immediately_before) {
    return failMany([errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      'mutation-boundary index fingerprint (immediately_before) is required; preflight alone is not sufficient',
    )], CODES.DEPLOYMENT_COLLISION);
  }
  const toctou = evaluateIndexToctou({
    preflight: input.preflight,
    immediatelyBefore: input.immediately_before,
  });
  if (!toctou.ok) return toctou;

  if (input.restore_previous_index === true || input.reclaim_staging === true) {
    return failMany([errorEntry(CODES.STALE_PACKAGE, 'never reclaim staging or restore a previous index.html/dist')], CODES.STALE_PACKAGE);
  }

  return ok({
    spa_promote_allowed: true,
    index_html_sha256: toctou.details.index_html_sha256,
    entry_bundle: input.preflight.entry_bundle,
    composition: composition.details,
    reclaim_forbidden: true,
  });
}
