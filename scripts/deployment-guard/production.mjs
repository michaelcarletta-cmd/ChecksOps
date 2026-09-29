/**
 * Production is stronger than staging.
 * Never infer approval from a previous workstream.
 */
import { compareCandidate } from '../production-deploy-guard.mjs';
import { CODES, fail, fingerprintsEqual, lambdaFingerprint, ok } from './lib.mjs';
import { spaFingerprint } from './spa-promote.mjs';

export function assertProductionApproval(input = {}) {
  if (input.environment !== 'production') return ok({ required: false });
  const approval = input.approval || input.manifest?.production_approval;
  if (!approval || approval.explicit !== true || !approval.marker) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production deploy requires an explicit approval marker/input');
  }
  if (approval.inferred_from_workstream || approval.inferred === true) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'never infer production approval from a previous workstream', { approval });
  }
  if (input.previousWorkstreamApproval && approval.workstream_id
    && approval.workstream_id !== input.manifest?.workstream_id
    && approval.reused === true) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production approval from another workstream cannot be reused');
  }
  if (approval.workstream_id && input.manifest?.workstream_id && approval.workstream_id !== input.manifest.workstream_id) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production approval workstream_id does not match this workstream');
  }
  if (!input.stagingAcceptance?.successful && !input.manifest?.staging_acceptance?.successful) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production deploy requires a successful staging acceptance reference');
  }
  if (input.compositionAccepted !== true && input.manifest?.deployment_type === 'spa-promote') {
    return fail(CODES.SOURCE_COMPOSITION_REQUIRED, 'production SPA deploy requires accepted source composition');
  }
  const preflight = input.preflightFingerprint || input.manifest?.preflight_live_fingerprint;
  const live = input.liveFingerprint;
  if (!preflight || !live) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'production requires current fingerprint and a second fingerprint immediately before write');
  }
  const pre = preflight.codeSha256 || preflight.index_html_sha256
    ? { ...lambdaFingerprint(preflight), ...spaFingerprint(preflight) }
    : preflight;
  const now = live.codeSha256 || live.index_html_sha256
    ? { ...lambdaFingerprint(live), ...spaFingerprint(live) }
    : live;
  const keys = ['codeSha256', 'revisionId', 'index_html_sha256', 'entry_bundle'].filter((key) => pre[key] != null || now[key] != null);
  if (keys.length && !fingerprintsEqual(pre, now, keys)) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'production changed between fingerprint checks; STOP', {
      preflight: pre,
      live: now,
    });
  }
  if (input.releaseManifest && input.candidate) {
    const errors = compareCandidate(input.releaseManifest, input.candidate);
    if (errors.length) {
      return fail(CODES.DEPLOYMENT_COLLISION, errors[0], { errors });
    }
  }
  return ok({ approval, stagingAcceptance: input.stagingAcceptance || input.manifest?.staging_acceptance });
}
