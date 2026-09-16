import { randomUUID } from 'node:crypto';
import { isUuid } from '../../financial-ownership.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import { MOOV_FEE_COLLECT_TOTP_ACTION, authorizeMoovProduction } from './moov-authz.mjs';
import { isPlatformOwnerCaller } from './moov-roles.mjs';
import { capabilityEnabled } from './moov-capability-policy.mjs';
import { FIRST_PRODUCTION_TRANSFER_CENTS } from './moov-holds.mjs';
import {
  bindMoovProductionGucs,
  casMarkSubmitting,
  commitDurableAttempt,
  existingProductionTransferByKey,
  insertProductionTransferDraft,
  moovFeeCollectIdempotencyKey,
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
  operation: 'platform.fee_collect',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: extra.productionExecution === true,
  kycRequested: false,
  capabilitiesPosted: false,
  ...extra,
});

const claimedTenant = (body) => body?.tenant_id || body?.tenantId || null;

export async function handleProductionMoovTenantFeeCharge({
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
      message: 'Only Tenant Management (checksopsadmin@gmail.com) can pull monthly and usage fees from other tenants.',
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
      message: 'The first production Moov fee pull is capped at 1 cent until a later reviewed raise.',
    });
  }

  const merchant = await resolveProductionMerchant(client, tenantId);
  if (!merchant.ok) return { ...merchant, spoofFieldsIgnored: spoof, operation: 'platform.fee_collect' };

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
  if (!tenantKyc.ok) return { ...tenantKyc, spoofFieldsIgnored: spoof, operation: 'platform.fee_collect' };
  const platformKyc = assertNoReKyc(platformSnap);
  if (!platformKyc.ok) return { ...platformKyc, spoofFieldsIgnored: spoof, operation: 'platform.fee_collect' };
  if (!capabilityEnabled(tenantSnap.capabilities, 'collect-funds')) {
    return fail('collect_funds_not_enabled', 409, {
      liveProviderCalled: true,
      message: 'This tenant cannot be ACH-debited. Do not request collect-funds; that re-opens billed KYB.',
    });
  }

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

  const sourcePmRow = listOf(tenantMethods).find((row) => (
    String(row.paymentMethodType) === 'ach-debit-fund'
    && (!merchant.bankId || String(row.bankAccountID || row.bankAccount?.bankAccountID || '') === merchant.bankId)
  )) || listOf(tenantMethods).find((row) => String(row.paymentMethodType) === 'ach-debit-fund');
  const destPmRow = listOf(platformMethods).find((row) => String(row.paymentMethodType) === 'moov-wallet')
    || listOf(platformMethods).find((row) => String(row.paymentMethodType) === 'ach-credit-standard');

  if (!sourcePmRow) {
    return fail('ach_debit_fund_missing', 409, {
      liveProviderCalled: true,
      message: 'No ach-debit-fund method on the tenant bank. Do not add a bank or re-KYC.',
    });
  }
  if (!destPmRow) {
    return fail('platform_fee_destination_missing', 409, {
      liveProviderCalled: true,
      message: 'Platform billing destination is not configured. Do not request collect-funds or wallet on the facilitator.',
    });
  }

  const sourcePm = sourcePmRow.paymentMethodID || sourcePmRow.paymentMethodId;
  const destPm = destPmRow.paymentMethodID || destPmRow.paymentMethodId;
  const facilitatorId = loaded.credentials.platformAccountId || KNOWN_APPROVED_MOOV.platform.moovAccountId;

  const authz = await authorizeMoovProduction({
    client,
    mapping,
    tenantId,
    actionKey: MOOV_FEE_COLLECT_TOTP_ACTION,
    amountCents: amount,
    sourcePaymentMethodId: sourcePm,
    destinationPaymentMethodId: destPm,
    requirePlatformOwner: true,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  const intentId = randomUUID();
  const key = body?.idempotency_key && String(body.idempotency_key).length >= 8
    ? String(body.idempotency_key).slice(0, 128)
    : moovFeeCollectIdempotencyKey({ tenantId, intentId, amountCents: amount });

  const existing = await existingProductionTransferByKey(client, tenantId, key);
  if (existing) {
    return {
      ok: true,
      statusCode: 200,
      success: true,
      duplicate: true,
      provider: 'moov',
      operation: 'platform.fee_collect',
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
    description: body?.description || 'ChecksOps Tenant Management fee pull',
    source_tenant_account_id: merchant.moovAccountId,
    source_payment_method_id: sourcePm,
    destination_payment_method_id: destPm,
    wallet_id: platformSnap.resolvedWalletId || null,
    leg_role: 'platform_fee',
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
      idempotencyKey: `checksops-fee-pull-${draft.id}`,
      fetchImpl,
      body: {
        source: { paymentMethodID: sourcePm },
        destination: { paymentMethodID: destPm },
        amount: { currency: 'USD', value: amount },
        description: String(body?.description || 'ChecksOps fees').slice(0, 128),
        metadata: {
          checksops_transfer_id: draft.id,
          checksops_tenant_id: tenantId,
          checksops_kind: body?.kind || 'consolidated',
          checksops_leg: 'platform_fee',
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
    operation: 'platform.fee_collect',
    liveProviderCalled: true,
    productionExecution: true,
    kycRequested: false,
    capabilitiesPosted: false,
    transfer: finalTransfer,
    spoofFieldsIgnored: spoof,
  };
}
