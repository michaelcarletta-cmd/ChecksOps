import { randomUUID } from 'node:crypto';
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { KNOWN_APPROVED_MOOV, knownApprovedForTenant } from './moov-accounts.mjs';
import { MOOV_FUND_TOTP_ACTION, authorizeMoovProduction } from './moov-authz.mjs';
import { capabilityEnabled } from './moov-capability-policy.mjs';
import { FIRST_PRODUCTION_TRANSFER_CENTS } from './moov-holds.mjs';
import {
  bindMoovProductionGucs,
  casMarkSubmitting,
  commitDurableAttempt,
  existingProductionTransferByKey,
  insertProductionTransferDraft,
  moovFundingIdempotencyKey,
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
  const tenantId = claimedTenant(body);
  if (!tenantId || !UUID_RE.test(String(tenantId))) {
    return fail('invalid_uuid', 400, { field: 'tenant_id', spoofFieldsIgnored: spoof });
  }
  const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
  if (!memberships.some((row) => row.tenant_id === tenantId)) {
    return fail('cross_tenant_denied', 403, { spoofFieldsIgnored: spoof });
  }

  const amount = Number(body?.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) {
    return fail('invalid_amount', 400, { message: 'amount_cents must be a positive integer.' });
  }
  if (amount !== FIRST_PRODUCTION_TRANSFER_CENTS) {
    return fail('first_transfer_cap', 403, {
      amountCents: amount,
      capCents: FIRST_PRODUCTION_TRANSFER_CENTS,
      message: 'The first production Moov transfer is capped at 1 cent until a later reviewed raise.',
    });
  }
  if (body?.auto_send_after_funding === true) {
    return fail('auto_send_after_funding_refused', 403, {
      message: 'Funding must not auto-disburse. Run WALLET→RECIPIENT as a separate sequence.',
    });
  }

  const known = knownApprovedForTenant(tenantId);
  if (!known?.moovAccountId) {
    return fail('unknown_merchant_do_not_create', 409, {
      message: 'This tenant is not a known approved Moov merchant. Do not create a Moov account or request KYC.',
    });
  }

  const loaded = await (deps.loadProductionSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  if (!loaded.ok) return { ...loaded, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  let snapshot;
  try {
    snapshot = await getApprovedAccountSnapshot({
      credentials: loaded.credentials,
      known,
      fetchImpl,
      includeSweeps: true,
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
  if (snapshot.sweepEnabledMinZero) {
    return fail('sweep_minimum_blocks_test', 409, {
      liveProviderCalled: true,
      message: 'Freedom Sweep is enabled with a $0 minimum. Pause or raise minimumBalance in a later reviewed step before Test 1, or 1¢ is pushed back to the settlement bank.',
    });
  }

  const methods = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${known.moovAccountId}/payment-methods`,
    fetchImpl,
  }).catch(() => []);
  const debit = listOf(methods).find((row) => (
    String(row.paymentMethodType) === 'ach-debit-fund'
    && String(row.bankAccountID || row.bankAccountID || row.bankAccount?.bankAccountID || '') === known.bankId
  )) || listOf(methods).find((row) => String(row.paymentMethodType) === 'ach-debit-fund');
  const walletPm = listOf(methods).find((row) => (
    String(row.paymentMethodType) === 'moov-wallet'
    && String(row.walletID || row.wallet?.walletID || '') === known.walletId
  ));
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
  const facilitatorId = walletPm.wallet?.partnerAccountID
    || walletPm.wallet?.partnerAccountId
    || walletPm.partnerAccountID
    || loaded.credentials.platformAccountId
    || KNOWN_APPROVED_MOOV.platform.moovAccountId;

  const authz = await authorizeMoovProduction({
    client,
    mapping,
    tenantId,
    actionKey: MOOV_FUND_TOTP_ACTION,
    amountCents: amount,
    sourcePaymentMethodId: sourcePm,
    destinationPaymentMethodId: destPm,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

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

  let draft;
  try {
    draft = await insertProductionTransferDraft(client, {
      tenant_id: tenantId,
      idempotency_key: key,
      amount_cents: amount,
      description: 'ChecksOps BANK→WALLET Test 1',
      source_tenant_account_id: known.moovAccountId,
      source_payment_method_id: sourcePm,
      destination_tenant_id: tenantId,
      wallet_id: known.walletId,
      leg_role: 'wallet_funding',
      created_by: mapping.application_user_id,
    });
  } catch (error) {
    if (/duplicate/i.test(String(error.message))) {
      return fail('A matching payment was already submitted.', 409);
    }
    throw error;
  }

  await commitDurableAttempt(client, mapping, claims);
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
    transfer: finalTransfer,
    spoofFieldsIgnored: spoof,
  };
}
