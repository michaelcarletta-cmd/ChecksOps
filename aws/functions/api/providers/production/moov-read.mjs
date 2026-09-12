import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { loadProductionMoovSecrets } from './moov-secrets.mjs';
import {
  loadProductionTenantAccount,
  loadProductionWallet,
  publicProductionMoovAccount,
} from './moov-config.mjs';
import { authorizeMoovProduction } from './moov-authz.mjs';
import { loadTransferById, persistPollOutcome } from './moov-idempotency.mjs';
import { productionMoovFetch, normalizeProductionTransferStatus } from './moov-client.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: false,
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

export function rejectReadMutations(body = {}) {
  if (body.create_account || body.accept_tos || body.add_bank || body.request_capability) {
    return fail('read_only_operation', 400, {
      message: 'Production Moov reads cannot create accounts, request capabilities, add banks, or accept ToS.',
    });
  }
  return null;
}

export async function handleProductionMoovReadiness({
  client,
  mapping,
  body,
  spoof,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  const mutation = rejectReadMutations(body);
  if (mutation) return { ...mutation, spoofFieldsIgnored: spoof };

  const transferId = body.payment_transfer_id || null;
  let tenantId = null;
  if (transferId) {
    const transfer = await loadTransferById(client, transferId);
    if (!transfer || transfer.environment !== 'production') return fail('Transfer not found', 404);
    tenantId = transfer.tenant_id;
  }

  const memberships = await membershipsOf(client, mapping.application_user_id);
  if (tenantId) {
    if (!membershipForTenant(memberships, tenantId)) {
      return fail('cross_tenant_denied', 403, { spoofFieldsIgnored: spoof });
    }
  } else if (memberships.length === 1) {
    tenantId = memberships[0].tenant_id;
  } else {
    return fail('payment_transfer_id is required', 400, {
      message: 'Browser tenant_id is not authority. Supply payment_transfer_id as a lookup.',
    });
  }

  const account = await loadProductionTenantAccount(client, tenantId);
  const wallet = await loadProductionWallet(client, tenantId);
  const secrets = await (deps.loadProductionSecrets || loadProductionMoovSecrets)(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, spoofFieldsIgnored: spoof, local: publicProductionMoovAccount(account) };

  let remote = null;
  let liveProviderCalled = false;
  if (account?.provider_account_id) {
    const accountGet = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${account.provider_account_id}`,
      scopes: [`/accounts/${account.provider_account_id}/profile.read`],
      fetchImpl,
    });
    liveProviderCalled = true;
    const caps = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${account.provider_account_id}/capabilities`,
      scopes: [`/accounts/${account.provider_account_id}/capabilities.read`],
      fetchImpl,
    }).catch(() => ({ json: [] }));
    const banks = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${account.provider_account_id}/bank-accounts`,
      scopes: [`/accounts/${account.provider_account_id}/bank-accounts.read`],
      fetchImpl,
    }).catch(() => ({ json: [] }));
    remote = {
      account: accountGet.json,
      capabilities: caps.json,
      banks: Array.isArray(banks.json) ? banks.json.map((bank) => ({
        status: bank.status || bank.verificationStatus || null,
        verification_status: bank.verificationStatus || bank.status || null,
      })) : [],
    };
  }

  return {
    ok: true,
    statusCode: 200,
    provider: 'moov',
    liveProviderCalled,
    productionExecution: true,
    created: false,
    mutated: false,
    account: publicProductionMoovAccount(account),
    wallet: wallet ? {
      id: wallet.id,
      status: wallet.status,
      available_cents_present: wallet.available_cents != null,
      pending_cents_present: wallet.pending_cents != null,
    } : null,
    remote,
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
  };
}

export async function handleProductionMoovTransferStatus({
  client,
  mapping,
  claims,
  body,
  spoof,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  const mutation = rejectReadMutations(body);
  if (mutation) return { ...mutation, spoofFieldsIgnored: spoof };

  const transferId = body.payment_transfer_id || body.transfer_id;
  if (!transferId) return fail('payment_transfer_id is required', 400);
  const transfer = await loadTransferById(client, transferId);
  if (!transfer || transfer.provider !== 'moov' || transfer.environment !== 'production') {
    return fail('Transfer not found', 404);
  }

  const memberships = await membershipsOf(client, mapping.application_user_id);
  const authz = await authorizeMoovProduction({
    client,
    mapping,
    memberships,
    transfer,
    requireStepUp: false,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof };

  if (!transfer.provider_transfer_id) {
    return {
      ok: true,
      statusCode: 200,
      provider: 'moov',
      liveProviderCalled: false,
      productionExecution: false,
      payment_transfer_id: transfer.id,
      provider_transfer_id: null,
      status: transfer.status,
      message: transfer.provider_http_attempted_at
        ? 'Provider HTTP may have occurred. Reconcile. A new POST was not sent.'
        : 'Intent is queued. Provider transfer id is not persisted yet. Poll is safe.',
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }

  const secrets = await (deps.loadProductionSecrets || loadProductionMoovSecrets)(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, spoofFieldsIgnored: spoof };

  const facilitator = secrets.credentials.platformAccountId;
  const got = await productionMoovFetch({
    credentials: secrets.credentials,
    path: `/accounts/${facilitator}/transfers/${transfer.provider_transfer_id}`,
    scopes: [`/accounts/${facilitator}/transfers.read`],
    fetchImpl,
  });
  const status = normalizeProductionTransferStatus(got.json?.status);
  const saved = await persistPollOutcome(client, {
    rowId: transfer.id,
    status,
    providerTransferId: transfer.provider_transfer_id,
    providerPayload: got.json,
  });
  return {
    ok: true,
    statusCode: 200,
    provider: 'moov',
    liveProviderCalled: true,
    productionExecution: true,
    payment_transfer_id: saved.id,
    provider_transfer_id: saved.provider_transfer_id,
    status: saved.status,
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims?.sub,
  };
}
