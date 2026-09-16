import { randomUUID } from 'node:crypto';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import { MOOV_FUND_TOTP_ACTION, assertMoovTenantAccess, authorizeMoovProduction, tenantManagementSendDenied } from './moov-sequence-authz.mjs';
import { capabilityEnabled } from './moov-capability-policy.mjs';
import { firstTestFundBinding, mismatchFirstTestBody } from './moov-first-test.mjs';
import { FIRST_PRODUCTION_TRANSFER_CENTS, productionMoovTransferPostAllowed } from './moov-holds.mjs';
import {
  bindMoovProductionGucs,
  casMarkSubmitting,
  commitDurableAttempt,
  existingProductionTransferByKey,
  insertProductionTransferDraft,
  moovFundingIdempotencyKey,
  productionTransferInsertFkError,
  resolveLocalFundIntentRefs,
  shouldReconcileInsteadOfPost,
  updateProductionTransfer,
} from './moov-idempotency.mjs';
import { ProductionMoovError, listOf, productionMoovFetch } from './moov-http.mjs';
import { resolveProductionMerchant } from './moov-parties.mjs';
import { REQUIRED_CAPS_SEND, assertNoReKyc, getApprovedAccountSnapshot } from './moov-preflight.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';
import { isUuid } from '../../financial-ownership.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  operation: 'wallet.fund',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: extra.productionExecution === true,
  kycRequested: false,
  capabilitiesPosted: false,
  ...extra,
});

const claimedTenant = (body) => body?.tenant_id || body?.tenantId || null;

export async function handleProductionMoovWalletFund({
  client,
  mapping,
  claims,
  body,
  spoof,
  fetchImpl,
  deps = {},
}) {
  await bindMoovProductionGucs(client, mapping, claims);
  const binding = firstTestFundBinding();
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
  if (tmDenied) return { ...tmDenied, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false, operation: 'wallet.fund' };
  const access = await assertMoovTenantAccess(client, mapping, tenantId);
  if (!access.ok) return { ...access, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  const amount = binding.amountCents;
  if (body?.auto_send_after_funding === true) {
    return fail('auto_send_after_funding_refused', 403, {
      message: 'Funding must not auto-disburse. Run WALLET→RECIPIENT as a separate sequence.',
    });
  }

  const authz = await authorizeMoovProduction({
    client,
    mapping,
    tenantId,
    actionKey: MOOV_FUND_TOTP_ACTION,
    amountCents: amount,
    sourcePaymentMethodId: binding.sourcePaymentMethodId,
    destinationPaymentMethodId: binding.destinationPaymentMethodId,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  const merchant = await resolveProductionMerchant(client, tenantId);
  if (!merchant.ok) return { ...merchant, spoofFieldsIgnored: spoof, operation: 'wallet.fund' };

  const loaded = await (deps.loadProductionSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  if (!loaded.ok) return { ...loaded, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  let snapshot;
  try {
    snapshot = await getApprovedAccountSnapshot({
      credentials: loaded.credentials,
      known: merchant,
      fetchImpl,
      includeSweeps: true,
      requiredCapabilities: REQUIRED_CAPS_SEND,
    });
  } catch (error) {
    return fail('moov_preflight_failed', error.status || 502, {
      liveProviderCalled: true,
      message: error.message,
    });
  }

  const blockedKyc = assertNoReKyc(snapshot);
  if (!blockedKyc.ok) return { ...blockedKyc, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };
  if (!capabilityEnabled(snapshot.capabilities, 'collect-funds')) {
    return fail('collect_funds_not_enabled', 409, {
      liveProviderCalled: true,
      message: 'Live collect-funds is not enabled. Do not re-request the capability.',
    });
  }
  const walletId = merchant.walletId || snapshot.resolvedWalletId;
  const methods = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${merchant.moovAccountId}/payment-methods`,
    fetchImpl,
  }).catch(() => []);
  const debit = listOf(methods).find((row) => (
    String(row.paymentMethodType) === 'ach-debit-fund'
    && (!merchant.bankId || String(row.bankAccountID || row.bankAccount?.bankAccountID || '') === merchant.bankId)
  )) || listOf(methods).find((row) => String(row.paymentMethodType) === 'ach-debit-fund');
  const walletPm = listOf(methods).find((row) => (
    String(row.paymentMethodType) === 'moov-wallet'
    && (!walletId || String(row.walletID || row.wallet?.walletID || '') === walletId)
  )) || listOf(methods).find((row) => String(row.paymentMethodType) === 'moov-wallet');
  if (!debit?.paymentMethodID && !debit?.paymentMethodId) {
    return fail('ach_debit_fund_missing', 409, {
      liveProviderCalled: true,
      message: 'No ach-debit-fund payment method on the verified bank. Do not add a new bank.',
    });
  }
  if (!walletPm?.paymentMethodID && !walletPm?.paymentMethodId) {
    return fail('wallet_payment_method_missing', 409, {
      liveProviderCalled: true,
      message: 'No moov-wallet payment method. Do not create a new wallet account.',
    });
  }

  const sourcePm = debit.paymentMethodID || debit.paymentMethodId;
  const destPm = walletPm.paymentMethodID || walletPm.paymentMethodId;
  if (
    String(merchant.moovAccountId) !== KNOWN_APPROVED_MOOV.freedom.moovAccountId
    || String(merchant.bankId || '') !== binding.bankId
    || String(walletId || '') !== binding.walletId
    || String(sourcePm) !== binding.sourcePaymentMethodId
    || String(destPm) !== binding.destinationPaymentMethodId
  ) {
    return fail('approved_payment_method_mismatch', 409, {
      liveProviderCalled: true,
      message: 'Live payment methods must match the server-bound Freedom bank and wallet. Browser IDs are not authority.',
    });
  }
  const facilitatorId = walletPm.wallet?.partnerAccountID
    || walletPm.wallet?.partnerAccountId
    || walletPm.partnerAccountID
    || loaded.credentials.platformAccountId
    || KNOWN_APPROVED_MOOV.platform.moovAccountId;

  const intentId = randomUUID();
  const key = body?.idempotency_key && String(body.idempotency_key).length >= 8
    ? String(body.idempotency_key).slice(0, 128)
    : moovFundingIdempotencyKey({ tenantId, intentId, amountCents: amount });

  const existing = await existingProductionTransferByKey(client, tenantId, key);
  if (existing) {
    return {
      ok: true,
      statusCode: 200,
      success: true,
      duplicate: true,
      provider: 'moov',
      operation: 'wallet.fund',
      liveProviderCalled: false,
      productionExecution: false,
      kycRequested: false,
      capabilitiesPosted: false,
      transfer: existing,
      spoofFieldsIgnored: spoof,
    };
  }

  const localRefs = await resolveLocalFundIntentRefs(client, {
    tenantId,
    bankId: binding.bankId,
    walletId,
    sourceMoovPaymentMethodId: sourcePm,
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
      description: 'ChecksOps BANK→WALLET Test 1',
      source_tenant_account_id: merchant.moovAccountId,
      source_payment_method_id: localRefs.sourcePaymentMethodId,
      destination_tenant_id: tenantId,
      destination_payment_method_id: localRefs.destinationPaymentMethodId,
      wallet_id: localRefs.walletId,
      leg_role: 'wallet_funding',
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
      message: 'Durable funding intent was recorded. Moov transfer POST stays held until a later reviewed Test A arming.',
    });
  }

  const claimed = await casMarkSubmitting(client, draft.id);
  if (!claimed) {
    const raced = await existingProductionTransferByKey(client, tenantId, key);
    if (shouldReconcileInsteadOfPost(raced)) {
      return fail('reconcile_existing_intent', 409, {
        transfer: raced,
        message: 'An in-flight or completed funding intent already exists. Reconcile; do not POST again.',
      });
    }
    return fail('cas_lost', 409, { message: 'Could not claim the funding intent. No Moov POST.' });
  }

  let created;
  try {
    created = await productionMoovFetch({
      credentials: loaded.credentials,
      path: `/accounts/${facilitatorId}/transfers`,
      method: 'POST',
      allowTransferPost: true,
      idempotencyKey: `checksops-wallet-fund-${draft.id}`,
      fetchImpl,
      body: {
        source: { paymentMethodID: sourcePm },
        destination: { paymentMethodID: destPm },
        amount: { currency: 'USD', value: amount },
        description: 'ChecksOps BANK to WALLET Test 1',
        metadata: {
          checksops_transfer_id: draft.id,
          checksops_tenant_id: tenantId,
          checksops_leg: 'wallet_funding',
        },
      },
    });
  } catch (error) {
    const unknown = error instanceof ProductionMoovError === false || error.status >= 500;
    await updateProductionTransfer(client, draft.id, {
      status: unknown ? 'unknown' : 'failed',
      failure_reason: error.message,
      provider_metadata: { error: error.message },
    });
    return fail(unknown ? 'provider_outcome_unknown' : 'provider_transfer_failed', error.status || 502, {
      liveProviderCalled: true,
      productionExecution: true,
      transfer_id: draft.id,
      message: unknown
        ? 'Moov POST outcome is unknown. Reconcile this intent. Do not retry blindly.'
        : error.message,
    });
  }

  const providerTransferId = created?.transferID || created?.transferId || null;
  const finalTransfer = await updateProductionTransfer(client, draft.id, {
    provider_transfer_id: providerTransferId,
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
    operation: 'wallet.fund',
    liveProviderCalled: true,
    productionExecution: true,
    kycRequested: false,
    capabilitiesPosted: false,
    autoSendAfterFunding: false,
    sweepAutoPushesAll: snapshot.sweepEnabledMinZero === true,
    transfer: finalTransfer,
    spoofFieldsIgnored: spoof,
  };
}
