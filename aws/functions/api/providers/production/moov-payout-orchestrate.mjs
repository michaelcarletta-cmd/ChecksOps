/**
 * Environment-aware dark payout orchestrator.
 * Tenant.moov_environment is server authority. Browser environment is ignored.
 * Production path stays Freedom-bound. Sandbox path uses sandbox objects only.
 * This phase never POSTs to Moov and never INSERTs payment_transfers.
 */
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { productionMoovFetch } from './moov-client.mjs';
import {
  loadProductionMoovReadSecrets,
  loadSandboxMoovReadSecrets,
} from './moov-secrets.mjs';
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
import { sandboxMoovGet } from './moov-sandbox-client.mjs';
import {
  SANDBOX_SETUP_REQUIRED,
  assertNoCrossEnvironmentObject,
  ignoreClientEnvironment,
  loadTenantMoovEnvironment,
  loadTenantProviderObjects,
} from '../moov-environment.mjs';
import { transferPostEnabledForEnvironment } from '../../provider-flags.mjs';

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

const loadEnvRows = async (client, tenantId, environment) => {
  const transferRows = (await client.query(
    `SELECT id, amount_cents, status, leg_role, idempotency_key, provider_transfer_id, description, environment
       FROM public.payment_transfers
      WHERE tenant_id = $1::uuid
        AND provider = 'moov'
        AND environment = $2
      ORDER BY created_at DESC NULLS LAST
      LIMIT 50`,
    [tenantId, environment],
  )).rows;
  const activityRows = (await client.query(
    `SELECT id, origin, activity_kind, provider_transfer_id, status, amount_cents, environment
       FROM public.payment_provider_activity
      WHERE tenant_id = $1::uuid
        AND provider = 'moov'
        AND environment = $2
      ORDER BY observed_at DESC NULLS LAST
      LIMIT 50`,
    [tenantId, environment],
  )).rows;
  return { transferRows, activityRows };
};

async function orchestrateProduction({
  client,
  mapping,
  body,
  fetchImpl,
  loadSecrets,
  store,
  memberships,
}) {
  const binding = firstTestDisburseBinding();
  const mismatch = mismatchFirstTestBody(body, binding);
  if (mismatch) {
    return fail(mismatch.error, mismatch.statusCode, {
      field: mismatch.field,
      amountCents: mismatch.amountCents,
      capCents: mismatch.capCents,
      message: mismatch.message,
      environment: 'production',
    });
  }

  const tenantId = binding.tenantId;
  if (!membershipForTenant(memberships, tenantId)) {
    return fail('cross_tenant_denied', 403, {
      message: 'First-test payout orchestration is bound to the Freedom tenant. Browser tenant_id is not authority.',
      environment: 'production',
    });
  }

  const secrets = await loadSecrets();
  if (!secrets?.ok) {
    return fail(secrets?.error || 'production_secret_missing', secrets?.statusCode || 503, {
      ...secrets,
      environment: 'production',
    });
  }
  if (secrets.credentials?.environment !== 'production') {
    return fail('cross_environment_credential_refused', 409, {
      message: 'Production orchestration cannot load sandbox credentials.',
      environment: 'production',
    });
  }

  const freedom = KNOWN_APPROVED_MOOV.freedom;
  const recipient = KNOWN_APPROVED_MOOV.recipient;
  const spoof = assertNoCrossEnvironmentObject({
    environment: 'production',
    accountId: freedom.moovAccountId,
    walletId: freedom.walletId,
    bankId: freedom.bankId,
  });
  if (!spoof.ok) return fail(spoof.error, spoof.statusCode, spoof);

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
      environment: 'production',
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

  const { transferRows, activityRows } = await loadEnvRows(client, tenantId, 'production');
  const plan = await orchestratePayout({
    availableCents,
    payoutCents: FIRST_PRODUCTION_TRANSFER_CENTS,
    recipientVerified,
    totpFundPresent: false,
    totpDisbursePresent: false,
    transferPostEnabled: transferPostEnabledForEnvironment('production'),
    persistMoneyIntents: PERSIST_MONEY_INTENTS_THIS_PHASE,
    store,
    existingRows: transferRows,
    sweepActivity: activityRows,
    environment: 'production',
    tenantId,
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
    client_environment_ignored: ignoreClientEnvironment(body),
  };
}

async function orchestrateSandbox({
  client,
  mapping,
  body,
  fetchImpl,
  loadSandboxSecrets,
  store,
  tenantId,
}) {
  const objects = await loadTenantProviderObjects(client, tenantId, 'sandbox');
  if (objects.setup_required) {
    return fail('sandbox_setup_required', 409, {
      environment: 'sandbox',
      setup_required: true,
      message: objects.setup_message || SANDBOX_SETUP_REQUIRED,
    });
  }

  const accountId = objects.account.provider_account_id;
  const walletId = objects.wallet.provider_wallet_id;
  const recipient = objects.recipients[0] || null;
  const recipientAccountId = recipient?.provider_account_id || null;
  const recipientBank = (await client.query(
    `SELECT provider_bank_account_id, verification_status, bank_name, last_four
       FROM public.payment_provider_methods
      WHERE provider = 'moov' AND environment = 'sandbox'
        AND (
          (tenant_id = $1::uuid AND provider_account_id = $2)
          OR (external_recipient_id = $3::uuid)
        )
      ORDER BY connected_at DESC NULLS LAST
      LIMIT 1`,
    [tenantId, recipientAccountId, recipient?.id || '00000000-0000-0000-0000-000000000000'],
  )).rows[0] || null;

  const spoof = assertNoCrossEnvironmentObject({
    environment: 'sandbox',
    accountId,
    walletId,
    bankId: recipientBank?.provider_bank_account_id,
    paymentMethodIds: [recipientAccountId],
  });
  if (!spoof.ok) return fail(spoof.error, spoof.statusCode, spoof);

  const secrets = await loadSandboxSecrets();
  if (!secrets?.ok) {
    return fail(secrets?.error || 'sandbox_secret_missing', secrets?.statusCode || 503, {
      environment: 'sandbox',
      setup_required: false,
      message: 'Sandbox Moov secrets are not configured. Production keys cannot satisfy this path.',
    });
  }
  if (secrets.credentials?.environment !== 'sandbox') {
    return fail('cross_environment_credential_refused', 409, {
      environment: 'sandbox',
      message: 'Sandbox orchestration cannot load production credentials.',
    });
  }

  let liveProviderCalled = false;
  let availableCents = Number(objects.wallet.available_cents || 0);
  try {
    const walletJson = await sandboxMoovGet({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}/wallets/${walletId}`,
      fetchImpl,
      scopes: [`/accounts/${accountId}/wallets.read`],
    });
    liveProviderCalled = true;
    availableCents = amountToCents(walletJson?.availableBalance ?? walletJson?.available);
  } catch (error) {
    return fail('moov_wallet_read_failed', error.status || 502, {
      liveProviderCalled: true,
      environment: 'sandbox',
      message: error.message,
    });
  }

  let recipientVerified = String(recipientBank?.verification_status || '').toLowerCase() === 'verified';
  if (recipientAccountId && recipientBank?.provider_bank_account_id) {
    try {
      const bankJson = await sandboxMoovGet({
        credentials: secrets.credentials,
        path: `/accounts/${recipientAccountId}/bank-accounts/${recipientBank.provider_bank_account_id}`,
        fetchImpl,
        scopes: [`/accounts/${recipientAccountId}/bank-accounts.read`],
      });
      liveProviderCalled = true;
      recipientVerified = String(bankJson?.status || '').toLowerCase() === 'verified';
    } catch {
      recipientVerified = false;
    }
  } else {
    recipientVerified = false;
  }

  const { transferRows, activityRows } = await loadEnvRows(client, tenantId, 'sandbox');
  const recipientBankId = recipientBank?.provider_bank_account_id || null;
  const fundingBank = (objects.banks || []).find((row) => (
    String(row.provider_account_id || '') === String(accountId)
    && String(row.verification_status || '').toLowerCase() === 'verified'
    && String(row.provider_bank_account_id || '') !== String(recipientBankId || '')
  )) || (objects.banks || []).find((row) => (
    String(row.verification_status || '').toLowerCase() === 'verified'
    && String(row.provider_bank_account_id || '') !== String(recipientBankId || '')
  )) || (objects.banks || []).find((row) => String(row.provider_bank_account_id || '') !== String(recipientBankId || ''))
    || objects.banks?.[0]
    || null;
  const bankLabel = recipientBank?.last_four
    ? `${recipientBank.bank_name || 'Bank'} ••••${recipientBank.last_four}`
    : 'Sandbox recipient bank';
  const fundLabel = fundingBank?.last_four
    ? `${fundingBank.bank_name || 'Bank'} ••••${fundingBank.last_four}`
    : 'Sandbox funding bank';
  const plan = await orchestratePayout({
    availableCents,
    payoutCents: FIRST_PRODUCTION_TRANSFER_CENTS,
    recipientVerified,
    totpFundPresent: false,
    totpDisbursePresent: false,
    transferPostEnabled: transferPostEnabledForEnvironment('sandbox'),
    persistMoneyIntents: PERSIST_MONEY_INTENTS_THIS_PHASE,
    store,
    existingRows: transferRows,
    sweepActivity: activityRows,
    environment: 'sandbox',
    tenantId,
    labels: {
      fund: {
        sourceLabel: fundLabel,
        destinationLabel: 'Sandbox wallet',
        bankId: fundingBank?.provider_bank_account_id || null,
        walletId,
        sourcePaymentMethodId: fundingBank?.provider_payment_method_id || null,
      },
      disburse: {
        sourceLabel: 'Sandbox wallet',
        destinationLabel: bankLabel,
        recipientLabel: recipient?.display_name || 'Sandbox recipient',
        recipientId: recipient?.id || tenantId,
      },
    },
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
    sandboxExecution: transferPostEnabledForEnvironment('sandbox'),
    environment: 'sandbox',
    setup_required: false,
    client_environment_ignored: ignoreClientEnvironment(body),
  };
}

export async function handleProductionMoovPayoutOrchestrate({
  client,
  mapping,
  body = {},
  fetchImpl = fetch,
  loadSecrets = loadProductionMoovReadSecrets,
  loadSandboxSecrets = loadSandboxMoovReadSecrets,
  store = null,
} = {}) {
  if (truthy(body.persist_money_intents) || truthy(body.persist) || truthy(body.create_intents)) {
    return fail('money_intent_persist_refused', 403, {
      message: 'M7.8 is prepare-only. payment_transfers INSERT stays off. Do not persist money intents.',
    });
  }
  if (truthy(body.post) || truthy(body.submit) || truthy(body.execute) || truthy(body.auto_send_after_funding)) {
    return fail('provider_post_refused', 403, {
      message: 'M7.8 does not POST to Moov. Funding and payout stay unsubmitted.',
    });
  }

  const memberships = await membershipsOf(client, mapping.application_user_id);
  const claimed = body.tenant_id || body.tenantId || null;
  if (claimed && !UUID_RE.test(String(claimed))) {
    return fail('invalid_uuid', 400, { field: 'tenant_id' });
  }
  const tenantId = claimed || memberships[0]?.tenant_id || null;
  if (!tenantId) return fail('tenant_id is required', 400);
  if (!membershipForTenant(memberships, tenantId)) {
    return fail('cross_tenant_denied', 403, {
      message: 'Requested tenant_id is not a membership of the authenticated user',
    });
  }

  const tenantEnv = await loadTenantMoovEnvironment(client, tenantId);
  if (!tenantEnv.ok) return fail(tenantEnv.error, tenantEnv.statusCode);

  if (tenantEnv.environment === 'sandbox') {
    return orchestrateSandbox({
      client,
      mapping,
      body,
      fetchImpl,
      loadSandboxSecrets,
      store,
      tenantId,
    });
  }

  return orchestrateProduction({
    client,
    mapping,
    body,
    fetchImpl,
    loadSecrets,
    store,
    memberships,
  });
}
