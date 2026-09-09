import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { ignoredOwnershipSpoof, membershipForTenant } from '../../financial-ownership.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';
import {
  loadProductionTenantAccount,
  loadProductionWallet,
  publicProductionMoovAccount,
} from './moov-config.mjs';
import { authorizeMoovProductionRead } from './moov-authz.mjs';
import { loadTransferById } from './moov-idempotency.mjs';
import { persistPollOutcome } from './moov-idempotency.mjs';
import { productionMoovFetch, normalizeProductionTransferStatus } from './moov-client.mjs';

const UNTRUSTED_MOOV_KEYS = [
  'moov_account_id', 'moovAccountId', 'MOOV_ACCOUNT_ID',
  'platform_account_id', 'platformAccountId', 'facilitator_account_id',
  'provider_account_id', 'providerAccountId',
  'accountID', 'accountId',
  'wallet_id', 'walletId', 'provider_wallet_id',
];

const MUTATION_KEYS = [
  'create_account', 'accept_tos', 'add_bank', 'request_capability',
  'fund_wallet', 'create_recipient', 'create_transfer', 'disburse',
  'verify_bank', 'onboard',
];

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: false,
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

export function rejectReadMutations(body = {}) {
  const present = MUTATION_KEYS.filter((key) => body[key]);
  if (!present.length) return null;
  return fail('read_only_operation', 400, {
    fields: present,
    message: 'Production Moov reads cannot create accounts, request capabilities, add banks, accept ToS, fund wallets, or move money.',
  });
}

export function rejectUntrustedMoovAccountFields(body = {}) {
  const present = UNTRUSTED_MOOV_KEYS.filter((key) => body[key] !== undefined && body[key] !== null);
  if (!present.length) return null;
  return fail('untrusted_provider_config', 400, {
    fields: present,
    message: 'Moov account ids are server-derived from payment_provider_accounts. Browser values are rejected.',
    ignored: ignoredOwnershipSpoof(body),
  });
}

export function deriveReadTenantId({ body = {}, memberships = [] } = {}) {
  const claimed = body.tenant_id || body.tenantId || null;
  if (claimed) {
    const membership = membershipForTenant(memberships, claimed);
    if (!membership) {
      return {
        ok: false,
        ...fail('cross_tenant_denied', 403, {
          message: 'Browser tenant_id is not a membership of the authenticated user and is not used as authority.',
        }),
      };
    }
    return { ok: true, tenantId: claimed, membership };
  }
  if (memberships.length === 1) {
    return { ok: true, tenantId: memberships[0].tenant_id, membership: memberships[0] };
  }
  return {
    ok: false,
    ...fail('tenant_lookup_required', 400, {
      message: 'Browser tenant_id is not authority. When the user has multiple memberships, supply the ChecksOps tenant as a lookup identifier.',
    }),
  };
}

const capabilityId = (row) => String(row?.capability || row?.capabilityID || row?.name || '');

const capabilityEnabled = (row) => {
  const status = String(row?.status || '').toLowerCase();
  return status === 'enabled' || status === 'ready';
};

export function summarizeMoovCapabilities(payload) {
  const list = Array.isArray(payload) ? payload : (payload?.capabilities || []);
  const find = (...names) => list.find((row) => {
    const id = capabilityId(row).toLowerCase();
    return names.some((name) => id === name || id.startsWith(`${name}.`) || id.startsWith(name));
  }) || null;
  const send = find('send-funds');
  const collect = find('collect-funds');
  const wallet = find('wallet');
  const sameDay = list.find((row) => /same-day/.test(capabilityId(row).toLowerCase())) || null;
  return {
    send_funds: send ? { id: capabilityId(send), status: send.status || null, enabled: capabilityEnabled(send) } : null,
    collect_funds: collect ? { id: capabilityId(collect), status: collect.status || null, enabled: capabilityEnabled(collect) } : null,
    wallet_balance: wallet ? { id: capabilityId(wallet), status: wallet.status || null, enabled: capabilityEnabled(wallet) } : null,
    same_day_ach: sameDay ? { id: capabilityId(sameDay), status: sameDay.status || null, enabled: capabilityEnabled(sameDay) } : null,
  };
}

const publicBank = (bank) => ({
  status: bank?.status || bank?.verificationStatus || null,
  verification_status: bank?.verificationStatus || bank?.status || null,
  holder_name_present: Boolean(bank?.holderName || bank?.bankAccount?.holderName),
});

const publicWallet = (wallet) => {
  if (!wallet) return null;
  return {
    walletID: wallet.walletID || wallet.id || null,
    status: wallet.status || null,
    available_cents_present: wallet.availableBalance != null || wallet.available?.value != null || wallet.available_cents != null,
    pending_cents_present: wallet.pendingBalance != null || wallet.pending?.value != null || wallet.pending_cents != null,
  };
};

const safeGet = async (args) => {
  try {
    return await productionMoovFetch({ ...args, mode: 'read', method: 'GET' });
  } catch (error) {
    if (error?.code === 'read_only_method_denied' || error?.code === 'read_only_path_denied') throw error;
    return { ok: false, json: null, error: String(error.message || error).slice(0, 200) };
  }
};

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
  const spoofedAccount = rejectUntrustedMoovAccountFields(body);
  if (spoofedAccount) return { ...spoofedAccount, spoofFieldsIgnored: spoof };

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

  const account = await loadProductionTenantAccount(client, derived.tenantId);
  if (!account?.provider_account_id) {
    return fail('sender_account_missing', 409, {
      message: 'No production Moov payment_provider_accounts row for this tenant. Browser cannot supply the Moov account id.',
      spoofFieldsIgnored: spoof,
    });
  }
  const accountId = account.provider_account_id;
  const localWallet = await loadProductionWallet(client, derived.tenantId);
  const secrets = await (
    deps.loadProductionReadSecrets
    || deps.loadProductionSecrets
    || loadProductionMoovReadSecrets
  )(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, spoofFieldsIgnored: spoof, local: publicProductionMoovAccount(account) };

  const accountGet = await productionMoovFetch({
    credentials: secrets.credentials,
    path: `/accounts/${accountId}`,
    mode: 'read',
    scopes: [`/accounts/${accountId}/profile.read`],
    fetchImpl,
  });
  const caps = await safeGet({
    credentials: secrets.credentials,
    path: `/accounts/${accountId}/capabilities`,
    scopes: [`/accounts/${accountId}/capabilities.read`],
    fetchImpl,
  });
  const wallets = await safeGet({
    credentials: secrets.credentials,
    path: `/accounts/${accountId}/wallets`,
    scopes: [`/accounts/${accountId}/wallets.read`],
    fetchImpl,
  });
  const walletList = Array.isArray(wallets.json) ? wallets.json : (wallets.json?.wallets || []);
  const firstWalletId = walletList[0]?.walletID || walletList[0]?.id || localWallet?.provider_wallet_id || null;
  const walletGet = firstWalletId
    ? await safeGet({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}/wallets/${firstWalletId}`,
      scopes: [`/accounts/${accountId}/wallets.read`],
      fetchImpl,
    })
    : { json: null };
  const banks = await safeGet({
    credentials: secrets.credentials,
    path: `/accounts/${accountId}/bank-accounts`,
    scopes: [`/accounts/${accountId}/bank-accounts.read`],
    fetchImpl,
  });
  const methods = await safeGet({
    credentials: secrets.credentials,
    path: `/accounts/${accountId}/payment-methods`,
    scopes: [`/accounts/${accountId}/payment-methods.read`],
    fetchImpl,
  });

  const remoteAccount = accountGet.json || {};
  const capabilities = summarizeMoovCapabilities(caps.json);
  const bankRows = Array.isArray(banks.json) ? banks.json : (banks.json?.bankAccounts || []);
  const methodRows = Array.isArray(methods.json) ? methods.json : (methods.json?.paymentMethods || []);

  return {
    ok: true,
    statusCode: 200,
    provider: 'moov',
    liveProviderCalled: true,
    productionExecution: false,
    productionRead: true,
    created: false,
    mutated: false,
    payment_transfer_required: false,
    tenant_id: derived.tenantId,
    server_derived_provider_account_id_present: true,
    account: publicProductionMoovAccount(account),
    verification: {
      account_status: remoteAccount.status || null,
      account_type: remoteAccount.accountType || remoteAccount.account_type || account.account_type || null,
      kyc: remoteAccount.verification?.status || remoteAccount.verificationStatus || account.verification_status || null,
      kyb: remoteAccount.profile?.business || remoteAccount.foreignID ? 'present' : null,
      tos: remoteAccount.termsOfService || remoteAccount.termsOfService?.acceptedDate || account.tos_accepted_at || null,
      requirements: remoteAccount.requirements || remoteAccount.capabilities?.requirements || null,
    },
    capabilities,
    wallet: publicWallet(walletGet.json) || (localWallet ? {
      id: localWallet.id,
      status: localWallet.status,
      available_cents_present: localWallet.available_cents != null,
      pending_cents_present: localWallet.pending_cents != null,
    } : null),
    banks: bankRows.map(publicBank),
    payment_methods: methodRows.map((row) => ({
      status: row.status || null,
      paymentMethodType: row.paymentMethodType || row.type || null,
    })),
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
  persistOutcome = false,
} = {}) {
  const mutation = rejectReadMutations(body);
  if (mutation) return { ...mutation, spoofFieldsIgnored: spoof };
  const spoofedAccount = rejectUntrustedMoovAccountFields(body);
  if (spoofedAccount) return { ...spoofedAccount, spoofFieldsIgnored: spoof };

  const transferId = body.payment_transfer_id || body.transfer_id;
  if (!transferId) return fail('payment_transfer_id is required', 400);
  const transfer = await loadTransferById(client, transferId);
  if (!transfer || transfer.provider !== 'moov' || transfer.environment !== 'production') {
    return fail('Transfer not found', 404);
  }

  const memberships = await membershipsOf(client, mapping.application_user_id);
  const authz = await authorizeMoovProductionRead({
    client,
    mapping,
    memberships,
    tenantId: transfer.tenant_id,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof };

  if (!transfer.provider_transfer_id) {
    return {
      ok: true,
      statusCode: 200,
      provider: 'moov',
      liveProviderCalled: false,
      productionExecution: false,
      productionRead: true,
      payment_transfer_id: transfer.id,
      provider_transfer_id: null,
      status: transfer.status,
      message: 'Intent is queued. Provider transfer id is not persisted yet. Poll is safe. A POST was not sent.',
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }

  const secrets = await (
    deps.loadProductionReadSecrets
    || deps.loadProductionSecrets
    || loadProductionMoovReadSecrets
  )(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, spoofFieldsIgnored: spoof };
  const facilitator = secrets.credentials.platformAccountId;
  if (!facilitator) {
    return fail('production_secret_missing', 503, {
      message: 'GET of a facilitator transfer requires MOOV_PLATFORM_ACCOUNT_ID. Account readiness GET does not.',
      missingNames: ['MOOV_PLATFORM_ACCOUNT_ID'],
    });
  }

  const got = await productionMoovFetch({
    credentials: secrets.credentials,
    path: `/accounts/${facilitator}/transfers/${transfer.provider_transfer_id}`,
    mode: 'read',
    scopes: [`/accounts/${facilitator}/transfers.read`],
    fetchImpl,
  });
  const status = normalizeProductionTransferStatus(got.json?.status);
  let saved = transfer;
  if (persistOutcome) {
    saved = await persistPollOutcome(client, {
      rowId: transfer.id,
      status,
      providerTransferId: transfer.provider_transfer_id,
      providerPayload: got.json,
    });
  }
  return {
    ok: true,
    statusCode: 200,
    provider: 'moov',
    liveProviderCalled: true,
    productionExecution: false,
    productionRead: true,
    mutated: persistOutcome === true,
    payment_transfer_id: saved.id,
    provider_transfer_id: saved.provider_transfer_id || transfer.provider_transfer_id,
    status,
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims?.sub,
  };
}
