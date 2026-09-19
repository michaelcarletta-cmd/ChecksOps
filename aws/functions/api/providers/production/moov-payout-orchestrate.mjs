/**
 * Dark production handler: live GET wallet available, plan one funding
 * intent and one payout intent, never POST, never INSERT payment_transfers.
 */
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { productionMoovFetch } from './moov-client.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import {
  FIRST_PRODUCTION_TRANSFER_CENTS,
  firstTestDisburseBinding,
  mismatchFirstTestBody,
} from './moov-first-test.mjs';
import {
  PERSIST_MONEY_INTENTS_THIS_PHASE,
  amountToCents,
  orchestratePayout,
} from './moov-payout-orchestrator.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  operation: 'payout.orchestrate',
  liveProviderCalled: extra.liveProviderCalled === true,
  liveProviderPosted: false,
  createdPaymentTransfer: false,
  persistMoneyIntents: false,
  productionExecution: extra.productionExecution === true,
  ...extra,
});

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

const truthy = (value) => value === true || value === 'true' || value === 1 || value === '1';

const getJson = async ({ credentials, path, fetchImpl, scopes }) => {
  const result = await productionMoovFetch({
    credentials,
    path,
    method: 'GET',
    mode: 'read',
    scopes,
    fetchImpl,
  });
  return result?.json !== undefined ? result.json : result;
};

export async function handleProductionMoovPayoutOrchestrate({
  client,
  mapping,
  body = {},
  fetchImpl = fetch,
  loadSecrets = loadProductionMoovReadSecrets,
  store = null,
} = {}) {
  const binding = firstTestDisburseBinding();
  const mismatch = mismatchFirstTestBody(body, binding);
  if (mismatch) {
    return fail(mismatch.error, mismatch.statusCode, {
      field: mismatch.field,
      amountCents: mismatch.amountCents,
      capCents: mismatch.capCents,
      message: mismatch.message,
    });
  }

  if (truthy(body.persist_money_intents) || truthy(body.persist) || truthy(body.create_intents)) {
    return fail('money_intent_persist_refused', 403, {
      message: 'M7.7 is prepare-only. payment_transfers INSERT stays off. Do not persist money intents.',
    });
  }
  if (truthy(body.post) || truthy(body.submit) || truthy(body.execute) || truthy(body.auto_send_after_funding)) {
    return fail('provider_post_refused', 403, {
      message: 'M7.7 does not POST to Moov. Funding and payout stay unsubmitted.',
    });
  }

  const memberships = await membershipsOf(client, mapping.application_user_id);
  const claimed = body.tenant_id || body.tenantId || null;
  if (claimed && !UUID_RE.test(String(claimed))) {
    return fail('invalid_uuid', 400, { field: 'tenant_id' });
  }
  const tenantId = binding.tenantId;
  if (!membershipForTenant(memberships, tenantId)) {
    return fail('cross_tenant_denied', 403, {
      message: 'First-test payout orchestration is bound to the Freedom tenant. Browser tenant_id is not authority.',
    });
  }

  const secrets = await loadSecrets();
  if (!secrets?.ok) {
    return fail(secrets?.error || 'production_secret_missing', secrets?.statusCode || 503, {
      ...secrets,
      createdPaymentTransfer: false,
      liveProviderPosted: false,
    });
  }

  const freedom = KNOWN_APPROVED_MOOV.freedom;
  const recipient = KNOWN_APPROVED_MOOV.recipient;
  let liveProviderCalled = false;
  let walletJson;
  try {
    walletJson = await getJson({
      credentials: secrets.credentials,
      path: `/accounts/${freedom.moovAccountId}/wallets/${freedom.walletId}`,
      fetchImpl,
      scopes: [`/accounts/${freedom.moovAccountId}/wallets.read`],
    });
    liveProviderCalled = true;
  } catch (error) {
    return fail('moov_wallet_read_failed', error.status || 502, {
      liveProviderCalled: true,
      message: error.message,
    });
  }

  const availableCents = amountToCents(walletJson?.availableBalance ?? walletJson?.available);
  let recipientVerified = false;
  try {
    const bankJson = await getJson({
      credentials: secrets.credentials,
      path: `/accounts/${recipient.moovAccountId}/bank-accounts/${recipient.bankId}`,
      fetchImpl,
      scopes: [`/accounts/${recipient.moovAccountId}/bank-accounts.read`],
    });
    liveProviderCalled = true;
    recipientVerified = String(bankJson?.status || '').toLowerCase() === 'verified';
  } catch {
    recipientVerified = false;
  }

  const transferRows = (await client.query(
    `SELECT id, amount_cents, status, leg_role, idempotency_key, provider_transfer_id, description
       FROM public.payment_transfers
      WHERE tenant_id = $1::uuid
        AND provider = 'moov'
        AND environment = 'production'
      ORDER BY created_at DESC NULLS LAST
      LIMIT 50`,
    [tenantId],
  )).rows;

  const activityRows = (await client.query(
    `SELECT id, origin, activity_kind, provider_transfer_id, status, amount_cents
       FROM public.payment_provider_activity
      WHERE tenant_id = $1::uuid
        AND provider = 'moov'
        AND environment = 'production'
      ORDER BY observed_at DESC NULLS LAST
      LIMIT 50`,
    [tenantId],
  )).rows;

  const plan = await orchestratePayout({
    availableCents,
    payoutCents: FIRST_PRODUCTION_TRANSFER_CENTS,
    recipientVerified,
    totpFundPresent: false,
    totpDisbursePresent: false,
    transferPostEnabled: String(process.env.AWS_MOOV_TRANSFER_POST_ENABLED || '') === 'true',
    persistMoneyIntents: PERSIST_MONEY_INTENTS_THIS_PHASE,
    store,
    existingRows: transferRows,
    sweepActivity: activityRows,
  });

  return {
    ...plan,
    ok: true,
    statusCode: 200,
    success: true,
    provider: 'moov',
    liveProviderCalled,
    liveProviderPosted: false,
    createdPaymentTransfer: false,
    persistMoneyIntents: false,
    productionExecution: false,
    kycRequested: false,
    capabilitiesPosted: false,
    environment: 'production',
  };
}
