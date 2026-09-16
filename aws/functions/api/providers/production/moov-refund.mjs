import { randomUUID } from 'node:crypto';
import { isUuid } from '../../financial-ownership.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import { MOOV_REFUND_TOTP_ACTION, authorizeMoovProduction } from './moov-authz.mjs';
import { isPlatformOwnerCaller } from './moov-roles.mjs';
import { FIRST_PRODUCTION_TRANSFER_CENTS } from './moov-holds.mjs';
import {
  bindMoovProductionGucs,
  casMarkSubmitting,
  commitDurableAttempt,
  existingProductionTransferByKey,
  insertProductionTransferDraft,
  moovRefundIdempotencyKey,
  shouldReconcileInsteadOfPost,
  updateProductionTransfer,
} from './moov-idempotency.mjs';
import { ProductionMoovError, listOf, productionMoovFetch } from './moov-http.mjs';
import { resolveProductionMerchant } from './moov-parties.mjs';
import {
  REQUIRED_CAPS_PLATFORM,
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
  operation: 'platform.refund',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: extra.productionExecution === true,
  kycRequested: false,
  capabilitiesPosted: false,
  ...extra,
});

const claimedTenant = (body) => body?.tenant_id || body?.tenantId || null;

const paymentMethodIdOf = (row) => row?.paymentMethodID || row?.paymentMethodId || null;

/**
 * Tenant Management refund: platform source → tenant wallet (or settlement
 * bank). Not a partner/sub/vendor/homeowner payout. Never re-requests caps.
 */
export async function handleProductionMoovRefund({
  client,
  mapping,
  claims,
  body,
  spoof,
  fetchImpl,
  deps = {},
}) {
  await bindMoovProductionGucs(client, mapping, claims);
  const tenantId = claimedTenant(body);
  if (!tenantId || !isUuid(tenantId)) {
    return fail('invalid_uuid', 400, { field: 'tenant_id', spoofFieldsIgnored: spoof });
  }
  if (!isPlatformOwnerCaller(mapping)) {
    return fail('platform_owner_required', 403, {
      message: 'Only Tenant Management (checksopsadmin@gmail.com) can issue refunds from the platform balance.',
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
      message: 'The first production Moov refund is capped at 1 cent until a later reviewed raise.',
    });
  }

  const merchant = await resolveProductionMerchant(client, tenantId);
  if (!merchant.ok) return { ...merchant, spoofFieldsIgnored: spoof, operation: 'platform.refund' };

  const loaded = await (deps.loadProductionSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  if (!loaded.ok) return { ...loaded, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  let tenantSnap;
  let platformSnap;
  try {
    tenantSnap = await getApprovedAccountSnapshot({
      credentials: loaded.credentials,
      known: merchant,
      fetchImpl,
      includeSweeps: false,
      requiredCapabilities: REQUIRED_CAPS_SEND,
    });
    platformSnap = await getApprovedAccountSnapshot({
      credentials: loaded.credentials,
      known: KNOWN_APPROVED_MOOV.platform,
      fetchImpl,
      includeSweeps: false,
      requiredCapabilities: REQUIRED_CAPS_PLATFORM,
    });
  } catch (error) {
    return fail('moov_preflight_failed', error.status || 502, {
      liveProviderCalled: true,
      message: error.message,
    });
  }

  const tenantKyc = assertNoReKyc(tenantSnap);
  if (!tenantKyc.ok) return { ...tenantKyc, spoofFieldsIgnored: spoof, operation: 'platform.refund' };
  const platformKyc = assertNoReKyc(platformSnap);
  if (!platformKyc.ok) return { ...platformKyc, spoofFieldsIgnored: spoof, operation: 'platform.refund' };

  const tenantMethods = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${merchant.moovAccountId}/payment-methods`,
    fetchImpl,
  }).catch(() => []);
  const platformMethods = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${KNOWN_APPROVED_MOOV.platform.moovAccountId}/payment-methods`,
    fetchImpl,
  }).catch(() => []);

  const destPmRow = listOf(tenantMethods).find((row) => (
    String(row.paymentMethodType) === 'moov-wallet'
    && (!merchant.walletId || String(row.walletID || row.wallet?.walletID || '') === merchant.walletId)
  )) || listOf(tenantMethods).find((row) => String(row.paymentMethodType) === 'moov-wallet')
    || listOf(tenantMethods).find((row) => String(row.paymentMethodType) === 'ach-credit-standard');
  const sourcePmRow = listOf(platformMethods).find((row) => String(row.paymentMethodType) === 'moov-wallet')
    || listOf(platformMethods).find((row) => String(row.paymentMethodType) === 'ach-debit-fund');

  if (!sourcePmRow) {
    return fail('platform_refund_source_missing', 409, {
      liveProviderCalled: true,
      message: 'Platform refund source is not configured. Do not request send-funds or wallet on the facilitator.',
    });
  }
  if (!destPmRow) {
    return fail('tenant_refund_destination_missing', 409, {
      liveProviderCalled: true,
      message: 'Tenant wallet/bank credit method is missing. Do not add a bank or re-KYC.',
    });
  }

  const sourcePm = paymentMethodIdOf(sourcePmRow);
  const destPm = paymentMethodIdOf(destPmRow);
  const facilitatorId = loaded.credentials.platformAccountId || KNOWN_APPROVED_MOOV.platform.moovAccountId;

  const authz = await authorizeMoovProduction({
    client,
    mapping,
    tenantId,
    actionKey: MOOV_REFUND_TOTP_ACTION,
    amountCents: amount,
    sourcePaymentMethodId: sourcePm,
    destinationPaymentMethodId: destPm,
    requirePlatformOwner: true,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  const intentId = randomUUID();
  const key = body?.idempotency_key && String(body.idempotency_key).length >= 8
    ? String(body.idempotency_key).slice(0, 128)
    : moovRefundIdempotencyKey({ tenantId, intentId, amountCents: amount });

  const existing = await existingProductionTransferByKey(client, tenantId, key);
  if (existing) {
    return {
      ok: true,
      statusCode: 200,
      success: true,
      duplicate: true,
      provider: 'moov',
      operation: 'platform.refund',
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
    description: body?.description || 'ChecksOps Tenant Management refund',
    source_tenant_account_id: KNOWN_APPROVED_MOOV.platform.moovAccountId,
    source_payment_method_id: sourcePm,
    destination_tenant_id: tenantId,
    destination_payment_method_id: destPm,
    wallet_id: merchant.walletId || tenantSnap.resolvedWalletId || null,
    leg_role: 'platform_refund',
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
      idempotencyKey: `checksops-refund-${draft.id}`,
      fetchImpl,
      body: {
        source: { paymentMethodID: sourcePm },
        destination: { paymentMethodID: destPm },
        amount: { currency: 'USD', value: amount },
        description: String(body?.description || 'ChecksOps refund').slice(0, 128),
        metadata: {
          checksops_transfer_id: draft.id,
          checksops_tenant_id: tenantId,
          checksops_kind: body?.kind || 'refund',
          checksops_leg: 'platform_refund',
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
    operation: 'platform.refund',
    liveProviderCalled: true,
    productionExecution: true,
    kycRequested: false,
    capabilitiesPosted: false,
    transfer: finalTransfer,
    spoofFieldsIgnored: spoof,
  };
}
