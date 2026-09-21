/**
 * M7.14 first-test production authorization.
 *
 * Does not flip evaluateFinancialAuthorization().canExecuteProduction.
 * BANK→WALLET requires a fresh wallet.fund step-up.
 * WALLET→RECIPIENT requires a separate fresh wallet.disburse step-up.
 * This phase never consumes, stores, logs, or bypasses a Financial TOTP.
 */
import { evaluateFinancialAuthorization } from '../../financial-authz.mjs';
import { verifyFinancialTotp } from '../../financial-totp.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import {
  MOOV_DISBURSE_TOTP_ACTION,
  MOOV_FUND_TOTP_ACTION,
} from './moov-first-test.mjs';
import { CONSUME_TOTP_THIS_PHASE } from './moov-payout-orchestrator.mjs';

export const PRODUCTION_PENNY_FUND_ACTION = MOOV_FUND_TOTP_ACTION;
export const PRODUCTION_PENNY_DISBURSE_ACTION = MOOV_DISBURSE_TOTP_ACTION;
export const SEPARATE_FRESH_STEP_UPS_REQUIRED = true;
export const REQUIRE_TOTP_FALSE_PRODUCTION_PATH = false;

const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;

const failTotp = (error, extra = {}) => ({
  ok: false,
  error,
  consumed: false,
  present: false,
  valid: false,
  ...extra,
});

export const assertNoTotpMaterial = (payload, code, secret) => {
  const blob = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (code && blob.includes(String(code))) throw new Error('totp_code_logged');
  if (secret && blob.includes(String(secret))) throw new Error('totp_secret_logged');
};

/**
 * Verify a presented Financial TOTP without consuming it.
 * Production e2e never supplies a live secret. Tests pass a synthetic secret.
 */
export const verifyProductionPennyTotp = ({
  action,
  code = null,
  secret = null,
  nowMs = Date.now(),
  lastUsedTimestep = null,
} = {}) => {
  if (action !== PRODUCTION_PENNY_FUND_ACTION && action !== PRODUCTION_PENNY_DISBURSE_ACTION) {
    return failTotp('unsupported_financial_action', { action: action || null });
  }
  if (CONSUME_TOTP_THIS_PHASE === true) {
    return failTotp('consume_totp_not_this_phase', { action });
  }
  if (!code) return failTotp('totp_required', { action });
  if (!secret) return failTotp('totp_secret_not_loaded', { action, message: 'Cursor must not retrieve a Financial TOTP secret.' });
  const verified = verifyFinancialTotp({ secret, code, nowMs, lastUsedTimestep });
  if (!verified.ok) {
    return failTotp(verified.error || 'totp_mismatch', { action });
  }
  return {
    ok: true,
    action,
    present: true,
    valid: true,
    consumed: false,
    timestep: verified.timestep,
  };
};

export const evaluateProductionPennyAuthorization = ({
  operation,
  tenantId,
  environment,
  identityOk = false,
  membershipOk = false,
  roles = [],
  totpPresent = false,
  totpValid = false,
} = {}) => {
  const general = evaluateFinancialAuthorization({
    operation,
    identityOk,
    membershipOk,
    roles,
    permissionsActivated: true,
  });
  const freedom = String(tenantId || '') === FREEDOM;
  const production = String(environment || '') === 'production';
  const actionOk = operation === 'wallet_fund' || operation === 'wallet_disburse';
  const totpOk = totpPresent === true && totpValid === true;
  const firstTestLegAuthorized = Boolean(
    identityOk
    && membershipOk
    && general.roleOk
    && freedom
    && production
    && actionOk
    && totpOk,
  );
  return {
    canExecuteProduction: false,
    activated: false,
    consumeTotpThisPhase: CONSUME_TOTP_THIS_PHASE === true,
    firstTestLegAuthorized,
    canPostThisPhase: false,
    separateFreshStepUpsRequired: SEPARATE_FRESH_STEP_UPS_REQUIRED,
    requireTotpFalseProductionPath: REQUIRE_TOTP_FALSE_PRODUCTION_PATH,
    fundAction: PRODUCTION_PENNY_FUND_ACTION,
    disburseAction: PRODUCTION_PENNY_DISBURSE_ACTION,
    identityOk: Boolean(identityOk),
    membershipOk: Boolean(membershipOk),
    roleOk: general.roleOk,
    freedomTenant: freedom,
    productionEnvironment: production,
    totpPresent: totpPresent === true,
    totpValid: totpValid === true,
    totpConsumed: false,
    generalCanExecuteProduction: general.canExecuteProduction,
  };
};

export const evaluateProductionPennySweepRace = ({
  fundingState = null,
  liveAvailableCents = 0,
  payoutCents = 1,
  mayCreateSecondFunding = false,
} = {}) => {
  const live = Number(liveAvailableCents);
  const payout = Number(payoutCents);
  const fundingCompleted = String(fundingState || '') === 'funding_completed';
  const walletCovers = Number.isFinite(live) && live >= payout;
  if (fundingCompleted && !walletCovers) {
    return {
      payout_ready: false,
      may_create_second_funding: false,
      reason: 'funding_completed_wallet_unavailable',
      expected: 'Sweep or ACH availability can empty the wallet after funding completes. Re-read live available. Do not POST a second BANK→WALLET for this operation.',
      double_fund_protection: mayCreateSecondFunding !== true,
    };
  }
  if (fundingCompleted && walletCovers) {
    return {
      payout_ready: true,
      may_create_second_funding: false,
      reason: 'funding_completed_wallet_available',
      expected: 'Release WALLET→RECIPIENT only after a fresh wallet.disburse step-up. Sweep remains independent.',
      double_fund_protection: true,
    };
  }
  return {
    payout_ready: false,
    may_create_second_funding: false,
    reason: fundingCompleted ? 'wallet_check' : 'funding_not_completed',
    expected: 'Authoritative funding is one ChecksOps BANK→WALLET exact shortfall. Sweep is observe-only.',
    double_fund_protection: mayCreateSecondFunding !== true,
  };
};

export const evaluateOneAuthorizedLegPost = ({
  productionPostFlag = false,
  sandboxPostFlag = false,
  requestedLeg = null,
  totpAction = null,
  totpPresent = false,
  totpValid = false,
  persistDone = false,
  orchestratorAllows = false,
  previousLegPostedThisWindow = false,
  consumeTotpThisPhase = CONSUME_TOTP_THIS_PHASE,
} = {}) => {
  const expectedAction = requestedLeg === 'payout'
    ? PRODUCTION_PENNY_DISBURSE_ACTION
    : (requestedLeg === 'funding' ? PRODUCTION_PENNY_FUND_ACTION : null);
  if (sandboxPostFlag === true) {
    return { arm: false, error: 'sandbox_post_flag_must_stay_false', disarmImmediately: true };
  }
  if (productionPostFlag !== true) {
    return { arm: false, reason: 'production_post_flag_false', disarmImmediately: true };
  }
  if (consumeTotpThisPhase !== true) {
    return { arm: false, reason: 'totp_not_consumed_this_phase', disarmImmediately: true };
  }
  if (previousLegPostedThisWindow === true) {
    return { arm: false, reason: 'one_leg_already_posted_disarm', disarmImmediately: true };
  }
  if (totpAction !== expectedAction || totpPresent !== true || totpValid !== true) {
    return { arm: false, reason: 'fresh_step_up_required', expectedAction, disarmImmediately: true };
  }
  if (persistDone !== true) {
    return { arm: false, reason: 'durable_intent_required_before_post', disarmImmediately: true };
  }
  if (orchestratorAllows !== true) {
    return { arm: false, reason: 'orchestrator_does_not_allow_post', disarmImmediately: true };
  }
  return {
    arm: true,
    requestedLeg,
    totpAction: expectedAction,
    disarmImmediately: true,
    neverArmedWhileWaitingForAch: true,
  };
};
