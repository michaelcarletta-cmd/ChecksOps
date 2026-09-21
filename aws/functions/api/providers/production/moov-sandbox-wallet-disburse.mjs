/**
 * M7.10 sandbox WALLET→RECIPIENT writer.
 *
 * Server authority: Pipeline Test tenant → moov_environment=sandbox →
 * sandbox wallet PM → sandbox recipient ACH-credit PM.
 * Browser IDs are never authority. Production credentials and production
 * Moov IDs are refused. Transfer POST is gated only by the sandbox Lambda
 * flag passed in as transferPostEnabled. Timeout/unknown is never retried.
 * This module never POSTs BANK→WALLET and never uses production POST.
 */
import { assertNoCrossEnvironmentObject, isKnownProductionMoovObject } from '../moov-environment.mjs';
import {
  assertMoovSandboxCredentials,
  buildMoovSandboxTransferBody,
  collectMoovTransferIds,
  idempotencyUuid,
  moovSandboxFetch,
  moovSandboxScopes,
  normalizeMoovSandboxTransfer,
} from '../moov-sandbox.mjs';
import { FIRST_PRODUCTION_TRANSFER_CENTS } from './moov-first-test.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import { PIPELINE_TEST_SANDBOX, PIPELINE_TEST_TENANT_ID } from './moov-sandbox-wallet-fund.mjs';

export const M710_PHASE = 'M7.10';
export const SANDBOX_PAYOUT_OPERATION = 'sandbox_wallet_to_recipient';
export const SANDBOX_PAYOUT_LEG = 'wallet_disbursement';
export const SANDBOX_PAYOUT_AMOUNT_CENTS = FIRST_PRODUCTION_TRANSFER_CENTS;
export const SANDBOX_PAYOUT_DESCRIPTION = 'M7.10 sandbox WALLET to RECIPIENT 0.01';
export const SANDBOX_RECIPIENT_ACCOUNT_ID = PIPELINE_TEST_SANDBOX.recipientAccountId;
export const SANDBOX_RECIPIENT_BANK_ID = PIPELINE_TEST_SANDBOX.recipientBankId;

export const sandboxWalletDisbursementIdempotencyKey = ({
  tenantId,
  environment = 'sandbox',
  operation = SANDBOX_PAYOUT_OPERATION,
  leg = SANDBOX_PAYOUT_LEG,
  amountCents = SANDBOX_PAYOUT_AMOUNT_CENTS,
} = {}) => (
  `checksops:m710:${operation}:env:${environment}:tenant:${tenantId}:leg:${leg}:cents:${Number(amountCents)}`
);

export const SANDBOX_PAYOUT_PROVIDER_UUID = idempotencyUuid(
  sandboxWalletDisbursementIdempotencyKey({ tenantId: PIPELINE_TEST_TENANT_ID }),
);

export const sandboxFacilitatorPayoutPath = (platformAccountId) => (
  `/accounts/${platformAccountId}/transfers`
);

export const sandboxFacilitatorPayoutContract = (binding) => {
  const body = buildMoovSandboxTransferBody({
    sourcePaymentMethodId: binding.sourcePaymentMethodId,
    destinationPaymentMethodId: binding.destinationPaymentMethodId,
    amountCents: binding.amountCents || SANDBOX_PAYOUT_AMOUNT_CENTS,
    description: SANDBOX_PAYOUT_DESCRIPTION,
  });
  return {
    endpoint: sandboxFacilitatorPayoutPath(binding.platformAccountId),
    method: 'POST',
    apiVersion: 'v2024.01.00',
    scopes: moovSandboxScopes.transfersWrite(binding.platformAccountId),
    sourceAccount: binding.accountId,
    destinationAccount: binding.recipientAccountId,
    sourcePaymentMethodId: binding.sourcePaymentMethodId,
    destinationPaymentMethodId: binding.destinationPaymentMethodId,
    amount: body.amount,
    description: body.description,
    facilitatorAccountIdInPath: true,
    platformAccountId: binding.platformAccountId,
    facilitatorFee: null,
    metadata: null,
    transferOptions: null,
  };
};

const lower = (value) => String(value || '').trim().toLowerCase();
const sameId = (left, right) => Boolean(left) && lower(left) === lower(right);
const pmTypeOf = (row) => lower(row?.type || row?.paymentMethodType);
const pmIdOf = (row) => row?.id || row?.paymentMethodID || row?.paymentMethodId || null;
const bankIdOf = (row) => row?.id || row?.bankAccountID || row?.bankAccountId || row?.provider_bank_account_id || null;
const walletIdOf = (row) => row?.id || row?.walletID || row?.walletId || row?.provider_wallet_id || null;
const accountIdOf = (row) => row?.provider_account_id || row?.accountID || row?.accountId || row?.id || null;

const fail = (error, extra = {}) => ({
  ok: false,
  error,
  environment: 'sandbox',
  liveProviderCalled: false,
  liveProviderPosted: false,
  transfer_post_held: extra.transfer_post_held === true,
  ...extra,
});

const claimed = (body = {}, keys = []) => {
  for (const key of keys) {
    if (body?.[key] !== undefined && body?.[key] !== null && body?.[key] !== '') {
      return body[key];
    }
  }
  return null;
};

const collectHintIds = (hints = {}) => [
  claimed(hints, ['accountId', 'account_id', 'providerAccountId']),
  claimed(hints, ['walletId', 'wallet_id']),
  claimed(hints, ['recipientAccountId', 'recipient_account_id']),
  claimed(hints, ['recipientBankId', 'recipient_bank_id', 'bankId']),
  claimed(hints, ['sourcePaymentMethodId', 'source_payment_method_id']),
  claimed(hints, ['destinationPaymentMethodId', 'destination_payment_method_id', 'recipientPaymentMethodId']),
].filter(Boolean);

export const assertSandboxPayoutCredentials = ({ credentials, productionPublicKey = null, productionSecretKey = null } = {}) => {
  const gate = assertMoovSandboxCredentials(credentials);
  if (!gate.ok) {
    return { ...gate, liveProviderCalled: false, liveProviderPosted: false, environment: 'sandbox' };
  }
  if (productionPublicKey && credentials.publicKey === productionPublicKey) {
    return fail('production_credentials_refused', {
      statusCode: 403,
      message: 'Sandbox payout writer refuses production Moov public key.',
    });
  }
  if (productionSecretKey && credentials.secretKey === productionSecretKey) {
    return fail('production_credentials_refused', {
      statusCode: 403,
      message: 'Sandbox payout writer refuses production Moov secret key.',
    });
  }
  return { ok: true, environment: 'sandbox', productionCredentialsImpossible: true };
};

const isAchCredit = (row) => {
  const type = pmTypeOf(row);
  return type.includes('ach-credit') || (type.includes('ach') && type.includes('credit'));
};

const capabilityEnabled = (caps = [], name) => (caps || []).some((row) => {
  const id = lower(row?.capability || row?.capabilityID || row?.id);
  const status = lower(row?.status);
  return id === lower(name) && (status === 'enabled' || status === 'active');
});

export const resolveSandboxPayoutBinding = ({
  tenant = null,
  rds = {},
  live = {},
  clientHints = null,
  amountCents = SANDBOX_PAYOUT_AMOUNT_CENTS,
} = {}) => {
  const expected = PIPELINE_TEST_SANDBOX;
  if (!tenant?.id) return fail('tenant_required', { statusCode: 400 });
  if (lower(tenant.moov_environment) !== 'sandbox') {
    return fail('tenant_not_sandbox', { statusCode: 409, tenantEnvironment: tenant.moov_environment || null });
  }
  if (!sameId(tenant.id, expected.tenantId)) {
    return fail('undesignated_tenant', { statusCode: 403, tenantId: tenant.id });
  }
  if (Number(amountCents) !== SANDBOX_PAYOUT_AMOUNT_CENTS) {
    return fail('amount_not_one_cent', { statusCode: 409, amountCents });
  }
  const hintAmount = claimed(clientHints || {}, ['amount_cents', 'amountCents']);
  if (hintAmount !== null && Number(hintAmount) !== SANDBOX_PAYOUT_AMOUNT_CENTS) {
    return fail('browser_not_authoritative', { statusCode: 403, field: 'amount_cents' });
  }

  const hintIds = collectHintIds(clientHints || {});
  const productionHint = hintIds.find((id) => isKnownProductionMoovObject(id));
  if (productionHint) {
    return fail('production_ids_blocked', {
      statusCode: 409,
      hits: [productionHint],
      message: 'Browser production Moov IDs are refused.',
    });
  }

  const accountId = accountIdOf(rds.account) || live.accountId || null;
  const platformAccountId = live.platformAccountId || live.platformId || rds.platformAccountId || null;
  const wallet = (live.wallets || []).find((row) => sameId(walletIdOf(row), expected.walletId))
    || (sameId(walletIdOf(rds.wallet), expected.walletId) ? rds.wallet : null);
  const availableCents = Number(
    live.walletAvailableCents
    ?? live.wallet?.availableCents
    ?? wallet?.availableCents
    ?? wallet?.available_cents
    ?? rds.wallet?.available_cents
    ?? 0,
  );
  if (!Number.isFinite(availableCents) || availableCents < SANDBOX_PAYOUT_AMOUNT_CENTS) {
    return fail('wallet_available_insufficient', {
      statusCode: 409,
      availableCents,
    });
  }

  const payerMethods = live.payerPaymentMethods || live.paymentMethods || [];
  const recipientMethods = live.recipientPaymentMethods || [];
  const walletPm = payerMethods.find((row) => pmTypeOf(row) === 'moov-wallet' && (
    !row.walletId || sameId(row.walletId, expected.walletId)
  )) || payerMethods.find((row) => sameId(pmIdOf(row), expected.walletPm)) || null;

  const recipientAccountId = live.recipientAccountId || expected.recipientAccountId;
  const recipientBank = (live.recipientBanks || []).find((row) => sameId(bankIdOf(row), expected.recipientBankId))
    || (rds.banks || []).find((row) => sameId(row.provider_bank_account_id, expected.recipientBankId))
    || null;
  const recipientPm = recipientMethods.find((row) => (
    isAchCredit(row)
    && (!row.bankAccountId || sameId(row.bankAccountId, expected.recipientBankId))
  )) || recipientMethods.find((row) => sameId(pmIdOf(row), expected.recipientBankId) && isAchCredit(row))
    || null;

  if (!sameId(accountId, expected.accountId)) {
    return fail('sandbox_account_mismatch', { statusCode: 409, accountId });
  }
  if (isKnownProductionMoovObject(platformAccountId) || sameId(platformAccountId, KNOWN_APPROVED_MOOV.platform.moovAccountId)) {
    return fail('production_ids_blocked', { statusCode: 409, hits: [platformAccountId] });
  }
  if (!sameId(platformAccountId, expected.platformAccountId)) {
    return fail('sandbox_platform_mismatch', { statusCode: 409, platformAccountId });
  }
  if (!sameId(recipientAccountId, expected.recipientAccountId)) {
    return fail('sandbox_recipient_mismatch', { statusCode: 409, recipientAccountId });
  }
  if (isKnownProductionMoovObject(recipientAccountId) || sameId(recipientAccountId, KNOWN_APPROVED_MOOV.recipient.moovAccountId)) {
    return fail('production_ids_blocked', { statusCode: 409, hits: [recipientAccountId] });
  }
  if (!wallet || !sameId(walletIdOf(wallet), expected.walletId)) {
    return fail('sandbox_wallet_mismatch', { statusCode: 409 });
  }
  if (!walletPm || !sameId(pmIdOf(walletPm), expected.walletPm)) {
    return fail('sandbox_wallet_pm_mismatch', { statusCode: 409, found: pmIdOf(walletPm) });
  }
  if (!recipientPm || !isAchCredit(recipientPm)) {
    return fail('sandbox_recipient_pm_missing', {
      statusCode: 409,
      recipientBankId: expected.recipientBankId,
      found: pmIdOf(recipientPm),
    });
  }
  if (sameId(pmIdOf(recipientPm), expected.achDebitFundPm) || sameId(pmIdOf(recipientPm), expected.walletPm)) {
    return fail('recipient_pm_refused', { statusCode: 409, found: pmIdOf(recipientPm) });
  }
  if (sameId(pmIdOf(recipientPm), expected.bankId) || sameId(pmIdOf(walletPm), expected.recipientBankId)) {
    return fail('recipient_bank_refused_as_source', { statusCode: 409 });
  }
  if (sameId(pmIdOf(walletPm), pmIdOf(recipientPm))) {
    return fail('source_destination_collision', { statusCode: 409 });
  }
  if (sameId(pmIdOf(walletPm), expected.achDebitFundPm)) {
    return fail('funding_pm_refused_as_payout_source', { statusCode: 409 });
  }
  if (!capabilityEnabled(live.payerCapabilities || [], 'send-funds')
    && !capabilityEnabled(live.payerCapabilities || [], 'send-funds.ach')) {
    return fail('send_funds_not_enabled', { statusCode: 409 });
  }

  const guard = assertNoCrossEnvironmentObject({
    environment: 'sandbox',
    accountId,
    walletId: expected.walletId,
    bankId: expected.recipientBankId,
    paymentMethodIds: [expected.walletPm, pmIdOf(recipientPm)],
  });
  if (!guard.ok) return fail(guard.error, guard);

  for (const [field, expectedId] of [
    ['accountId', expected.accountId],
    ['walletId', expected.walletId],
    ['sourcePaymentMethodId', expected.walletPm],
    ['recipientAccountId', expected.recipientAccountId],
    ['recipientBankId', expected.recipientBankId],
  ]) {
    const hinted = claimed(clientHints || {}, [field, field.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)]);
    if (hinted && !sameId(hinted, expectedId)) {
      return fail('browser_not_authoritative', { statusCode: 403, field });
    }
  }
  const destHint = claimed(clientHints || {}, ['destinationPaymentMethodId', 'destination_payment_method_id', 'recipientPaymentMethodId']);
  if (destHint && !sameId(destHint, pmIdOf(recipientPm)) && !sameId(destHint, expected.recipientBankId)) {
    return fail('browser_not_authoritative', { statusCode: 403, field: 'destinationPaymentMethodId' });
  }

  const idempotencyKey = sandboxWalletDisbursementIdempotencyKey({
    tenantId: expected.tenantId,
    environment: 'sandbox',
    amountCents: SANDBOX_PAYOUT_AMOUNT_CENTS,
  });
  return {
    ok: true,
    environment: 'sandbox',
    tenantId: expected.tenantId,
    accountId: expected.accountId,
    platformAccountId: expected.platformAccountId,
    walletId: expected.walletId,
    sourcePaymentMethodId: expected.walletPm,
    recipientAccountId: expected.recipientAccountId,
    recipientBankId: expected.recipientBankId,
    destinationPaymentMethodId: pmIdOf(recipientPm),
    amountCents: SANDBOX_PAYOUT_AMOUNT_CENTS,
    availableCents,
    sendFunds: true,
    recipientReady: Boolean(recipientBank || recipientPm),
    idempotencyKey,
    providerIdempotencyKey: SANDBOX_PAYOUT_PROVIDER_UUID,
    post_account_path: sandboxFacilitatorPayoutPath(expected.platformAccountId),
    browserAuthoritative: false,
    rdsWalletId: rds.wallet?.id || null,
    rdsRecipientId: rds.recipient?.id || null,
    rdsWalletMethodId: (rds.banks || []).find((row) => sameId(row.provider_payment_method_id, expected.walletPm))?.id || null,
    rdsDestinationMethodId: (rds.banks || []).find((row) => sameId(row.provider_bank_account_id, expected.recipientBankId))?.id || null,
  };
};

export const planSandboxWalletDisbursement = (binding) => {
  if (!binding?.ok) return binding;
  return {
    ok: true,
    kind: SANDBOX_PAYOUT_LEG,
    environment: 'sandbox',
    tenant_id: binding.tenantId,
    amount_cents: SANDBOX_PAYOUT_AMOUNT_CENTS,
    status: 'planned',
    leg_role: SANDBOX_PAYOUT_LEG,
    description: SANDBOX_PAYOUT_DESCRIPTION,
    idempotency_key: binding.idempotencyKey,
    provider_idempotency_key: binding.providerIdempotencyKey,
    source_payment_method_id: binding.rdsWalletMethodId || null,
    provider_source_payment_method_id: binding.sourcePaymentMethodId,
    destination_payment_method_id: binding.rdsDestinationMethodId || null,
    provider_destination_payment_method_id: binding.destinationPaymentMethodId,
    destination_recipient_id: binding.rdsRecipientId || null,
    wallet_id: binding.rdsWalletId || binding.walletId,
    account_id: binding.accountId,
    recipient_account_id: binding.recipientAccountId,
    recipient_bank_id: binding.recipientBankId,
    post_account_path: binding.post_account_path,
    origin: 'checksops',
    provider_transfer_id: null,
    provider_metadata: {
      phase: M710_PHASE,
      operation: SANDBOX_PAYOUT_OPERATION,
      environment: 'sandbox',
      account_id: binding.accountId,
      platform_account_id: binding.platformAccountId,
      wallet_id: binding.walletId,
      recipient_account_id: binding.recipientAccountId,
      recipient_bank_id: binding.recipientBankId,
      source_payment_method_id: binding.sourcePaymentMethodId,
      destination_payment_method_id: binding.destinationPaymentMethodId,
      provider_idempotency_key: binding.providerIdempotencyKey,
      post_account_path: binding.post_account_path,
    },
  };
};

export const persistSandboxPayoutIntent = async (store, planned) => {
  if (!planned?.ok && planned?.idempotency_key == null) return planned || fail('idempotency_required');
  if (!planned?.idempotency_key) return fail('idempotency_required');
  if (!store?.getIntent) {
    return { ok: true, reused: false, created: false, persisted: false, intent: planned };
  }
  const existing = await store.getIntent(planned.idempotency_key);
  if (existing) {
    return { ok: true, reused: true, created: false, persisted: true, intent: { ...planned, ...existing } };
  }
  const saved = await store.putIntent(planned);
  return {
    ok: true,
    reused: saved.reused === true,
    created: saved.reused !== true,
    persisted: true,
    intent: saved.intent,
  };
};

const UNKNOWN_POST_OUTCOMES = new Set([
  'unknown',
  'unknown_no_retry',
  'timeout',
  'provider_post_unknown',
  'conflict',
]);

export const sandboxPayoutRetryClassification = (intent = {}) => {
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
  return { retryable: false, reason: 'unknown_or_timeout', classification: 'unknown_no_retry' };
};

const classifyPostOutcome = (posted) => {
  if (posted?.ok) return 'posted';
  const status = Number(posted?.statusCode || posted?.httpStatus || 0);
  if (posted?.error === 'provider_egress_failed' || status === 0) return 'unknown';
  if (status >= 500) return 'unknown';
  if (status === 408 || status === 429) return 'unknown';
  if (status === 409) return 'conflict';
  if (status >= 400) return 'failed';
  return 'unknown';
};

export const executeSandboxWalletDisbursement = async ({
  credentials,
  productionPublicKey = null,
  productionSecretKey = null,
  binding,
  intent = null,
  transferPostEnabled = false,
  productionTransferPostEnabled = false,
  fetchImpl = fetch,
} = {}) => {
  const creds = assertSandboxPayoutCredentials({ credentials, productionPublicKey, productionSecretKey });
  if (!creds.ok) return creds;
  if (productionTransferPostEnabled === true) {
    return fail('production_post_flag_refused', { statusCode: 403 });
  }
  if (!binding?.ok) return binding || fail('binding_required');
  const planned = planSandboxWalletDisbursement(binding);
  const current = intent ? { ...planned, ...intent } : planned;
  const retry = sandboxPayoutRetryClassification(current);
  const providerIdempotencyKey = current.provider_idempotency_key
    || current.provider_metadata?.provider_idempotency_key
    || binding.providerIdempotencyKey;
  if (providerIdempotencyKey && binding.providerIdempotencyKey
    && !sameId(providerIdempotencyKey, binding.providerIdempotencyKey)) {
    return fail('idempotency_uuid_mismatch', { statusCode: 409 });
  }
  if (providerIdempotencyKey && !sameId(providerIdempotencyKey, SANDBOX_PAYOUT_PROVIDER_UUID)) {
    return fail('idempotency_uuid_mismatch', { statusCode: 409 });
  }
  const postPath = sandboxFacilitatorPayoutPath(binding.platformAccountId);
  const heldBase = {
    ok: true,
    environment: 'sandbox',
    outcome: 'transfer_post_held',
    transfer_post_held: true,
    liveProviderCalled: false,
    liveProviderPosted: false,
    intent: current,
    intent_id: current.id || null,
    amount_cents: current.amount_cents,
    source_wallet_id: binding.walletId,
    source_payment_method_id: binding.sourcePaymentMethodId,
    destination_payment_method_id: binding.destinationPaymentMethodId,
    recipient_account_id: binding.recipientAccountId,
    recipient_bank_id: binding.recipientBankId,
    account_id: binding.accountId,
    platform_account_id: binding.platformAccountId,
    post_account_path: postPath,
    provider_idempotency_key: providerIdempotencyKey,
    retry_classification: retry.classification,
    production_credentials_used: false,
  };

  if (current.provider_transfer_id) {
    return {
      ...heldBase,
      outcome: 'already_posted',
      transfer_post_held: false,
      liveProviderPosted: false,
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
  if (transferPostEnabled !== true) {
    return heldBase;
  }

  const body = buildMoovSandboxTransferBody({
    sourcePaymentMethodId: binding.sourcePaymentMethodId,
    destinationPaymentMethodId: binding.destinationPaymentMethodId,
    amountCents: SANDBOX_PAYOUT_AMOUNT_CENTS,
    description: SANDBOX_PAYOUT_DESCRIPTION,
  });
  if (body.error) return fail(body.error, { statusCode: 400, message: body.message });
  if (!binding.platformAccountId) return fail('sandbox_platform_required', { statusCode: 409 });
  if (sameId(binding.platformAccountId, binding.accountId)) {
    return fail('facilitator_must_not_be_connected_account', { statusCode: 409 });
  }
  if (sameId(binding.sourcePaymentMethodId, PIPELINE_TEST_SANDBOX.achDebitFundPm)) {
    return fail('funding_pm_refused_as_payout_source', { statusCode: 409 });
  }
  if (sameId(binding.destinationPaymentMethodId, PIPELINE_TEST_SANDBOX.walletPm)) {
    return fail('wallet_pm_refused_as_recipient', { statusCode: 409 });
  }

  let posted;
  try {
    posted = await moovSandboxFetch({
      credentials,
      path: postPath,
      method: 'POST',
      scopes: moovSandboxScopes.transfersWrite(binding.platformAccountId),
      body,
      idempotencyKey: providerIdempotencyKey,
      fetchImpl,
    });
  } catch (error) {
    return {
      ...heldBase,
      ok: false,
      outcome: 'unknown',
      transfer_post_held: false,
      liveProviderCalled: true,
      liveProviderPosted: false,
      doNotRetry: true,
      error: 'provider_post_unknown',
      httpStatus: null,
      requestId: null,
      message: String(error?.message || error).slice(0, 240),
    };
  }

  const outcome = classifyPostOutcome(posted);
  const normalized = posted?.ok ? normalizeMoovSandboxTransfer(posted.data || {}) : null;
  const transferId = normalized?.provider_transfer_id || collectMoovTransferIds(posted?.data || {}).at(0) || null;
  const captured = {
    httpStatus: posted.statusCode || posted.httpStatus || null,
    requestId: posted.requestId || null,
    errorCode: posted.errorCode || null,
    errorTitle: posted.errorTitle || null,
    errorDetail: posted.errorDetail || null,
  };

  if (outcome === 'posted' && transferId) {
    return {
      ...heldBase,
      outcome: 'posted',
      transfer_post_held: false,
      liveProviderCalled: true,
      liveProviderPosted: true,
      provider_transfer_id: transferId,
      provider_status: normalized?.status || posted.data?.status || null,
      provider_idempotency_key: posted.idempotencyKey || providerIdempotencyKey,
      doNotRetry: true,
      ...captured,
    };
  }
  if (outcome === 'conflict') {
    return {
      ...heldBase,
      outcome: 'conflict',
      transfer_post_held: false,
      liveProviderCalled: true,
      liveProviderPosted: false,
      doNotRetry: true,
      error: 'idempotent_conflict',
      message: 'Moov returned conflict. Reconcile GET-only. Do not retry.',
      ...captured,
    };
  }
  if (outcome === 'failed') {
    return {
      ...heldBase,
      ok: false,
      outcome: 'failed',
      transfer_post_held: false,
      liveProviderCalled: true,
      liveProviderPosted: false,
      doNotRetry: true,
      error: posted.error || 'moov_sandbox_http_failed',
      message: posted.message,
      ...captured,
    };
  }
  return {
    ...heldBase,
    ok: false,
    outcome: 'unknown',
    transfer_post_held: false,
    liveProviderCalled: true,
    liveProviderPosted: false,
    doNotRetry: true,
    error: 'provider_post_unknown',
    message: 'POST outcome is unknown. Reconcile GET-only. Do not retry.',
    ...captured,
  };
};

export const knownProductionIdsBlocked = (ids = []) => ids.filter((id) => (
  isKnownProductionMoovObject(id)
  || Object.values(KNOWN_APPROVED_MOOV.freedom).some((value) => sameId(value, id))
  || Object.values(KNOWN_APPROVED_MOOV.recipient).some((value) => sameId(value, id))
));
