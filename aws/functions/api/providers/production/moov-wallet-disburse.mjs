import { randomUUID } from 'node:crypto';
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { KNOWN_APPROVED_MOOV, knownApprovedForTenant } from './moov-accounts.mjs';
import { MOOV_DISBURSE_TOTP_ACTION, authorizeMoovProduction } from './moov-authz.mjs';
import { capabilityEnabled } from './moov-capability-policy.mjs';
import { FIRST_PRODUCTION_TRANSFER_CENTS } from './moov-holds.mjs';
import {
  bindMoovProductionGucs,
  casMarkSubmitting,
  commitDurableAttempt,
  existingProductionTransferByKey,
  insertProductionTransferDraft,
  moovDisburseIdempotencyKey,
  shouldReconcileInsteadOfPost,
  updateProductionTransfer,
} from './moov-idempotency.mjs';
import { ProductionMoovError, listOf, productionMoovFetch } from './moov-http.mjs';
import { assertNoReKyc, getApprovedAccountSnapshot } from './moov-preflight.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  operation: 'wallet.disburse',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: extra.productionExecution === true,
  kycRequested: false,
  capabilitiesPosted: false,
  bankFallback: false,
  internalBypass: false,
  ...extra,
});

const claimedTenant = (body) => body?.tenant_id || body?.tenantId || null;

export async function handleProductionMoovWalletDisburse({
  client,
  mapping,
  claims,
  body,
  spoof,
  fetchImpl,
  deps = {},
}) {
  await bindMoovProductionGucs(client, mapping, claims);

  if (deps.internalBypass === true || body?.internal === true) {
    return fail('internal_bypass_refused', 403, {
      message: 'The legacy x-checksops-internal moov-disburse bypass is refused on the AWS production path.',
    });
  }

  const tenantId = claimedTenant(body);
  if (!tenantId || !UUID_RE.test(String(tenantId))) {
    return fail('invalid_uuid', 400, { field: 'tenant_id', spoofFieldsIgnored: spoof });
  }
  const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
  if (!memberships.some((row) => row.tenant_id === tenantId)) {
    return fail('cross_tenant_denied', 403, { spoofFieldsIgnored: spoof });
  }

  if (body?.source_kind && body.source_kind !== 'wallet') {
    return fail('bank_to_recipient_refused', 403, {
      message: 'Production disbursement is WALLET→RECIPIENT only. Bank→recipient fallback is refused.',
    });
  }

  const amount = Number(body?.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) {
    return fail('invalid_amount', 400, { message: 'amount_cents must be a positive integer.' });
  }
  if (amount !== FIRST_PRODUCTION_TRANSFER_CENTS) {
    return fail('first_transfer_cap', 403, {
      amountCents: amount,
      capCents: FIRST_PRODUCTION_TRANSFER_CENTS,
      message: 'The first production Moov disbursement is capped at 1 cent until a later reviewed raise.',
    });
  }

  const knownPayer = knownApprovedForTenant(tenantId);
  if (!knownPayer?.walletId) {
    return fail('unknown_merchant_do_not_create', 409, {
      message: 'This tenant is not a known approved Moov merchant. Do not create a Moov account or request KYC.',
    });
  }

  const recipientId = body?.external_recipient_id || body?.recipient_id || KNOWN_APPROVED_MOOV.recipient.recipientId;
  if (!UUID_RE.test(String(recipientId))) {
    return fail('invalid_uuid', 400, { field: 'external_recipient_id' });
  }
  if (String(recipientId) !== KNOWN_APPROVED_MOOV.recipient.recipientId) {
    return fail('unknown_recipient_do_not_kyc', 409, {
      message: 'Only the already-verified pay-setup recipient is allowed on this sequence. Do not create or KYC another recipient.',
    });
  }

  const loaded = await (deps.loadProductionSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  if (!loaded.ok) return { ...loaded, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  let payerSnap;
  let recipientSnap;
  try {
    payerSnap = await getApprovedAccountSnapshot({
      credentials: loaded.credentials,
      known: knownPayer,
      fetchImpl,
      includeSweeps: false,
    });
    recipientSnap = await getApprovedAccountSnapshot({
      credentials: loaded.credentials,
      known: KNOWN_APPROVED_MOOV.recipient,
      fetchImpl,
      includeSweeps: false,
    });
  } catch (error) {
    return fail('moov_preflight_failed', error.status || 502, {
      liveProviderCalled: true,
      message: error.message,
    });
  }

  const payerKyc = assertNoReKyc(payerSnap);
  if (!payerKyc.ok) return { ...payerKyc, spoofFieldsIgnored: spoof };
  const recipKyc = assertNoReKyc({
    ...recipientSnap,
    reKycRequired: capabilitiesMissingRecipient(recipientSnap),
    capabilitiesStillNeeded: capabilitiesMissingRecipient(recipientSnap) ? ['transfers'] : [],
  });
  if (!recipKyc.ok && !capabilityEnabled(recipientSnap.capabilities, 'transfers')) {
    return fail('recipient_transfers_not_enabled', 409, {
      liveProviderCalled: true,
      message: 'Recipient transfers capability is not enabled. Do not re-request KYC.',
    });
  }

  const wallet = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${knownPayer.moovAccountId}/wallets/${knownPayer.walletId}`,
    fetchImpl,
  });
  const available = Number(wallet?.availableBalance?.value ?? wallet?.available?.value ?? 0);
  const availableCents = Number.isFinite(available) ? Math.round(available * 100) : 0;
  if (availableCents < amount) {
    return fail('wallet_balance_insufficient', 409, {
      liveProviderCalled: true,
      availableCents,
      amountCents: amount,
      message: 'Wallet available balance is below the disbursement amount. Do not fall back to the tenant bank.',
    });
  }

  const payerMethods = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${knownPayer.moovAccountId}/payment-methods`,
    fetchImpl,
  }).catch(() => []);
  const destMethods = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${KNOWN_APPROVED_MOOV.recipient.moovAccountId}/payment-methods`,
    fetchImpl,
  }).catch(() => []);

  const sourcePmRow = listOf(payerMethods).find((row) => (
    String(row.paymentMethodType) === 'moov-wallet'
    && String(row.walletID || row.wallet?.walletID || '') === knownPayer.walletId
  ));
  const destPmRow = listOf(destMethods).find((row) => (
    String(row.paymentMethodType) === 'ach-credit-standard'
    && String(row.bankAccountID || row.bankAccount?.bankAccountID || '') === KNOWN_APPROVED_MOOV.recipient.bankId
  )) || listOf(destMethods).find((row) => String(row.paymentMethodType) === 'ach-credit-standard');

  if (!sourcePmRow) {
    return fail('wallet_payment_method_missing', 409, { liveProviderCalled: true });
  }
  if (!destPmRow) {
    return fail('recipient_credit_method_missing', 409, {
      liveProviderCalled: true,
      message: 'Recipient has no ach-credit-standard method. Do not add a bank or re-KYC.',
    });
  }

  const sourcePm = sourcePmRow.paymentMethodID || sourcePmRow.paymentMethodId;
  const destPm = destPmRow.paymentMethodID || destPmRow.paymentMethodId;
  const facilitatorId = sourcePmRow.wallet?.partnerAccountID
    || sourcePmRow.wallet?.partnerAccountId
    || sourcePmRow.partnerAccountID
    || loaded.credentials.platformAccountId
    || KNOWN_APPROVED_MOOV.platform.moovAccountId;

  const authz = await authorizeMoovProduction({
    client,
    mapping,
    tenantId,
    actionKey: MOOV_DISBURSE_TOTP_ACTION,
    amountCents: amount,
    sourcePaymentMethodId: sourcePm,
    destinationPaymentMethodId: destPm,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  const intentId = randomUUID();
  const key = body?.idempotency_key && String(body.idempotency_key).length >= 8
    ? String(body.idempotency_key).slice(0, 128)
    : moovDisburseIdempotencyKey({ tenantId, intentId, amountCents: amount });

  const existing = await existingProductionTransferByKey(client, tenantId, key);
  if (existing) {
    return {
      ok: true,
      statusCode: 200,
      success: true,
      duplicate: true,
      provider: 'moov',
      operation: 'wallet.disburse',
      liveProviderCalled: false,
      productionExecution: false,
      kycRequested: false,
      capabilitiesPosted: false,
      transfer: existing,
      spoofFieldsIgnored: spoof,
    };
  }

  const draft = await insertProductionTransferDraft(client, {
    tenant_id: tenantId,
    idempotency_key: key,
    amount_cents: amount,
    description: 'ChecksOps WALLET→RECIPIENT Test 2',
    source_tenant_account_id: knownPayer.moovAccountId,
    source_payment_method_id: sourcePm,
    destination_recipient_id: recipientId,
    destination_payment_method_id: destPm,
    wallet_id: knownPayer.walletId,
    leg_role: 'wallet_disbursement',
    created_by: mapping.application_user_id,
  });

  await commitDurableAttempt(client, mapping, claims);
  const claimed = await casMarkSubmitting(client, draft.id);
  if (!claimed) {
    const raced = await existingProductionTransferByKey(client, tenantId, key);
    if (shouldReconcileInsteadOfPost(raced)) {
      return fail('reconcile_existing_intent', 409, { transfer: raced });
    }
    return fail('cas_lost', 409);
  }

  let created;
  try {
    created = await productionMoovFetch({
      credentials: loaded.credentials,
      path: `/accounts/${facilitatorId}/transfers`,
      method: 'POST',
      allowTransferPost: true,
      idempotencyKey: `checksops-wallet-disburse-${draft.id}`,
      fetchImpl,
      body: {
        source: { paymentMethodID: sourcePm },
        destination: { paymentMethodID: destPm },
        amount: { currency: 'USD', value: amount },
        description: 'ChecksOps WALLET to recipient Test 2',
        metadata: {
          checksops_transfer_id: draft.id,
          checksops_tenant_id: tenantId,
          checksops_recipient_id: recipientId,
          checksops_leg: 'wallet_disbursement',
        },
      },
    });
  } catch (error) {
    const unknown = !(error instanceof ProductionMoovError) || error.status >= 500;
    await updateProductionTransfer(client, draft.id, {
      status: unknown ? 'unknown' : 'failed',
      failure_reason: error.message,
      provider_metadata: { error: error.message },
    });
    return fail(unknown ? 'provider_outcome_unknown' : 'provider_transfer_failed', error.status || 502, {
      liveProviderCalled: true,
      productionExecution: true,
      transfer_id: draft.id,
    });
  }

  const finalTransfer = await updateProductionTransfer(client, draft.id, {
    provider_transfer_id: created?.transferID || created?.transferId || null,
    provider_status: created?.status || null,
    status: String(created?.status || 'pending').toLowerCase() === 'failed' ? 'failed' : 'submitted',
    provider_metadata: created || {},
  });

  return {
    ok: true,
    statusCode: 200,
    success: true,
    duplicate: false,
    provider: 'moov',
    operation: 'wallet.disburse',
    liveProviderCalled: true,
    productionExecution: true,
    kycRequested: false,
    capabilitiesPosted: false,
    bankFallback: false,
    internalBypass: false,
    transfer: finalTransfer,
    spoofFieldsIgnored: spoof,
  };
}

function capabilitiesMissingRecipient(snapshot) {
  return !capabilityEnabled(snapshot.capabilities, 'transfers');
}

export async function handleProductionMoovInitiateWalletFunding(ctx) {
  return {
    ok: false,
    statusCode: 403,
    error: 'use_separate_fund_and_disburse',
    provider: 'moov',
    operation: 'initiate-wallet-funding',
    liveProviderCalled: false,
    productionExecution: false,
    kycRequested: false,
    capabilitiesPosted: false,
    message: 'initiate-wallet-funding couples BANK→WALLET and auto-send. Use moov-wallet-fund then a separate WALLET→RECIPIENT disbursement.',
    spoofFieldsIgnored: ctx.spoof,
  };
}
