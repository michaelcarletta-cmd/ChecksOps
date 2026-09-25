/**
 * Local/temp proofs for Phase 1 freeze and cross-build overwrite protection.
 * Never calls AWS, SQL, or UpdateFunctionCode.
 */
import assert from 'node:assert/strict';
import {
  CROSS_BUILD_LABEL,
  PHASE1_FREEZE_LABEL,
  STALE_BASELINE_LABEL,
  TOCTOU_ABORT,
  assertCandidatePreservesPhase1,
  assertCodeOnlyPromotion,
  assertDeployShaUnchanged,
  assertPromotionScriptsRemainCodeOnly,
  planNarrowOverlay,
  refuseProductionOverlayBypass,
  requireCandidateBaselineSha,
} from '../../../scripts/lib/phase1-freeze.mjs';

export const expectFreezeFailure = (label, fn, pattern) => {
  let failed = false;
  let message = '';
  try {
    fn();
  } catch (error) {
    failed = true;
    message = String(error?.message || error);
  }
  assert.equal(failed, true, `${PHASE1_FREEZE_LABEL}: expected FAIL for ${label}`);
  assert.match(message, pattern, `${PHASE1_FREEZE_LABEL}: ${label} must name the protection`);
};

export const mutateDropS2Call = (source) => source.replaceAll(
  'invalidateEndorsementsForMaterialPayeeChange',
  'notTheProtectedInvalidationHelper',
);

export const mutateDropS5Rpc = (source) => source
  .replace("  admin_set_check_claim: 'safe_now',\n", '')
  .replace("  'admin_set_check_claim',\n", '')
  .replace("    case 'admin_set_check_claim':\n      return executeAdminSetCheckClaim({ client, mapping, args });\n", '')
  .replaceAll('executeAdminSetCheckClaim', 'missingAcceptedS5Bridge');

export const mutateDropS11Remaining = (source) => source
  .replaceAll('remaining_cents', 'not_remaining')
  .replaceAll('requested_partial_cents', 'not_partial');

export const mutateDropS14Deposited = (source) => source
  .replaceAll('export const isCheckDeposited', 'export const notIsCheckDeposited')
  .replaceAll('confirmed_provider_deposit', 'not_confirmed')
  .replaceAll('s14_deposit_lookup', 'not_s14_lookup');

export {
  CROSS_BUILD_LABEL,
  PHASE1_FREEZE_LABEL,
  STALE_BASELINE_LABEL,
  TOCTOU_ABORT,
  assertCandidatePreservesPhase1,
  assertCodeOnlyPromotion,
  assertDeployShaUnchanged,
  assertPromotionScriptsRemainCodeOnly,
  planNarrowOverlay,
  refuseProductionOverlayBypass,
  requireCandidateBaselineSha,
};
