/**
 * Production BANK→WALLET / WALLET→RECIPIENT provider primitives.
 *
 * Contained by executeProductionPayoutE2e. Not an independent business flow.
 * Live zip MUST_KEEP moov-wallet-fund.mjs / moov-wallet-disburse.mjs must not
 * orchestrate. This module never overlays those filenames.
 *
 * POST is unreachable while CONSUME_TOTP_THIS_PHASE is false or the production
 * transfer POST flag is false.
 */
import { formatMoovTransferAmount } from '../amounts.mjs';
import { assertNoCrossEnvironmentObject, isKnownProductionMoovObject } from '../moov-environment.mjs';
import { idempotencyUuid } from '../moov-sandbox.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import {
  FIRST_PRODUCTION_TRANSFER_CENTS,
  firstTestDisburseBinding,
  firstTestFundBinding,
} from './moov-first-test.mjs';
import { CONSUME_TOTP_THIS_PHASE } from './moov-payout-orchestrator.mjs';
import { evaluateOneAuthorizedLegPost } from './moov-production-penny-authz.mjs';

export const PIPELINE_TEST_TENANT_ID = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
export const PIPELINE_TEST_SANDBOX = Object.freeze({
  tenantId: PIPELINE_TEST_TENANT_ID,
  platformAccountId: '36b79957-ce7a-4ca7-a68f-30986c9e47bb',
  accountId: '1d59a6a8-3307-4687-8367-1495293ecc73',
  walletId: '58571121-67ea-4e10-abae-6c9680ac455d',
  bankId: '8390f74b-706e-4d89-80b0-f96bd7c1b414',
  achDebitFundPm: '8a0f6ffa-a549-48f5-bb8e-f5b6a9d9cfff',
  walletPm: '1eb24c1c-b7ab-45cd-8775-332da40b9647',
  recipientAccountId: '90050a69-84f3-41bb-aa30-490ca7e7bf34',
  recipientBankId: '92e17650-94ed-43cb-8bff-14cf506c3988',
});

export const M714_PHASE = 'M7.14';
export const PRODUCTION_FUNDING_DESCRIPTION = 'M7.14 production BANK to WALLET 0.01';
export const PRODUCTION_PAYOUT_DESCRIPTION = 'M7.14 production WALLET to RECIPIENT 0.01';
export const MUST_KEEP_FUND_REL = 'providers/production/moov-wallet-fund.mjs';
export const MUST_KEEP_DISBURSE_REL = 'providers/production/moov-wallet-disburse.mjs';
export const INDEPENDENT_MUST_KEEP_BLOCKED = 'independent_must_keep_writer_blocked';

const FREEDOM = KNOWN_APPROVED_MOOV.freedom;
const PLATFORM = KNOWN_APPROVED_MOOV.platform;
const SANDBOX_IDS = new Set(Object.values(PIPELINE_TEST_SANDBOX).map((id) => String(id).toLowerCase()));

const lower = (value) => String(value || '').trim().toLowerCase();
const sameId = (left, right) => Boolean(left) && lower(left) === lower(right);

const fail = (error, extra = {}) => ({
  ok: false,
  error,
  environment: 'production',
  liveProviderCalled: false,
  liveProviderPosted: false,
  transfer_post_held: extra.transfer_post_held === true,
  phase: M714_PHASE,
  ...extra,
});

const UNKNOWN_POST_OUTCOMES = new Set([
  'unknown',
  'unknown_no_retry',
  'timeout',
  'provider_post_unknown',
  'conflict',
]);

export const refuseIndependentMustKeepInvocation = (functionName) => fail(
  INDEPENDENT_MUST_KEEP_BLOCKED,
  {
    statusCode: 403,
    functionName: functionName || null,
    message: 'MUST_KEEP fund/disburse writers cannot orchestrate. Use executeProductionPayoutE2e.',
  },
);

export const productionProviderIdempotency = (businessKey) => idempotencyUuid(businessKey);

export const buildProductionTransferBody = ({
  sourcePaymentMethodId,
  destinationPaymentMethodId,
  amountCents = FIRST_PRODUCTION_TRANSFER_CENTS,
  description,
} = {}) => {
  const formatted = formatMoovTransferAmount(amountCents);
  if (formatted.error) return formatted;
  return {
    source: { paymentMethodID: sourcePaymentMethodId },
    destination: { paymentMethodID: destinationPaymentMethodId },
    amount: formatted.amount,
    description,
  };
};

export const productionFacilitatorTransferPath = (platformAccountId = PLATFORM.moovAccountId) => (
  `/accounts/${platformAccountId}/transfers`
);

export const assertProductionPrimitiveCredentials = ({
  credentials,
  sandboxPublicKey = null,
  sandboxSecretKey = null,
} = {}) => {
  if (!credentials) return fail('production_credentials_required', { statusCode: 409 });
  if (credentials.environment !== 'production') {
    return fail('sandbox_credentials_refused', { statusCode: 403 });
  }
  if (sandboxPublicKey && credentials.publicKey === sandboxPublicKey) {
    return fail('sandbox_credentials_refused', { statusCode: 403 });
  }
  if (sandboxSecretKey && credentials.secretKey === sandboxSecretKey) {
    return fail('sandbox_credentials_refused', { statusCode: 403 });
  }
  return { ok: true, environment: 'production' };
};

const collectIds = (binding = {}) => [
  binding.accountId,
  binding.platformAccountId,
  binding.bankId,
  binding.walletId,
  binding.sourcePaymentMethodId,
  binding.destinationPaymentMethodId,
  binding.recipientId,
  binding.recipientBankId,
].filter(Boolean).map((id) => String(id));

export const assertProductionPrimitiveBinding = (binding, leg) => {
  if (!binding) return fail('binding_required', { statusCode: 400 });
  const ids = collectIds(binding);
  const sandboxHit = ids.find((id) => SANDBOX_IDS.has(lower(id)));
  if (sandboxHit) {
    return fail('sandbox_ids_blocked', { statusCode: 409, hits: [sandboxHit] });
  }
  const spoof = assertNoCrossEnvironmentObject({
    environment: 'production',
    accountId: binding.accountId || FREEDOM.moovAccountId,
    walletId: binding.walletId,
    bankId: binding.bankId,
    paymentMethodIds: [binding.sourcePaymentMethodId, binding.destinationPaymentMethodId].filter(Boolean),
  });
  if (spoof?.ok === false) return fail(spoof.error || 'cross_environment_object', { statusCode: 409, ...spoof });
  if (Number(binding.amountCents || FIRST_PRODUCTION_TRANSFER_CENTS) !== FIRST_PRODUCTION_TRANSFER_CENTS) {
    return fail('amount_not_one_cent', { statusCode: 409, amountCents: binding.amountCents });
  }
  const expected = leg === 'payout' ? firstTestDisburseBinding() : firstTestFundBinding();
  if (leg === 'funding') {
    if (!sameId(binding.sourcePaymentMethodId, expected.sourcePaymentMethodId)) {
      return fail('funding_pm_mismatch', { statusCode: 409 });
    }
    if (!sameId(binding.destinationPaymentMethodId, expected.destinationPaymentMethodId)) {
      return fail('wallet_pm_mismatch', { statusCode: 409 });
    }
  }
  if (leg === 'payout') {
    if (!sameId(binding.sourcePaymentMethodId, expected.sourcePaymentMethodId)) {
      return fail('wallet_pm_mismatch', { statusCode: 409 });
    }
    if (!sameId(binding.destinationPaymentMethodId, expected.destinationPaymentMethodId)) {
      return fail('recipient_pm_mismatch', { statusCode: 409 });
    }
  }
  if (!isKnownProductionMoovObject(FREEDOM.moovAccountId)) {
    return fail('production_account_unknown', { statusCode: 409 });
  }
  return { ok: true, environment: 'production' };
};

export const productionRetryClassification = (intent = {}) => {
  if (intent?.provider_transfer_id) {
    return { retryable: false, reason: 'provider_object_exists', classification: 'already_posted' };
  }
  const meta = intent?.provider_metadata && typeof intent.provider_metadata === 'object'
    ? intent.provider_metadata
    : {};
  const attempted = meta.post_attempted === true;
  if (!attempted) {
    return { retryable: false, reason: 'not_attempted', classification: 'not_attempted' };
  }
  const outcome = String(meta.post_outcome || '').toLowerCase();
  const status = String(intent.status || '').toLowerCase();
  if (UNKNOWN_POST_OUTCOMES.has(outcome) || status === 'unknown') {
    return { retryable: false, reason: 'unknown_or_timeout', classification: 'unknown_no_retry' };
  }
  if (outcome === 'failed' || status === 'failed') {
    return { retryable: false, reason: 'classified_failed_no_blind_retry', classification: 'failed_no_blind_retry' };
  }
  return { retryable: false, reason: 'unknown_or_timeout', classification: 'unknown_no_retry' };
};

export const persistProductionIntentCas = async (store, planned) => {
  if (!planned?.idempotency_key) return fail('idempotency_required', { statusCode: 409 });
  if (!store) {
    return { ok: true, reused: false, created: false, persisted: false, intent: planned, cas: 'no_store' };
  }
  const existing = await store.getIntent(planned.idempotency_key);
  if (existing) {
    return { ok: true, reused: true, created: false, persisted: true, intent: { ...planned, ...existing }, cas: 'reuse' };
  }
  const saved = await store.putIntent(planned);
  return {
    ok: true,
    reused: saved.reused === true,
    created: saved.reused !== true,
    persisted: true,
    intent: saved.intent,
    cas: saved.reused === true ? 'reuse' : 'insert',
  };
};

const executeLeg = async ({
  leg,
  credentials,
  sandboxPublicKey = null,
  sandboxSecretKey = null,
  binding,
  intent = null,
  transferPostEnabled = false,
  sandboxTransferPostEnabled = false,
  persistDone = false,
  orchestratorAllows = false,
  totpPresent = false,
  totpValid = false,
  independentInvocation = false,
  fetchImpl = fetch,
} = {}) => {
  if (independentInvocation === true) {
    return refuseIndependentMustKeepInvocation(leg === 'payout' ? 'moov-wallet-disburse' : 'moov-wallet-fund');
  }
  if (credentials || transferPostEnabled === true) {
    const creds = assertProductionPrimitiveCredentials({ credentials, sandboxPublicKey, sandboxSecretKey });
    if (!creds.ok) return creds;
  }
  const bound = assertProductionPrimitiveBinding(binding, leg);
  if (!bound.ok) return bound;
  const current = intent || {};
  const retry = productionRetryClassification(current);
  const businessKey = current.idempotency_key || binding.idempotencyKey;
  const providerIdempotencyKey = current.provider_idempotency_key
    || current.provider_metadata?.provider_idempotency_key
    || (businessKey ? productionProviderIdempotency(businessKey) : null);
  const postPath = productionFacilitatorTransferPath(binding.platformAccountId || PLATFORM.moovAccountId);
  const description = leg === 'payout' ? PRODUCTION_PAYOUT_DESCRIPTION : PRODUCTION_FUNDING_DESCRIPTION;
  const body = buildProductionTransferBody({
    sourcePaymentMethodId: binding.sourcePaymentMethodId,
    destinationPaymentMethodId: binding.destinationPaymentMethodId,
    amountCents: FIRST_PRODUCTION_TRANSFER_CENTS,
    description,
  });
  const heldBase = {
    ok: true,
    environment: 'production',
    phase: M714_PHASE,
    leg,
    outcome: 'transfer_post_held',
    transfer_post_held: true,
    liveProviderCalled: false,
    liveProviderPosted: false,
    intent: current,
    amount_cents: FIRST_PRODUCTION_TRANSFER_CENTS,
    post_account_path: postPath,
    provider_idempotency_key: providerIdempotencyKey,
    retry_classification: retry.classification,
    request_body: body.error ? null : body,
    independent_writer_blocked: true,
  };
  if (current.provider_transfer_id) {
    return {
      ...heldBase,
      outcome: 'already_posted',
      transfer_post_held: false,
      reusedProviderTransfer: true,
      provider_transfer_id: current.provider_transfer_id,
      doNotRetry: true,
    };
  }
  if (retry.classification === 'unknown_no_retry') {
    return {
      ...heldBase,
      outcome: 'unknown_no_retry',
      transfer_post_held: false,
      doNotRetry: true,
      message: 'Prior POST attempt is unknown. Reconcile GET-only. Do not retry.',
    };
  }
  const arm = evaluateOneAuthorizedLegPost({
    productionPostFlag: transferPostEnabled === true,
    sandboxPostFlag: sandboxTransferPostEnabled === true,
    requestedLeg: leg === 'payout' ? 'payout' : 'funding',
    totpAction: leg === 'payout' ? 'wallet.disburse' : 'wallet.fund',
    totpPresent,
    totpValid,
    persistDone,
    orchestratorAllows,
    previousLegPostedThisWindow: false,
  });
  if (arm.arm !== true) {
    return { ...heldBase, arm, consume_totp_this_phase: CONSUME_TOTP_THIS_PHASE === true };
  }
  if (typeof fetchImpl !== 'function') {
    return fail('fetch_required_for_execute', { statusCode: 500 });
  }
  return fail('production_post_unreachable_this_phase', {
    statusCode: 403,
    message: 'M7.14 never POSTs. CONSUME_TOTP_THIS_PHASE is false.',
  });
};

export const executeProductionWalletFunding = (args = {}) => executeLeg({ ...args, leg: 'funding' });
export const executeProductionWalletDisbursement = (args = {}) => executeLeg({ ...args, leg: 'payout' });
