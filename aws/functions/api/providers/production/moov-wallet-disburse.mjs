import { randomUUID } from 'node:crypto';
import { isUuid } from '../../financial-ownership.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import { MOOV_DISBURSE_TOTP_ACTION, assertMoovTenantAccess, authorizeMoovProduction, tenantManagementSendDenied } from './moov-sequence-authz.mjs';
import { capabilityEnabled } from './moov-capability-policy.mjs';
import { firstTestDisburseBinding, mismatchFirstTestBody } from './moov-first-test.mjs';
import { FIRST_PRODUCTION_TRANSFER_CENTS, productionMoovTransferPostAllowed } from './moov-holds.mjs';
import {
  bindMoovProductionGucs,
  casMarkSubmitting,
  commitDurableAttempt,
  existingProductionTransferByKey,
  insertProductionTransferDraft,
  moovDisburseIdempotencyKey,
  productionTransferInsertFkError,
  resolveLocalDisburseIntentRefs,
  shouldReconcileInsteadOfPost,
  updateProductionTransfer,
} from './moov-idempotency.mjs';
import { ProductionMoovError, listOf, productionMoovFetch } from './moov-http.mjs';
import {
  assertCheckAltCleared,
  requireCheckAltIfNamed,
  resolveProductionMerchant,
  resolveProductionRecipient,
} from './moov-parties.mjs';
import {
  REQUIRED_CAPS_RECIPIENT,
  REQUIRED_CAPS_SEND,
  assertNoReKyc,
  getApprovedAccountSnapshot,
} from './moov-preflight.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';

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

  const binding = firstTestDisburseBinding();
  const mismatch = mismatchFirstTestBody(body, binding);
  if (mismatch) {
    return fail(mismatch.error, mismatch.statusCode, {
      field: mismatch.field,
      amountCents: mismatch.amountCents,
      capCents: mismatch.capCents,
      message: mismatch.message,
      spoofFieldsIgnored: spoof,
    });
  }
  const tenantId = binding.tenantId;
  const tmDenied = tenantManagementSendDenied(mapping);
  if (tmDenied) return { ...tmDenied, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false, operation: 'wallet.disburse' };
  const access = await assertMoovTenantAccess(client, mapping, tenantId);
  if (!access.ok) return { ...access, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  if (body?.source_kind && body.source_kind !== 'wallet') {
    return fail('bank_to_recipient_refused', 403, {
      message: 'Production disbursement is WALLET→RECIPIENT only. Bank→recipient fallback is refused.',
    });
  }

  const amount = binding.amountCents;
  const authz = await authorizeMoovProduction({
    client,
    mapping,
    tenantId,
    actionKey: MOOV_DISBURSE_TOTP_ACTION,
    amountCents: amount,
    sourcePaymentMethodId: binding.sourcePaymentMethodId,
    destinationPaymentMethodId: binding.destinationPaymentMethodId,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  const merchant = await resolveProductionMerchant(client, tenantId);
  if (!merchant.ok) return { ...merchant, spoofFieldsIgnored: spoof, operation: 'wallet.disburse' };

  const recipientId = binding.recipientId;
  const recipient = await resolveProductionRecipient(client, tenantId, recipientId);
  if (!recipient.ok) return { ...recipient, spoofFieldsIgnored: spoof, operation: 'wallet.disburse' };

  const cleared = await requireCheckAltIfNamed(client, {
    tenantId,
    checkaltDepositId: body?.checkalt_deposit_id || body?.deposit_id || null,
    checkIntakeItemId: body?.check_intake_item_id || body?.check_id || null,
    batchId: body?.batch_id || null,
  });
  if (!cleared.ok) return { ...cleared, spoofFieldsIgnored: spoof, operation: 'wallet.disburse' };

  const loaded = await (deps.loadProductionSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  if (!loaded.ok) return { ...loaded, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  let payerSnap;
  let recipientSnap;
  try {
    payerSnap = await getApprovedAccountSnapshot({
      credentials: loaded.credentials,
      known: merchant,
      fetchImpl,
      includeSweeps: false,
      requiredCapabilities: REQUIRED_CAPS_SEND,
    });
    recipientSnap = await getApprovedAccountSnapshot({
      credentials: loaded.credentials,
      known: recipient.known,
      fetchImpl,
      includeSweeps: false,
      requiredCapabilities: REQUIRED_CAPS_RECIPIENT,
    });
  } catch (error) {
    return fail('moov_preflight_failed', error.status || 502, {
      liveProviderCalled: true,
      message: error.message,
    });
  }

  const payerKyc = assertNoReKyc(payerSnap);
  if (!payerKyc.ok) return { ...payerKyc, spoofFieldsIgnored: spoof };
  const recipKyc = assertNoReKyc(recipientSnap);
  if (!recipKyc.ok) return { ...recipKyc, spoofFieldsIgnored: spoof };
  if (!capabilityEnabled(recipientSnap.capabilities, 'transfers')) {
    return fail('recipient_transfers_not_enabled', 409, {
      liveProviderCalled: true,
      message: 'Recipient transfers capability is not enabled. Do not re-request KYC.',
    });
  }

  const walletId = merchant.walletId || payerSnap.resolvedWalletId;
  if (!walletId) {
    return fail('wallet_payment_method_missing', 409, {
      liveProviderCalled: true,
      message: 'No Moov wallet to reuse. Do not create a new wallet account.',
    });
  }

  const wallet = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${merchant.moovAccountId}/wallets/${walletId}`,
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
    path: `/accounts/${merchant.moovAccountId}/payment-methods`,
    fetchImpl,
  }).catch(() => []);
  const destMethods = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${recipient.moovAccountId}/payment-methods`,
    fetchImpl,
  }).catch(() => []);

  const sourcePmRow = listOf(payerMethods).find((row) => (
    String(row.paymentMethodType) === 'moov-wallet'
    && String(row.walletID || row.wallet?.walletID || '') === walletId
  )) || listOf(payerMethods).find((row) => String(row.paymentMethodType) === 'moov-wallet');
  const destPmRow = listOf(destMethods).find((row) => (
    String(row.paymentMethodType) === 'ach-credit-standard'
    && (!recipient.bankId || String(row.bankAccountID || row.bankAccount?.bankAccountID || '') === recipient.bankId)
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
  if (
    String(walletId || '') !== binding.walletId
    || String(recipient.recipientId) !== binding.recipientId
    || String(recipient.bankId || '') !== binding.recipientBankId
    || String(sourcePm) !== binding.sourcePaymentMethodId
    || String(destPm) !== binding.destinationPaymentMethodId
  ) {
    return fail('approved_payment_method_mismatch', 409, {
      liveProviderCalled: true,
      message: 'Live payment methods must match the server-bound Freedom wallet and approved recipient bank. Browser IDs are not authority.',
    });
  }
  const facilitatorId = sourcePmRow.wallet?.partnerAccountID
    || sourcePmRow.wallet?.partnerAccountId
    || sourcePmRow.partnerAccountID
    || loaded.credentials.platformAccountId
    || KNOWN_APPROVED_MOOV.platform.moovAccountId;

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

  const localRefs = await resolveLocalDisburseIntentRefs(client, {
    tenantId,
    walletId,
    recipientId: recipient.recipientId,
    recipientBankId: recipient.bankId || binding.recipientBankId,
  });
  if (!localRefs.ok) {
    return fail(localRefs.error, localRefs.statusCode, {
      message: localRefs.message,
      spoofFieldsIgnored: spoof,
    });
  }

  let draft;
  try {
    draft = await insertProductionTransferDraft(client, {
      tenant_id: tenantId,
      idempotency_key: key,
      amount_cents: amount,
      description: `ChecksOps WALLET→${recipient.label || 'RECIPIENT'}`,
      source_tenant_account_id: merchant.moovAccountId,
      source_payment_method_id: localRefs.sourcePaymentMethodId,
      destination_recipient_id: recipient.recipientId,
      destination_payment_method_id: localRefs.destinationPaymentMethodId,
      wallet_id: localRefs.walletId,
      leg_role: 'wallet_disbursement',
      created_by: mapping.application_user_id,
    });
  } catch (error) {
    if (/duplicate/i.test(String(error.message))) {
      return fail('A matching payment was already submitted.', 409);
    }
    if (productionTransferInsertFkError(error)) {
      return fail('local_payment_ref_fk', 409, {
        message: 'Durable intent must reference local payment_provider_methods / payment_wallets rows, not Moov payment-method IDs.',
      });
    }
    throw error;
  }

  await commitDurableAttempt(client, mapping, claims);
  if (!productionMoovTransferPostAllowed()) {
    return fail('transfer_post_held', 403, {
      darkMode: true,
      liveProviderCalled: false,
      productionExecution: false,
      transfer: draft,
      amountCents: amount,
      capCents: FIRST_PRODUCTION_TRANSFER_CENTS,
      message: 'Durable disbursement intent was recorded. Moov transfer POST stays held until a later reviewed Test A arming.',
    });
  }
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
        description: `ChecksOps WALLET to ${recipient.label || 'recipient'}`,
        metadata: {
          checksops_transfer_id: draft.id,
          checksops_tenant_id: tenantId,
          checksops_recipient_id: recipient.recipientId,
          checksops_checkalt_deposit_id: cleared.deposit?.id || '',
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
    message: 'initiate-wallet-funding couples BANK→WALLET and auto-send. Use moov-wallet-fund then a separate WALLET→RECIPIENT disbursement from wallet available balance.',
    spoofFieldsIgnored: ctx.spoof,
  };
}

export async function handleProductionMoovProcessFundedPayment({ body, spoof, deps = {} }) {
  if (deps.internalBypass === true || body?.internal === true) {
    return fail('internal_bypass_refused', 403, {
      operation: 'process-funded-payment',
      message: 'The legacy x-checksops-internal auto-send is refused. A tenant member must send WALLET→RECIPIENT from wallet available balance.',
    });
  }
  return {
    ok: true,
    statusCode: 200,
    success: true,
    reason: 'manual_send_required',
    provider: 'moov',
    operation: 'process-funded-payment',
    liveProviderCalled: false,
    productionExecution: false,
    kycRequested: false,
    capabilitiesPosted: false,
    autoSend: false,
    message: 'The tenant sends WALLET→RECIPIENT from wallet available balance. CheckAlt is required only when a ChecksOps deposit is named. Tenant Management does not send on their behalf. Auto-send is refused.',
    spoofFieldsIgnored: spoof,
  };
}

export async function handleProductionMoovWalletFundOnClear(ctx) {
  const { client, mapping, claims, body, spoof } = ctx;
  await bindMoovProductionGucs(client, mapping, claims);
  const queueId = body?.queue_id;
  if (!queueId || !isUuid(queueId)) {
    return fail('invalid_uuid', 400, {
      field: 'queue_id',
      operation: 'wallet-fund-on-clear',
      message: 'queue_id is required. Production fund-on-clear is not a cron auto-send.',
    });
  }
  const row = (await client.query(
    `SELECT id, tenant_id, fund_cents, checkalt_deposit_id, check_intake_item_id, status
     FROM public.wallet_funding_queue WHERE id = $1::uuid`,
    [queueId],
  )).rows[0];
  if (!row) {
    return fail('not_found', 404, { operation: 'wallet-fund-on-clear', message: 'Funding queue row not found.' });
  }
  const tmDenied = tenantManagementSendDenied(mapping);
  if (tmDenied) return { ...tmDenied, spoofFieldsIgnored: spoof, operation: 'wallet-fund-on-clear' };
  const access = await assertMoovTenantAccess(client, mapping, row.tenant_id);
  if (!access.ok) return { ...access, spoofFieldsIgnored: spoof, operation: 'wallet-fund-on-clear' };
  const cleared = await assertCheckAltCleared(client, {
    tenantId: row.tenant_id,
    checkaltDepositId: row.checkalt_deposit_id,
    checkIntakeItemId: row.check_intake_item_id,
  });
  if (!cleared.ok) return { ...cleared, spoofFieldsIgnored: spoof, operation: 'wallet-fund-on-clear' };

  const { handleProductionMoovWalletFund } = await import('./moov-wallet-fund.mjs');
  return handleProductionMoovWalletFund({
    ...ctx,
    body: {
      tenant_id: row.tenant_id,
      amount_cents: Number(row.fund_cents),
      idempotency_key: `fund-on-clear:${row.id}`,
      auto_send_after_funding: false,
    },
  });
}
