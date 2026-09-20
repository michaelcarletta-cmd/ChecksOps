/**
 * M7.9E sandbox BANK→WALLET writer.
 *
 * Server authority: tenant → moov_environment=sandbox → sandbox credentials →
 * Pipeline Test sandbox account / bank / ach-debit-fund PM / wallet.
 * Browser IDs are never authority. Production credentials and production Moov
 * IDs are refused. Transfer POST is gated only by the sandbox Lambda flag
 * passed in as transferPostEnabled. Timeout/unknown is never retried.
 * This module never POSTs wallet→recipient and never uses production POST.
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

export const M79E_PHASE = 'M7.9E';
export const SANDBOX_FUNDING_OPERATION = 'sandbox_bank_to_wallet';
export const SANDBOX_FUNDING_LEG = 'wallet_funding';
export const SANDBOX_FUNDING_AMOUNT_CENTS = FIRST_PRODUCTION_TRANSFER_CENTS;
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
  routingNumber: '322271627',
  lastFour: '4321',
});

export const sandboxFacilitatorTransferPath = (platformAccountId) => (
  `/accounts/${platformAccountId}/transfers`
);

/** Exact M7.9E POST that returned HTTP 403. Reconstruct from code + live run; no retry. */
export const reconstructM79eFailedTransferRequest = () => {
  const expected = PIPELINE_TEST_SANDBOX;
  const body = buildMoovSandboxTransferBody({
    sourcePaymentMethodId: expected.achDebitFundPm,
    destinationPaymentMethodId: expected.walletPm,
    amountCents: SANDBOX_FUNDING_AMOUNT_CENTS,
    description: 'M7.9E sandbox BANK to WALLET 0.01',
  });
  return {
    endpoint: sandboxFacilitatorTransferPath(expected.accountId),
    method: 'POST',
    apiVersion: 'v2024.01.00',
    origin: 'https://checksops.com',
    idempotencyFormat: 'UUIDv4-shaped SHA-256 of business key',
    providerIdempotencyKey: '72f44c1a-5ee4-4601-9e4b-3ca54fbc3935',
    scopes: [`/accounts/${expected.accountId}/transfers.write`],
    sourceAccount: expected.accountId,
    destinationAccount: expected.accountId,
    sourcePaymentMethodId: expected.achDebitFundPm,
    destinationPaymentMethodId: expected.walletPm,
    amount: body.amount,
    description: body.description,
    facilitatorAccountIdInPath: false,
    platformAccountId: expected.platformAccountId,
    facilitatorFee: null,
    metadata: null,
    transferOptions: null,
    achType: null,
    statementDescriptor: null,
  };
};

export const sandboxFacilitatorTransferContract = (binding) => {
  const body = buildMoovSandboxTransferBody({
    sourcePaymentMethodId: binding.sourcePaymentMethodId,
    destinationPaymentMethodId: binding.destinationPaymentMethodId,
    amountCents: binding.amountCents || SANDBOX_FUNDING_AMOUNT_CENTS,
    description: 'M7.9E sandbox BANK to WALLET 0.01',
  });
  return {
    endpoint: sandboxFacilitatorTransferPath(binding.platformAccountId),
    method: 'POST',
    apiVersion: 'v2024.01.00',
    scopes: moovSandboxScopes.transfersWrite(binding.platformAccountId),
    sourceAccount: binding.accountId,
    destinationAccount: binding.accountId,
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

export const sandboxWalletFundingIdempotencyKey = ({
  tenantId,
  environment = 'sandbox',
  operation = SANDBOX_FUNDING_OPERATION,
  leg = SANDBOX_FUNDING_LEG,
  amountCents = SANDBOX_FUNDING_AMOUNT_CENTS,
} = {}) => (
  `checksops:m79e:${operation}:env:${environment}:tenant:${tenantId}:leg:${leg}:cents:${Number(amountCents)}`
);

export const sandboxWalletFundingProviderIdempotency = (businessKey) => idempotencyUuid(businessKey);

const claimed = (body = {}, keys = []) => {
  for (const key of keys) {
    if (body?.[key] !== undefined && body?.[key] !== null && body?.[key] !== '') {
      return body[key];
    }
  }
  return null;
};

export const assertSandboxFundingCredentials = ({ credentials, productionPublicKey = null, productionSecretKey = null } = {}) => {
  const gate = assertMoovSandboxCredentials(credentials);
  if (!gate.ok) {
    return { ...gate, liveProviderCalled: false, liveProviderPosted: false, environment: 'sandbox' };
  }
  if (productionPublicKey && credentials.publicKey === productionPublicKey) {
    return fail('production_credentials_refused', {
      statusCode: 403,
      message: 'Sandbox writer refuses production Moov public key.',
    });
  }
  if (productionSecretKey && credentials.secretKey === productionSecretKey) {
    return fail('production_credentials_refused', {
      statusCode: 403,
      message: 'Sandbox writer refuses production Moov secret key.',
    });
  }
  return { ok: true, environment: 'sandbox', productionCredentialsImpossible: true };
};

const collectHintIds = (hints = {}) => [
  claimed(hints, ['accountId', 'account_id', 'providerAccountId']),
  claimed(hints, ['bankId', 'bank_id', 'sourceBankId']),
  claimed(hints, ['walletId', 'wallet_id', 'destinationWalletId']),
  claimed(hints, ['sourcePaymentMethodId', 'source_payment_method_id']),
  claimed(hints, ['destinationPaymentMethodId', 'destination_payment_method_id']),
].filter(Boolean);

export const resolveSandboxFundBinding = ({
  tenant = null,
  rds = {},
  live = {},
  clientHints = null,
  amountCents = SANDBOX_FUNDING_AMOUNT_CENTS,
} = {}) => {
  const expected = PIPELINE_TEST_SANDBOX;
  if (!tenant?.id) return fail('tenant_required', { statusCode: 400 });
  if (lower(tenant.moov_environment) !== 'sandbox') {
    return fail('tenant_not_sandbox', {
      statusCode: 409,
      tenantEnvironment: tenant.moov_environment || null,
    });
  }
  if (!sameId(tenant.id, expected.tenantId)) {
    return fail('undesignated_tenant', { statusCode: 403, tenantId: tenant.id });
  }
  if (Number(amountCents) !== SANDBOX_FUNDING_AMOUNT_CENTS) {
    return fail('amount_not_one_cent', { statusCode: 409, amountCents });
  }
  const hintAmount = claimed(clientHints || {}, ['amount_cents', 'amountCents']);
  if (hintAmount !== null && Number(hintAmount) !== SANDBOX_FUNDING_AMOUNT_CENTS) {
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
  const rdsFunding = (rds.banks || []).find((row) => sameId(row.provider_bank_account_id, expected.bankId)) || null;
  const fundingBank = (live.banks || []).find((row) => sameId(bankIdOf(row), expected.bankId))
    || rdsFunding
    || null;
  const recipientBank = (rds.banks || []).find((row) => sameId(row.provider_bank_account_id, expected.recipientBankId))
    || (live.banks || []).find((row) => sameId(bankIdOf(row), expected.recipientBankId))
    || null;
  const methods = live.paymentMethods || [];
  const achDebit = methods.find((row) => pmTypeOf(row) === 'ach-debit-fund' && (
    !row.bankAccountId || sameId(row.bankAccountId, expected.bankId)
  )) || methods.find((row) => sameId(pmIdOf(row), expected.achDebitFundPm)) || null;
  const walletPm = methods.find((row) => pmTypeOf(row) === 'moov-wallet' && (
    !row.walletId || sameId(row.walletId, expected.walletId)
  )) || methods.find((row) => sameId(pmIdOf(row), expected.walletPm)) || null;

  if (!sameId(accountId, expected.accountId)) {
    return fail('sandbox_account_mismatch', { statusCode: 409, accountId });
  }
  if (isKnownProductionMoovObject(platformAccountId) || sameId(platformAccountId, KNOWN_APPROVED_MOOV.platform.moovAccountId)) {
    return fail('production_ids_blocked', { statusCode: 409, hits: [platformAccountId] });
  }
  if (!sameId(platformAccountId, expected.platformAccountId)) {
    return fail('sandbox_platform_mismatch', { statusCode: 409, platformAccountId });
  }
  if (!fundingBank || !sameId(bankIdOf(fundingBank), expected.bankId)) {
    return fail('sandbox_bank_mismatch', { statusCode: 409 });
  }
  if (recipientBank && sameId(bankIdOf(fundingBank), bankIdOf(recipientBank))) {
    return fail('recipient_bank_refused_as_source', { statusCode: 409 });
  }
  if (!wallet || !sameId(walletIdOf(wallet), expected.walletId)) {
    return fail('sandbox_wallet_mismatch', { statusCode: 409 });
  }
  if (!achDebit || !sameId(pmIdOf(achDebit), expected.achDebitFundPm)) {
    return fail('sandbox_funding_pm_mismatch', {
      statusCode: 409,
      found: pmIdOf(achDebit),
      rdsPaymentMethodId: fundingBank?.provider_payment_method_id || null,
    });
  }
  if (!walletPm || !sameId(pmIdOf(walletPm), expected.walletPm)) {
    return fail('sandbox_wallet_pm_mismatch', { statusCode: 409, found: pmIdOf(walletPm) });
  }

  const rdsCreditPm = rdsFunding?.provider_payment_method_id || null;

  const guard = assertNoCrossEnvironmentObject({
    environment: 'sandbox',
    accountId,
    walletId: expected.walletId,
    bankId: expected.bankId,
    paymentMethodIds: [expected.achDebitFundPm, expected.walletPm],
  });
  if (!guard.ok) return fail(guard.error, guard);

  for (const [field, expectedId] of [
    ['accountId', expected.accountId],
    ['bankId', expected.bankId],
    ['walletId', expected.walletId],
    ['sourcePaymentMethodId', expected.achDebitFundPm],
    ['destinationPaymentMethodId', expected.walletPm],
  ]) {
    const hinted = claimed(clientHints || {}, [field, field.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)]);
    if (hinted && !sameId(hinted, expectedId)) {
      return fail('browser_not_authoritative', { statusCode: 403, field, message: 'Browser provider IDs are not authority.' });
    }
  }

  const idempotencyKey = sandboxWalletFundingIdempotencyKey({
    tenantId: expected.tenantId,
    environment: 'sandbox',
    operation: SANDBOX_FUNDING_OPERATION,
    leg: SANDBOX_FUNDING_LEG,
    amountCents: SANDBOX_FUNDING_AMOUNT_CENTS,
  });
  const bankLastFour = fundingBank.lastFour || fundingBank.last_four || expected.lastFour;
  const bankName = fundingBank.bankName || fundingBank.bank_name || 'Sandbox bank';
  return {
    ok: true,
    environment: 'sandbox',
    tenantId: expected.tenantId,
    accountId: expected.accountId,
    platformAccountId: expected.platformAccountId,
    bankId: expected.bankId,
    walletId: expected.walletId,
    sourcePaymentMethodId: expected.achDebitFundPm,
    destinationPaymentMethodId: expected.walletPm,
    rdsSourceMethodId: rdsFunding?.id || null,
    rdsWalletId: rds.wallet?.id || null,
    rdsStoredBankPaymentMethodId: rdsCreditPm,
    liveFundingPmAuthoritative: true,
    amountCents: SANDBOX_FUNDING_AMOUNT_CENTS,
    sourceLabel: `${bankName} ••••${bankLastFour}`,
    destinationLabel: 'Sandbox wallet',
    routingNumber: fundingBank.routingNumber || expected.routingNumber,
    lastFour: bankLastFour,
    verified: String(fundingBank.status || fundingBank.verification_status || '').toLowerCase() === 'verified',
    idempotencyKey,
    providerIdempotencyKey: sandboxWalletFundingProviderIdempotency(idempotencyKey),
    productionIdsBlocked: true,
    browserAuthoritative: false,
    productionCredentialsImpossible: true,
  };
};

export const planSandboxWalletFunding = (binding) => {
  if (!binding?.ok) return binding;
  return {
    ok: true,
    kind: SANDBOX_FUNDING_LEG,
    leg_role: SANDBOX_FUNDING_LEG,
    environment: 'sandbox',
    tenant_id: binding.tenantId,
    idempotency_key: binding.idempotencyKey,
    provider_idempotency_key: binding.providerIdempotencyKey,
    amount_cents: binding.amountCents,
    status: 'planned',
    source_tenant_account_id: binding.accountId,
    source_bank_id: binding.bankId,
    destination_wallet_id: binding.walletId,
    source_payment_method_id: binding.rdsSourceMethodId,
    provider_source_payment_method_id: binding.sourcePaymentMethodId,
    provider_destination_payment_method_id: binding.destinationPaymentMethodId,
    wallet_id: binding.rdsWalletId,
    source_label: binding.sourceLabel,
    destination_label: binding.destinationLabel,
    origin: 'checksops',
    provider_transfer_id: null,
    provider_metadata: {
      phase: M79E_PHASE,
      operation: SANDBOX_FUNDING_OPERATION,
      environment: 'sandbox',
      account_id: binding.accountId,
      platform_account_id: binding.platformAccountId,
      bank_id: binding.bankId,
      wallet_id: binding.walletId,
      source_payment_method_id: binding.sourcePaymentMethodId,
      destination_payment_method_id: binding.destinationPaymentMethodId,
      provider_idempotency_key: binding.providerIdempotencyKey,
    },
  };
};

export const persistSandboxFundingIntent = async (store, planned) => {
  if (!planned?.ok && planned?.idempotency_key == null) return planned;
  if (!store) {
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

export const executeSandboxWalletFunding = async ({
  credentials,
  productionPublicKey = null,
  productionSecretKey = null,
  binding,
  intent = null,
  transferPostEnabled = false,
  productionTransferPostEnabled = false,
  fetchImpl = fetch,
} = {}) => {
  const creds = assertSandboxFundingCredentials({ credentials, productionPublicKey, productionSecretKey });
  if (!creds.ok) return creds;
  if (productionTransferPostEnabled === true) {
    return fail('production_post_flag_refused', { statusCode: 403 });
  }
  if (!binding?.ok) return binding || fail('binding_required');
  const planned = planSandboxWalletFunding(binding);
  const current = intent ? { ...planned, ...intent } : planned;
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
    source_bank_id: binding.bankId,
    source_payment_method_id: binding.sourcePaymentMethodId,
    destination_wallet_id: binding.walletId,
    account_id: binding.accountId,
    platform_account_id: binding.platformAccountId,
    provider_idempotency_key: binding.providerIdempotencyKey,
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
  if (current.provider_metadata?.post_attempted === true && !current.provider_transfer_id) {
    return {
      ...heldBase,
      outcome: 'unknown_no_retry',
      transfer_post_held: false,
      liveProviderCalled: false,
      liveProviderPosted: false,
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
    amountCents: SANDBOX_FUNDING_AMOUNT_CENTS,
    description: 'M7.9E sandbox BANK to WALLET 0.01',
  });
  if (body.error) return fail(body.error, { statusCode: 400, message: body.message });
  if (!binding.platformAccountId) return fail('sandbox_platform_required', { statusCode: 409 });
  if (sameId(binding.platformAccountId, binding.accountId)) {
    return fail('facilitator_must_not_be_connected_account', { statusCode: 409 });
  }

  let posted;
  try {
    posted = await moovSandboxFetch({
      credentials,
      path: sandboxFacilitatorTransferPath(binding.platformAccountId),
      method: 'POST',
      scopes: moovSandboxScopes.transfersWrite(binding.platformAccountId),
      body,
      idempotencyKey: binding.providerIdempotencyKey,
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
      message: String(error?.message || error).slice(0, 240),
    };
  }

  const outcome = classifyPostOutcome(posted);
  const normalized = posted?.ok ? normalizeMoovSandboxTransfer(posted.data || {}) : null;
  const transferId = normalized?.provider_transfer_id || collectMoovTransferIds(posted?.data || {}).at(0) || null;

  if (outcome === 'posted' && transferId) {
    return {
      ...heldBase,
      outcome: 'posted',
      transfer_post_held: false,
      liveProviderCalled: true,
      liveProviderPosted: true,
      provider_transfer_id: transferId,
      provider_status: normalized?.status || posted.data?.status || null,
      provider_idempotency_key: posted.idempotencyKey || binding.providerIdempotencyKey,
      doNotRetry: true,
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
      httpStatus: posted.statusCode,
      message: 'Moov returned conflict. Reconcile GET-only. Do not retry.',
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
      httpStatus: posted.statusCode,
      message: posted.message,
      errorCode: posted.errorCode || null,
      errorTitle: posted.errorTitle || null,
      errorDetail: posted.errorDetail || null,
      requestId: posted.requestId || null,
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
    httpStatus: posted?.statusCode || null,
    message: 'POST outcome is unknown. Reconcile GET-only. Do not retry.',
  };
};

export const knownProductionIdsBlocked = (ids = []) => ids.filter((id) => (
  isKnownProductionMoovObject(id)
  || Object.values(KNOWN_APPROVED_MOOV.freedom).some((value) => sameId(value, id))
));
