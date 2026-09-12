import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { loadProductionTenantAccount, loadTenantMoovRecipients } from './moov-config.mjs';
import { authorizeMoovProductionRead } from './moov-authz.mjs';
import { rejectUntrustedMoovAccountFields } from './moov-untrusted.mjs';
import { fingerprintMoovId, productionMoovFetch } from './moov-client.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';
import { evaluateRecipientReady, explainAwaitingBank } from './moov-recipient-readiness.mjs';
import { publicWalletBalance, walletActivityFromLedger } from './moov-wallet-foundation.mjs';
import { authorizeOnboardingTenant } from './moov-onboarding-writes.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: false,
  productionRead: extra.productionRead === true,
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

const deriveReadTenantId = ({ body = {}, memberships = [] } = {}) => {
  const claimed = body.tenant_id || body.tenantId || null;
  if (claimed) {
    const membership = membershipForTenant(memberships, claimed);
    if (!membership) {
      return fail('cross_tenant_denied', 403, {
        message: 'Requested tenant_id is not a membership of the authenticated user',
      });
    }
    return { ok: true, tenantId: claimed };
  }
  if (memberships.length === 1) return { ok: true, tenantId: memberships[0].tenant_id };
  return fail('tenant_required', 400, { message: 'tenant_id is required when the user has multiple memberships.' });
};

const listOf = (json) => {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.banks)) return json.banks;
  if (Array.isArray(json?.paymentMethods)) return json.paymentMethods;
  if (Array.isArray(json?.capabilities)) return json.capabilities;
  return [];
};

export async function handleProductionRecipientReadiness({
  client,
  mapping,
  body = {},
  spoof,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  const spoofed = rejectUntrustedMoovAccountFields(body, { spoofFieldsIgnored: spoof });
  if (spoofed) return spoofed;

  const memberships = await membershipsOf(client, mapping.application_user_id);
  const derived = deriveReadTenantId({ body, memberships });
  if (!derived.ok) return { ...derived, spoofFieldsIgnored: spoof };

  const authz = await authorizeMoovProductionRead({
    client,
    mapping,
    memberships,
    tenantId: derived.tenantId,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof };

  const localRecipients = await loadTenantMoovRecipients(client, derived.tenantId);
  const claimedRecipient = body.recipient_id || body.recipientId || null;
  const scoped = claimedRecipient
    ? localRecipients.filter((row) => String(row.id) === String(claimedRecipient))
    : localRecipients.filter((row) => String(row.environment || '').toLowerCase() === 'production');

  if (claimedRecipient && !scoped.length) {
    return fail('cross_tenant_denied', 403, {
      message: 'Recipient is not owned by the authenticated tenant.',
      spoofFieldsIgnored: spoof,
    });
  }

  const secrets = await (deps.loadProductionReadSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, spoofFieldsIgnored: spoof, productionRead: true };

  const inventories = [];
  for (const local of scoped) {
    if (!local.provider_account_id) {
      inventories.push({
        recipient_id: local.id,
        liveProviderCalled: false,
        local_insufficient: true,
        explanation: explainAwaitingBank({ local, live: {} }),
      });
      continue;
    }
    const accountId = local.provider_account_id;
    const accountGet = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}`,
      mode: 'read',
      scopes: [`/accounts/${accountId}/profile.read`],
      fetchImpl,
    });
    const banksGet = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}/bank-accounts`,
      mode: 'read',
      scopes: [`/accounts/${accountId}/bank-accounts.read`],
      fetchImpl,
    });
    const methodsGet = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}/payment-methods`,
      mode: 'read',
      scopes: [`/accounts/${accountId}/payment-methods.read`],
      fetchImpl,
    });
    const capsGet = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}/capabilities`,
      mode: 'read',
      scopes: [`/accounts/${accountId}/capabilities.read`],
      fetchImpl,
    });
    const live = {
      account: accountGet.json,
      banks: listOf(banksGet.json),
      paymentMethods: listOf(methodsGet.json),
      capabilities: listOf(capsGet.json),
    };
    inventories.push({
      recipient_id: local.id,
      provider_account_id_fp: fingerprintMoovId(accountId),
      liveProviderCalled: true,
      mutated: false,
      local_insufficient: true,
      explanation: explainAwaitingBank({ local, live }),
      readiness: evaluateRecipientReady(live),
    });
  }

  return {
    ok: true,
    statusCode: 200,
    provider: 'moov',
    liveProviderCalled: inventories.some((row) => row.liveProviderCalled),
    productionExecution: false,
    productionRead: true,
    mutated: false,
    tenant_id: derived.tenantId,
    recipients: inventories,
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
  };
}

export async function handleProductionWalletActivity({
  client,
  mapping,
  body = {},
  spoof,
} = {}) {
  const spoofed = rejectUntrustedMoovAccountFields(body, { spoofFieldsIgnored: spoof });
  if (spoofed) return spoofed;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const derived = deriveReadTenantId({ body, memberships });
  if (!derived.ok) return { ...derived, spoofFieldsIgnored: spoof };
  const authz = await authorizeMoovProductionRead({
    client, mapping, memberships, tenantId: derived.tenantId,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof };

  const ledger = (await client.query(
    `SELECT id, direction, amount_cents, status, created_at, provider_transfer_id, leg_role
     FROM public.payment_transfers
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production'
     ORDER BY created_at DESC NULLS LAST
     LIMIT 50`,
    [derived.tenantId],
  )).rows;

  return {
    ok: true,
    statusCode: 200,
    provider: 'moov',
    liveProviderCalled: false,
    productionExecution: false,
    productionRead: true,
    operation: 'BALANCE_READ',
    funding_held: true,
    transfer_held: true,
    disbursement_held: true,
    sweep_held: true,
    activity: walletActivityFromLedger(ledger),
    spoofFieldsIgnored: spoof,
  };
}

export async function handleProductionAccountFiles({
  client, mapping, body = {}, spoof, fetchImpl = fetch, deps = {},
} = {}) {
  const spoofed = rejectUntrustedMoovAccountFields(body, { spoofFieldsIgnored: spoof });
  if (spoofed) return spoofed;
  const auth = await authorizeOnboardingTenant({ client, mapping, body, spoof });
  if (!auth.ok) return auth;
  const account = await loadProductionTenantAccount(client, auth.tenantId);
  if (!account?.provider_account_id) {
    return {
      ok: false, statusCode: 409, error: 'sender_account_missing', provider: 'moov',
      liveProviderCalled: false, productionRead: true,
    };
  }
  const secrets = await (deps.loadProductionReadSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, productionRead: true };
  const accountId = account.provider_account_id;
  const got = await productionMoovFetch({
    credentials: secrets.credentials,
    path: `/accounts/${accountId}/files`,
    mode: 'read',
    scopes: [`/accounts/${accountId}/profile.read`],
    fetchImpl,
  });
  return {
    ok: true,
    statusCode: 200,
    provider: 'moov',
    liveProviderCalled: true,
    productionRead: true,
    productionExecution: false,
    files: Array.isArray(got.json) ? got.json.map((row) => ({
      id_present: Boolean(row.fileID || row.id),
      purpose: row.filePurpose || row.purpose || null,
      status: row.status || row.reviewStatus || null,
    })) : [],
    public_bytes: false,
    spoofFieldsIgnored: spoof,
  };
}

export { publicWalletBalance };
