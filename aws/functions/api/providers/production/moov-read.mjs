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
import {
  productionMoovFetch,
  normalizeProductionTransferStatus,
  redactMoovText,
  publicMoovErrorBody,
  fingerprintMoovId,
} from './moov-client.mjs';

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
  const send = find('send-funds.ach', 'send-funds');
  const collect = find('collect-funds.ach', 'collect-funds');
  const wallet = find('wallet.balance', 'wallet');
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

const centsOf = (...candidates) => {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string' && candidate.trim() !== '' && Number.isFinite(Number(candidate))) {
      return Number(candidate);
    }
    if (typeof candidate === 'object') {
      const nested = centsOf(candidate.value, candidate.amount, candidate.cents);
      if (nested != null) return nested;
    }
  }
  return null;
};

const publicWallet = (wallet) => {
  if (!wallet) return null;
  const availableCents = centsOf(wallet.availableBalance, wallet.available, wallet.available_cents);
  const pendingCents = centsOf(wallet.pendingBalance, wallet.pending, wallet.pending_cents);
  return {
    status: wallet.status || null,
    wallet_id_present: Boolean(wallet.walletID || wallet.id),
    available_cents: availableCents,
    pending_cents: pendingCents,
    available_cents_present: availableCents != null,
    pending_cents_present: pendingCents != null,
  };
};

const publicTos = (tos, localAcceptedAt) => {
  if (!tos && !localAcceptedAt) return { accepted: null, accepted_at: null };
  if (typeof tos === 'string') {
    return { accepted: true, accepted_at: tos };
  }
  const acceptedAt = tos?.acceptedDate || tos?.acceptedOn || tos?.accepted_at || localAcceptedAt || null;
  if (acceptedAt) return { accepted: true, accepted_at: acceptedAt };
  if (tos?.accepted === false) return { accepted: false, accepted_at: null };
  if (tos?.accepted === true) return { accepted: true, accepted_at: acceptedAt };
  return { accepted: null, accepted_at: null };
};

const publicRequirements = (requirements) => {
  if (!requirements) return { present: false, action_required: null };
  const currentlyDue = requirements.currentlyDue || requirements.currently_due || requirements.actionRequired || requirements.action_required || null;
  return {
    present: true,
    action_required: currentlyDue == null ? null : redactMoovText(JSON.stringify(currentlyDue)).slice(0, 400),
    disabled_reason: requirements.disabledReason || requirements.disabled_reason || null,
  };
};

const getSummary = (got) => ({
  ok: got?.ok === true,
  status: got?.status ?? null,
  error: got?.error ? redactMoovText(got.error) : null,
  www_authenticate: got?.www_authenticate || null,
  request_id: got?.request_id || null,
  body_keys: got?.body_keys || null,
  provider_error: got?.provider_error || null,
});

const safeGet = async (args) => {
  try {
    const got = await productionMoovFetch({ ...args, mode: 'read', method: 'GET' });
    return {
      ok: true,
      status: got.status,
      json: got.json,
      error: null,
      diagnosis: got.diagnosis || null,
    };
  } catch (error) {
    if (error?.code === 'read_only_method_denied' || error?.code === 'read_only_path_denied') throw error;
    const diagnosis = error?.diagnosis || error?.oauth || null;
    return {
      ok: false,
      json: null,
      status: error?.status || null,
      error: redactMoovText(String(error.message || error)).slice(0, 200),
      diagnosis,
      www_authenticate: diagnosis?.www_authenticate || null,
      request_id: diagnosis?.request_id || null,
      body_keys: diagnosis?.body_keys || null,
      provider_error: diagnosis?.provider_error || publicMoovErrorBody(error?.body),
    };
  }
};

export function classifySenderReadiness({
  accountGetOk,
  verification = {},
  capabilities = {},
  wallet = null,
  banks = [],
} = {}) {
  const reasons = [];
  if (!accountGetOk) reasons.push('live_account_get_failed');
  const status = String(verification.account_status || '').toLowerCase();
  if (accountGetOk && status && !['verified', 'active', 'approved', 'enabled'].includes(status)) {
    reasons.push(`account_status_${status}`);
  }
  const kyc = String(verification.kyc || '').toLowerCase();
  if (accountGetOk && kyc && !['verified', 'verified_with_changes', 'pending'].includes(kyc) && kyc !== 'unverified') {
    reasons.push(`kyc_${kyc}`);
  }
  if (accountGetOk && kyc && ['unverified', 'failed', 'rejected', 'restricted'].includes(kyc)) {
    reasons.push(`kyc_${kyc}`);
  }
  if (verification.tos && verification.tos.accepted === false) reasons.push('tos_not_accepted');
  if (capabilities.send_funds && capabilities.send_funds.enabled !== true) reasons.push('send_funds_ach_not_enabled');
  if (!capabilities.send_funds) reasons.push('send_funds_ach_unknown');
  if (!wallet) reasons.push('wallet_missing');
  const bankOk = (banks || []).some((row) => {
    const statusValue = String(row.verification_status || row.status || '').toLowerCase();
    return ['verified', 'connected', 'active'].includes(statusValue);
  });
  if ((banks || []).length === 0) reasons.push('bank_missing');
  else if (!bankOk) reasons.push('bank_not_verified');
  return {
    verdict: reasons.length ? 'BLOCKED' : 'SENDER_READY',
    reasons,
  };
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
  const accountGetOnly = body.account_get_only === true;
  const localWallet = accountGetOnly ? null : await loadProductionWallet(client, derived.tenantId);
  const secrets = await (
    deps.loadProductionReadSecrets
    || deps.loadProductionSecrets
    || loadProductionMoovReadSecrets
  )(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, spoofFieldsIgnored: spoof, local: publicProductionMoovAccount(account) };

  const accountGet = await safeGet({
    credentials: secrets.credentials,
    path: `/accounts/${accountId}`,
    scopes: [`/accounts/${accountId}/profile.read`],
    fetchImpl,
  });
  if (accountGetOnly) {
    const remoteAccount = accountGet.json || {};
    const oauth = accountGet.diagnosis?.oauth || null;
    const oauthHttp = oauth?.http ?? null;
    const oauthOk = oauthHttp === 200 && oauth?.has_access_token === true;
    return {
      ok: accountGet.ok === true,
      statusCode: accountGet.ok === true ? 200 : (oauthHttp && oauthHttp !== 200 ? oauthHttp : 502),
      error: accountGet.ok === true ? undefined : (oauthOk ? 'moov_account_get_failed' : 'moov_oauth_failed'),
      provider: 'moov',
      liveProviderCalled: true,
      productionExecution: false,
      productionRead: true,
      created: false,
      mutated: false,
      account_get_only: true,
      extra_reads_skipped: true,
      payment_transfer_required: false,
      tenant_id: derived.tenantId,
      server_derived_provider_account_id_present: true,
      live_account: {
        account_id_fp: fingerprintMoovId(remoteAccount.accountID || remoteAccount.accountId || accountId),
        matches_expected_freedom_id: fingerprintMoovId(accountId) === '60922058…de96',
        display_name: remoteAccount.displayName
          || remoteAccount.profile?.business?.legalBusinessName
          || null,
        mode: remoteAccount.mode || null,
        verification_status: remoteAccount.verification?.status
          || remoteAccount.verificationStatus
          || null,
      },
      live_gets: { account: getSummary(accountGet) },
      auth_diagnosis: {
        account_get: accountGet.diagnosis || null,
        oauth,
        origin_constant: 'https://checksops.com',
        api_version: secrets.credentials?.apiVersion || null,
        platform_account_id_configured: Boolean(secrets.credentials?.platformAccountId),
      },
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }
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
    : { ok: false, json: null, status: null, error: 'wallet_id_unavailable' };
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
  const verification = {
    account_status: remoteAccount.status || null,
    account_type: remoteAccount.accountType || remoteAccount.account_type || null,
    kyc: remoteAccount.verification?.status || remoteAccount.verificationStatus || null,
    kyb: remoteAccount.profile?.business ? 'business_profile_present' : (remoteAccount.profile?.individual ? 'individual_profile_present' : null),
    tos: publicTos(remoteAccount.termsOfService, null),
    requirements: publicRequirements(remoteAccount.requirements || remoteAccount.capabilities?.requirements),
  };
  const wallet = publicWallet(walletGet.json) || (wallets.ok === true && walletList[0] ? publicWallet(walletList[0]) : null);
  const bankSummaries = bankRows.map(publicBank);
  const sender = classifySenderReadiness({
    accountGetOk: accountGet.ok === true,
    verification,
    capabilities,
    wallet,
    banks: bankSummaries,
  });
  const liveGets = {
    account: getSummary(accountGet),
    capabilities: getSummary(caps),
    wallets: getSummary(wallets),
    wallet: getSummary(walletGet),
    banks: getSummary(banks),
    payment_methods: getSummary(methods),
  };

  return {
    ok: accountGet.ok === true,
    statusCode: accountGet.ok === true ? 200 : 502,
    error: accountGet.ok === true ? undefined : 'moov_account_get_failed',
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
    verification,
    capabilities,
    wallet,
    banks: bankSummaries,
    payment_methods: methodRows.map((row) => ({
      status: row.status || null,
      paymentMethodType: row.paymentMethodType || row.type || null,
    })),
    live_gets: liveGets,
    sender_readiness: sender,
    local_snapshot_not_live_truth: true,
    auth_diagnosis: {
      account_get: accountGet.diagnosis || null,
      oauth: accountGet.diagnosis?.oauth || caps.diagnosis?.oauth || null,
      platform_account_id_configured: Boolean(secrets.credentials?.platformAccountId),
      origin_constant: 'https://checksops.com',
      api_version: secrets.credentials?.apiVersion || null,
    },
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
