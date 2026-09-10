/**
 * Dark-safe CheckAlt deposit preflight. No provider HTTP. No money movement.
 * Does not require AWS_CHECKALT_ENABLED or financial permission lifts.
 */
import { membershipForTenant } from '../../financial-ownership.mjs';
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import {
  CHECK_ELIGIBILITY_SELECT,
  ERROR_CHECKALT_IMAGE_NONCOMPLIANT,
  ERROR_ENDORSEMENT_MISSING,
  ERROR_ENDORSEMENT_RELATIONSHIP_INVALID,
  ERROR_ENDORSEMENT_STATE_AMBIGUOUS,
  ERROR_ENDORSEMENTS_INCOMPLETE,
  ERROR_PROVIDER_FRONT_IMAGE_MISSING,
  ERROR_PROVIDER_REAR_IMAGE_MISSING,
  ERROR_PROVIDER_REAR_IMAGE_STALE,
  evaluateEndorsementEligibility,
  evaluateOfficialImagePaths,
  evaluateRearImageFreshness,
  loadCheckEndorsements,
  loadCheckPayees,
  mapCheckAltImageGateError,
} from './checkalt-eligibility.mjs';
import { loadDepositsForCheck, pickBlockingDeposit } from './checkalt-idempotency.mjs';
import { loadProductionDepositImages } from './checkalt-images.mjs';

export const CHECKALT_DEPOSIT_PREFLIGHT = 'checkalt-deposit-preflight';

const USER_MESSAGES = {
  [ERROR_ENDORSEMENTS_INCOMPLETE]: 'Endorsement is incomplete. A required payee has not signed.',
  [ERROR_ENDORSEMENT_MISSING]: 'Endorsement is missing for a required payee.',
  [ERROR_ENDORSEMENT_RELATIONSHIP_INVALID]: 'This check cannot be deposited because the payee or endorsement does not match.',
  [ERROR_ENDORSEMENT_STATE_AMBIGUOUS]: 'Endorsement records are ambiguous. An administrator must review this check.',
  [ERROR_PROVIDER_FRONT_IMAGE_MISSING]: 'Check image preparation failed. Please retake the front image.',
  [ERROR_PROVIDER_REAR_IMAGE_MISSING]: 'Check image preparation failed. Please retake the back image.',
  [ERROR_PROVIDER_REAR_IMAGE_STALE]: 'The back image is out of date with current endorsements.',
  [ERROR_CHECKALT_IMAGE_NONCOMPLIANT]: 'Check image preparation failed. Please retake the front or back image.',
};

const attentionSide = (error, reason) => {
  if (error === ERROR_PROVIDER_FRONT_IMAGE_MISSING || /front/i.test(String(reason || ''))) return 'front';
  if (
    error === ERROR_PROVIDER_REAR_IMAGE_MISSING
    || error === ERROR_PROVIDER_REAR_IMAGE_STALE
    || /rear|back/i.test(String(reason || ''))
  ) return 'back';
  if (String(error || '').startsWith('endorsement')) return 'endorsement';
  return null;
};

export const userMessageForPreflight = (error) => (
  USER_MESSAGES[error] || 'This check is not ready to deposit.'
);

export async function evaluateCheckAltDepositPreflight({
  client,
  mapping,
  checkId,
  spoof,
  deps = {},
}) {
  const fail = (error, extra = {}) => ({
    ok: false,
    statusCode: extra.statusCode || 403,
    error,
    readyForVerification: false,
    needFrontPrep: extra.needFrontPrep === true,
    needRearPrep: extra.needRearPrep === true,
    historicalReference: extra.historicalReference === true,
    attention: extra.attention || attentionSide(error, extra.reason),
    message: extra.message || userMessageForPreflight(error),
    reason: extra.reason || null,
    liveProviderCalled: false,
    productionExecution: false,
    providerHttpAttempted: false,
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
  });

  if (!checkId) {
    return fail('check_intake_item_id is required', { statusCode: 400, attention: null });
  }

  const check = (await client.query(
    `SELECT ${CHECK_ELIGIBILITY_SELECT} FROM public.check_intake_items WHERE id = $1::uuid`,
    [checkId],
  )).rows[0];
  if (!check) return fail('Check not found', { statusCode: 404, attention: null });

  const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
  if (!membershipForTenant(memberships, check.tenant_id)) {
    return fail('cross_tenant_denied', {
      statusCode: 403,
      message: 'This check is not in your tenant.',
      attention: null,
    });
  }

  const existingForCheck = await loadDepositsForCheck(client, {
    tenantId: check.tenant_id,
    checkId: check.id,
  });
  const blocking = pickBlockingDeposit(existingForCheck);
  if (blocking?.checkalt_reference) {
    return {
      ok: true,
      statusCode: 200,
      readyForVerification: true,
      needFrontPrep: false,
      needRearPrep: false,
      historicalReference: true,
      attention: null,
      message: 'An existing deposit for this check will be reused. A second provider submission will not be sent.',
      liveProviderCalled: false,
      productionExecution: false,
      providerHttpAttempted: false,
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }

  const payees = await loadCheckPayees(client, check.id, check.tenant_id);
  const endorsements = await loadCheckEndorsements(client, check.id, check.tenant_id);
  const endorsement = evaluateEndorsementEligibility(check, payees, endorsements);
  if (!endorsement.ok) {
    return fail(endorsement.error, {
      reason: endorsement.reason,
      statusCode: 403,
    });
  }

  const paths = evaluateOfficialImagePaths(check);
  const freshness = evaluateRearImageFreshness(check, payees, endorsements);

  let images = { ok: false, error: ERROR_CHECKALT_IMAGE_NONCOMPLIANT, reason: 'official_images_unavailable' };
  if (paths.ok) {
    try {
      images = await loadProductionDepositImages(check, {}, deps);
    } catch {
      images = {
        ok: false,
        error: ERROR_CHECKALT_IMAGE_NONCOMPLIANT,
        reason: 'official_images_unavailable',
      };
    }
  }

  const mapped = images.ok ? null : mapCheckAltImageGateError(images);
  const imagesNeedPrep = paths.ok && !images.ok;
  const needFrontPrep = (!paths.ok && paths.error === ERROR_PROVIDER_FRONT_IMAGE_MISSING)
    || imagesNeedPrep;
  const needRearPrep = (!paths.ok && paths.error === ERROR_PROVIDER_REAR_IMAGE_MISSING)
    || !freshness.ok
    || imagesNeedPrep;

  if (!paths.ok || !freshness.ok || !images.ok) {
    const error = !paths.ok
      ? paths.error
      : !images.ok
        ? (mapped?.error || ERROR_CHECKALT_IMAGE_NONCOMPLIANT)
        : freshness.error;
    const reason = !paths.ok
      ? paths.reason
      : !images.ok
        ? (mapped?.reason || images.reason)
        : freshness.reason;
    return fail(error, {
      reason,
      needFrontPrep,
      needRearPrep,
      statusCode: 409,
    });
  }

  return {
    ok: true,
    statusCode: 200,
    readyForVerification: true,
    needFrontPrep: false,
    needRearPrep: false,
    historicalReference: false,
    attention: null,
    message: 'Check is ready for deposit verification.',
    liveProviderCalled: false,
    productionExecution: false,
    providerHttpAttempted: false,
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
  };
}

export const handleCheckAltDepositPreflight = async (event, deps = {}) => {
  const { withIdentity } = await import('../../data.mjs');
  return withIdentity(event, async ({ client, mapping, body, spoof }) => {
    const checkId = body.check_intake_item_id || body.checkId || body.check_id || null;
    return evaluateCheckAltDepositPreflight({
      client,
      mapping,
      checkId,
      spoof,
      deps,
    });
  }, deps);
};
