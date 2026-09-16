import { FINANCIAL_ROLES, roleAllowsFinancial } from '../../financial-authz.mjs';
import { isUuid } from '../../financial-ownership.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import { capabilityEnabled } from './moov-capability-policy.mjs';
import { firstTestFundBinding } from './moov-first-test.mjs';
import { FIRST_PRODUCTION_TRANSFER_CENTS, productionMoovTransferPostAllowed } from './moov-holds.mjs';
import { ProductionMoovError, listOf, productionMoovFetch } from './moov-http.mjs';
import {
  bindMoovProductionGucs,
  casMarkSubmitting,
  loadProductionTransferById,
  providerFundIdempotencyKey,
  resolveLocalFundIntentRefs,
  shouldReconcileInsteadOfPost,
  updateProductionTransfer,
} from './moov-idempotency.mjs';
import { resolveProductionMerchant } from './moov-parties.mjs';
import { REQUIRED_CAPS_SEND, assertNoReKyc, getApprovedAccountSnapshot } from './moov-preflight.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';
import {
  MOOV_FUND_TOTP_ACTION,
  assertMoovTenantAccess,
  authorizeMoovProduction,
  loadTenantRole,
  tenantManagementSendDenied,
} from './moov-sequence-authz.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  operation: 'wallet.fund',
  continueExisting: true,
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: extra.productionExecution === true,
  kycRequested: false,
  capabilitiesPosted: false,
  ...extra,
});

const continueOk = (extra = {}) => ({
  ok: extra.ok !== false,
  statusCode: extra.statusCode || 200,
  provider: 'moov',
  operation: 'wallet.fund',
  continueExisting: true,
  kycRequested: false,
  capabilitiesPosted: false,
  ...extra,
});

export const continuePaymentTransferIdFromBody = (body) => {
  const raw = body?.payment_transfer_id;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  return String(raw).trim();
};

export function validateContinueWalletFundRow(row, {
  expectedTenantId,
  expectedAmountCents = FIRST_PRODUCTION_TRANSFER_CENTS,
} = {}) {
  if (!row) {
    return {
      error: 'continue_intent_not_found',
      statusCode: 404,
      message: 'No payment_transfers row for this payment_transfer_id.',
    };
  }
  if (String(row.tenant_id) !== String(expectedTenantId)) {
    return {
      error: 'continue_tenant_mismatch',
      statusCode: 403,
      message: 'Held intent tenant does not match the server-bound Freedom tenant. Browser tenant_id is not authority.',
    };
  }
  if (String(row.provider) !== 'moov') {
    return {
      error: 'continue_provider_mismatch',
      statusCode: 409,
      message: 'Continue is only valid for provider=moov.',
    };
  }
  if (String(row.environment) !== 'production') {
    return {
      error: 'continue_environment_mismatch',
      statusCode: 409,
      message: 'Continue is only valid for environment=production.',
    };
  }
  if (String(row.leg_role) !== 'wallet_funding') {
    return {
      error: 'continue_leg_role_mismatch',
      statusCode: 409,
      message: 'Continue is only valid for leg_role=wallet_funding.',
    };
  }
  if (Number(row.amount_cents) !== Number(expectedAmountCents)) {
    return {
      error: 'first_transfer_cap',
      statusCode: 403,
      amountCents: Number(row.amount_cents),
      capCents: expectedAmountCents,
      message: 'Continue is capped at 1 cent for this first-test class. Browser amount is not authority.',
    };
  }
  return { ok: true };
}

const continueActorAllowed = (mapping, row, roles = []) => {
  if (String(row.created_by) === String(mapping.application_user_id)) return true;
  return roleAllowsFinancial(roles) || roles.some((role) => FINANCIAL_ROLES.has(role));
};

const reconcileResponse = (row, extra = {}) => continueOk({
  success: true,
  duplicate: true,
  reconcile: true,
  liveProviderCalled: false,
  productionExecution: false,
  casClaimed: false,
  providerPosts: 0,
  providerIdempotencyKey: providerFundIdempotencyKey(row.id),
  transfer: row,
  transfer_id: row.id,
  message: 'An in-flight or completed funding intent already exists. Reconcile; do not POST again.',
  ...extra,
});

async function loadLiveFundRails({
  client,
  mapping,
  tenantId,
  amount,
  binding,
  fetchImpl,
  deps,
  spoof,
}) {
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
      message: 'No moov-wallet payment method. Do not create a new wallet.',
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

  let liveWallet = null;
  try {
    liveWallet = await productionMoovFetch({
      credentials: loaded.credentials,
      path: `/accounts/${merchant.moovAccountId}/wallets/${walletId}`,
      fetchImpl,
    });
  } catch (error) {
    return fail('moov_wallet_lookup_failed', error.status || 502, {
      liveProviderCalled: true,
      message: error.message,
    });
  }
  const liveWalletStatus = String(liveWallet?.status || '').toLowerCase();
  if (liveWalletStatus && liveWalletStatus !== 'active') {
    return fail('continue_wallet_inactive', 409, {
      liveProviderCalled: true,
      message: 'Live Freedom wallet is not active. Do not create a new wallet.',
    });
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

  const facilitatorId = walletPm.wallet?.partnerAccountID
    || walletPm.wallet?.partnerAccountId
    || walletPm.partnerAccountID
    || loaded.credentials.platformAccountId
    || KNOWN_APPROVED_MOOV.platform.moovAccountId;

  return {
    ok: true,
    authz,
    merchant,
    snapshot,
    loaded,
    sourcePm,
    destPm,
    walletId,
    facilitatorId,
    localRefs,
  };
}

/**
 * Continue an already-authorized ready BANK→WALLET payment_transfers row.
 * Accepts only payment_transfer_id. Never inserts. Never trusts browser rail IDs.
 * Dark (AWS_MOOV_TRANSFER_POST_ENABLED=false): validate only — no CAS, no Moov POST.
 */
export async function handleProductionMoovWalletFundContinue({
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
  const tenantId = binding.tenantId;
  const amount = binding.amountCents;
  const providerIdempotencyKeyFor = (id) => providerFundIdempotencyKey(id);

  const transferId = continuePaymentTransferIdFromBody(body);
  if (!transferId || !isUuid(transferId)) {
    return fail('continue_payment_transfer_id_required', 400, {
      message: 'Continue accepts only an existing payment_transfer_id UUID. Browser rail IDs and idempotency keys are ignored.',
      spoofFieldsIgnored: spoof,
    });
  }

  const tmDenied = tenantManagementSendDenied(mapping);
  if (tmDenied) {
    return {
      ...tmDenied,
      spoofFieldsIgnored: spoof,
      kycRequested: false,
      capabilitiesPosted: false,
      operation: 'wallet.fund',
      continueExisting: true,
    };
  }

  const row = await loadProductionTransferById(client, transferId);
  const structural = validateContinueWalletFundRow(row, {
    expectedTenantId: tenantId,
    expectedAmountCents: amount,
  });
  if (!structural.ok) {
    return fail(structural.error, structural.statusCode, {
      message: structural.message,
      amountCents: structural.amountCents,
      capCents: structural.capCents,
      spoofFieldsIgnored: spoof,
    });
  }

  const access = await assertMoovTenantAccess(client, mapping, tenantId);
  if (!access.ok) {
    return { ...access, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false, continueExisting: true };
  }

  const roles = await loadTenantRole(client, mapping.application_user_id, tenantId);
  if (!continueActorAllowed(mapping, row, roles)) {
    return fail('continue_created_by_denied', 403, {
      message: 'created_by must be the authenticated application user or a permitted Freedom financial actor.',
      spoofFieldsIgnored: spoof,
    });
  }

  const rails = await loadLiveFundRails({
    client,
    mapping,
    tenantId,
    amount,
    binding,
    fetchImpl,
    deps,
    spoof,
  });
  if (!rails.ok) return rails;

  if (String(row.source_payment_method_id) !== String(rails.localRefs.sourcePaymentMethodId)) {
    return fail('continue_source_bank_mismatch', 409, {
      liveProviderCalled: true,
      message: 'Held intent source is not the exact connected Freedom bank. Browser source IDs are not authority.',
      spoofFieldsIgnored: spoof,
    });
  }
  if (String(row.wallet_id) !== String(rails.localRefs.walletId)) {
    return fail('continue_wallet_mismatch', 409, {
      liveProviderCalled: true,
      message: 'Held intent wallet is not the exact active Freedom wallet. Browser wallet IDs are not authority.',
      spoofFieldsIgnored: spoof,
    });
  }
  if (
    row.source_tenant_account_id
    && String(row.source_tenant_account_id) !== String(rails.merchant.moovAccountId)
  ) {
    return fail('continue_source_account_mismatch', 409, {
      liveProviderCalled: true,
      message: 'Held intent source account is not the approved Freedom Moov account.',
      spoofFieldsIgnored: spoof,
    });
  }

  const providerIdempotencyKey = providerIdempotencyKeyFor(row.id);

  if (shouldReconcileInsteadOfPost(row) || row.provider_transfer_id) {
    return reconcileResponse(row, { spoofFieldsIgnored: spoof });
  }

  if (row.failure_reason) {
    return fail('continue_failure_reason_present', 409, {
      transfer: row,
      providerIdempotencyKey,
      message: 'Held intent has a failure_reason. Reconcile; do not POST.',
      spoofFieldsIgnored: spoof,
    });
  }

  if (String(row.status) !== 'ready' || row.submitted_at) {
    return fail('continue_status_not_ready', 409, {
      transfer: row,
      providerIdempotencyKey,
      message: 'Continue requires status=ready with submitted_at null. Reconcile; do not POST.',
      spoofFieldsIgnored: spoof,
    });
  }

  if (!productionMoovTransferPostAllowed()) {
    return fail('transfer_post_held', 403, {
      darkMode: true,
      liveProviderCalled: false,
      productionExecution: false,
      casClaimed: false,
      providerPosts: 0,
      providerIdempotencyKey,
      transfer: row,
      transfer_id: row.id,
      amountCents: amount,
      capCents: FIRST_PRODUCTION_TRANSFER_CENTS,
      message: 'Existing funding intent is still valid. Moov transfer POST stays held. Dark continue does not CAS or insert.',
      spoofFieldsIgnored: spoof,
    });
  }

  const claimed = await casMarkSubmitting(client, row.id);
  if (!claimed) {
    const raced = await loadProductionTransferById(client, row.id);
    if (shouldReconcileInsteadOfPost(raced)) {
      return fail('reconcile_existing_intent', 409, {
        transfer: raced,
        casClaimed: false,
        providerIdempotencyKey,
        message: 'An in-flight or completed funding intent already exists. Reconcile; do not POST again.',
        spoofFieldsIgnored: spoof,
      });
    }
    return fail('cas_lost', 409, {
      casClaimed: false,
      providerIdempotencyKey,
      message: 'Could not claim the funding intent. No Moov POST.',
      spoofFieldsIgnored: spoof,
    });
  }

  let created;
  try {
    created = await productionMoovFetch({
      credentials: rails.loaded.credentials,
      path: `/accounts/${rails.facilitatorId}/transfers`,
      method: 'POST',
      allowTransferPost: true,
      idempotencyKey: providerIdempotencyKey,
      fetchImpl,
      body: {
        source: { paymentMethodID: rails.sourcePm },
        destination: { paymentMethodID: rails.destPm },
        amount: { currency: 'USD', value: amount },
        description: 'ChecksOps BANK to WALLET Test 1',
        metadata: {
          checksops_transfer_id: row.id,
          checksops_tenant_id: tenantId,
          checksops_leg: 'wallet_funding',
        },
      },
    });
  } catch (error) {
    const unknown = error instanceof ProductionMoovError === false || error.status >= 500;
    await updateProductionTransfer(client, row.id, {
      status: unknown ? 'unknown' : 'failed',
      failure_reason: error.message,
      provider_metadata: { error: error.message },
    });
    return fail(unknown ? 'provider_outcome_unknown' : 'provider_transfer_failed', error.status || 502, {
      liveProviderCalled: true,
      productionExecution: true,
      casClaimed: true,
      providerIdempotencyKey,
      transfer_id: row.id,
      message: unknown
        ? 'Moov POST outcome is unknown. Reconcile this intent. Do not retry blindly.'
        : error.message,
      spoofFieldsIgnored: spoof,
    });
  }

  const providerTransferId = created?.transferID || created?.transferId || null;
  const finalTransfer = await updateProductionTransfer(client, row.id, {
    provider_transfer_id: providerTransferId,
    provider_status: created?.status || null,
    status: String(created?.status || 'pending').toLowerCase() === 'failed' ? 'failed' : 'submitted',
    provider_metadata: created || {},
  });

  return continueOk({
    success: true,
    duplicate: false,
    liveProviderCalled: true,
    productionExecution: true,
    casClaimed: true,
    providerIdempotencyKey,
    autoSendAfterFunding: false,
    sweepAutoPushesAll: rails.snapshot.sweepEnabledMinZero === true,
    transfer: finalTransfer,
    spoofFieldsIgnored: spoof,
  });
}
