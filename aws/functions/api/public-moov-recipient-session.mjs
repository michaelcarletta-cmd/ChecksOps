/**
 * Public GET-only Moov recipient session.
 * Auth: existing pay-setup secure_token. No Cognito.
 * Never PATCH/PUT/POST Moov resources. Never consumes the token.
 */
import pg from 'pg';
import { parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, sanitizePublicError } from './db-health.mjs';
import { providerLiveReadsEnabled } from './provider-flags.mjs';
import { providerSandboxExecutionEnabled } from './sandbox-flags.mjs';
import { loadProductionMoovReadSecrets } from './providers/production/moov-secrets.mjs';
import { fingerprintMoovId, productionMoovFetch, redactMoovText } from './providers/production/moov-client.mjs';
import {
  identityRequirementsOutstanding,
  interpretRecipientBankVerification,
  kycStatusFromMoov,
  liveBankVerified,
  liveTosAccepted,
  recipientOnboardingCompleteFromMoov,
  tosRequirementOutstanding,
} from './providers/moov-recipient-tos-policy.mjs';

const { Client } = pg;

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
  'verify_bank', 'onboard', 'consume_token',
];

const failures = new Map();

const clientIp = (event) => {
  const headers = event?.headers || {};
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  return String(lower['x-forwarded-for'] || '').split(',')[0].trim()
    || lower['cf-connecting-ip']
    || event?.requestContext?.http?.sourceIp
    || 'unknown';
};

export const recipientTokenRateLimited = ({ ip, nowMs = Date.now(), windowMs = 10 * 60 * 1000, max = 30 } = {}) => {
  const key = String(ip || 'unknown');
  const hits = (failures.get(key) || []).filter((ts) => nowMs - ts < windowMs);
  failures.set(key, hits);
  return hits.length >= max;
};

export const noteRecipientTokenFailure = ({ ip, nowMs = Date.now() } = {}) => {
  const key = String(ip || 'unknown');
  const hits = failures.get(key) || [];
  hits.push(nowMs);
  failures.set(key, hits);
};

const listOf = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.capabilities)) return payload.capabilities;
  if (Array.isArray(payload?.bankAccounts)) return payload.bankAccounts;
  if (Array.isArray(payload?.paymentMethods)) return payload.paymentMethods;
  return [];
};

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: false,
  productionRead: extra.productionRead === true,
  public_recipient: true,
  cognito_required: false,
  mutated: false,
  token_consumed: false,
  ...extra,
});

const safeGet = async ({ credentials, path, scopes, fetchImpl }) => {
  try {
    const got = await productionMoovFetch({
      credentials,
      path,
      method: 'GET',
      mode: 'read',
      scopes,
      fetchImpl,
    });
    return { ok: true, status: got.status, json: got.json, error: null };
  } catch (error) {
    if (error?.code === 'read_only_method_denied' || error?.code === 'read_only_path_denied') throw error;
    return {
      ok: false,
      status: error?.status || null,
      json: null,
      error: redactMoovText(String(error.message || error)).slice(0, 200),
    };
  }
};

export async function handlePublicMoovRecipientSession(event, deps = {}) {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const ip = clientIp(event);
  const nowMs = deps.nowMs || Date.now();

  if (recipientTokenRateLimited({ ip, nowMs })) {
    return fail('recipient_token_rate_limited', 429, {
      message: 'Too many attempts. Try again later.',
      spoofFieldsIgnored: spoof,
    });
  }

  const mutations = MUTATION_KEYS.filter((key) => body[key]);
  if (mutations.length) {
    return fail('read_only_operation', 400, {
      fields: mutations,
      message: 'Recipient session reads cannot create accounts, accept ToS, add banks, or move money.',
      spoofFieldsIgnored: spoof,
    });
  }

  const untrusted = UNTRUSTED_MOOV_KEYS.filter((key) => body[key] !== undefined && body[key] !== null);
  if (untrusted.length) {
    return fail('untrusted_provider_config', 400, {
      fields: untrusted,
      message: 'Moov account ids are server-derived. Browser values are rejected.',
      spoofFieldsIgnored: spoof,
    });
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return fail('token_required', 400, {
      message: 'token is required',
      spoofFieldsIgnored: spoof,
    });
  }

  if (!providerLiveReadsEnabled() || providerSandboxExecutionEnabled()) {
    return fail('production_read_blocked', 403, {
      message: 'Production Moov live reads are not enabled for this public session.',
      spoofFieldsIgnored: spoof,
    });
  }

  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  const createClient = deps.createClient || ((config) => new Client(config));
  let client;
  let owned = false;
  try {
    if (deps.client) {
      client = deps.client;
    } else {
      const credentials = await loadCredentials();
      client = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 12000 }));
      await client.connect();
      owned = true;
    }
    await client.query('BEGIN');

    const recipient = (await client.query(
      `SELECT id, tenant_id, display_name, provider_account_id, token_expires_at, token_used_at,
              onboarding_status, environment, bank_linked_at, provider_bank_name, provider_last_four
       FROM public.external_payment_recipients
       WHERE provider = 'moov' AND secure_token = $1
       LIMIT 1`,
      [token],
    )).rows[0];

    if (!recipient) {
      noteRecipientTokenFailure({ ip, nowMs });
      await client.query('ROLLBACK');
      return fail('This link is not valid.', 404, { spoofFieldsIgnored: spoof });
    }
    if (recipient.token_used_at) {
      noteRecipientTokenFailure({ ip, nowMs });
      await client.query('ROLLBACK');
      return fail('This link has already been used. Ask the sender for a new one.', 410, {
        spoofFieldsIgnored: spoof,
      });
    }
    if (recipient.token_expires_at && new Date(recipient.token_expires_at).getTime() < nowMs) {
      noteRecipientTokenFailure({ ip, nowMs });
      await client.query('ROLLBACK');
      return fail('This link has expired. Ask the sender for a new one.', 410, {
        spoofFieldsIgnored: spoof,
      });
    }
    if (String(recipient.environment || '').toLowerCase() !== 'production') {
      await client.query('ROLLBACK');
      return fail('This payment setup is not ready yet. Try again shortly.', 409, {
        spoofFieldsIgnored: spoof,
      });
    }
    if (!recipient.provider_account_id) {
      await client.query('ROLLBACK');
      return fail('This payment setup is not ready yet. Try again shortly.', 409, {
        spoofFieldsIgnored: spoof,
      });
    }

    const tenant = (await client.query(
      `SELECT name, logo_url, primary_color, secondary_color
       FROM public.tenants WHERE id = $1::uuid LIMIT 1`,
      [recipient.tenant_id],
    )).rows[0] || null;

    const secrets = await (deps.loadProductionReadSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
    if (!secrets.ok) {
      await client.query('ROLLBACK');
      return { ...secrets, public_recipient: true, cognito_required: false, mutated: false, token_consumed: false, spoofFieldsIgnored: spoof };
    }

    const accountId = recipient.provider_account_id;
    const fetchImpl = deps.fetchImpl || fetch;
    const accountGet = await safeGet({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}`,
      scopes: [`/accounts/${accountId}/profile.read`],
      fetchImpl,
    });
    if (!accountGet.ok) {
      await client.query('ROLLBACK');
      return fail('moov_account_get_failed', accountGet.status && accountGet.status >= 400 ? accountGet.status : 502, {
        liveProviderCalled: true,
        productionRead: true,
        message: 'Could not load the payment-provider account.',
        spoofFieldsIgnored: spoof,
      });
    }

    const capsGet = await safeGet({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}/capabilities`,
      scopes: [`/accounts/${accountId}/capabilities.read`],
      fetchImpl,
    });
    const banksGet = await safeGet({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}/bank-accounts`,
      scopes: [`/accounts/${accountId}/bank-accounts.read`],
      fetchImpl,
    });
    const methodsGet = await safeGet({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}/payment-methods`,
      scopes: [`/accounts/${accountId}/payment-methods.read`],
      fetchImpl,
    });

    const account = accountGet.json || {};
    const capabilities = listOf(capsGet.json);
    const banks = listOf(banksGet.json);
    const paymentMethods = listOf(methodsGet.json);
    const capabilitiesReadOk = capsGet.ok === true;
    const verificationStatus = kycStatusFromMoov(account);
    const tosAccepted = liveTosAccepted(account);
    const tosOutstanding = capabilitiesReadOk ? tosRequirementOutstanding(capabilities) : true;
    const identityOutstanding = capabilitiesReadOk ? identityRequirementsOutstanding(capabilities) : [];
    const bankVerified = liveBankVerified(banks);
    const bankState = interpretRecipientBankVerification({ bank: banks[0] || null, verification: null });
    const complete = recipientOnboardingCompleteFromMoov({
      account,
      banks,
      capabilities,
      capabilitiesReadOk,
    });
    const status = complete
      ? 'ready'
      : (tosAccepted || !tosOutstanding
        ? (verificationStatus === 'verified' ? 'awaiting_bank' : 'kyc_pending')
        : 'awaiting_kyc');

    await client.query('ROLLBACK');

    return {
      ok: true,
      success: true,
      statusCode: 200,
      provider: 'moov',
      liveProviderCalled: true,
      productionExecution: false,
      productionRead: true,
      public_recipient: true,
      cognito_required: false,
      mutated: false,
      created: false,
      token_consumed: false,
      recipient: {
        id: recipient.id,
        name: recipient.display_name,
        status,
        bank_linked: banks.length > 0,
        bank_name: recipient.provider_bank_name ?? banks[0]?.bankName ?? null,
        last_four: recipient.provider_last_four
          ?? banks[0]?.lastFourAccountNumber
          ?? banks[0]?.lastFour
          ?? null,
      },
      onboarding: {
        terms_accepted: tosAccepted,
        tos_requirement_outstanding: tosOutstanding,
        verification_status: verificationStatus,
        identity_requirements_outstanding: identityOutstanding,
        identity_requirements_known: capabilitiesReadOk,
        bank_verified: bankVerified,
        bank_status: bankState.bank_status,
        bank_verification_method: bankState.method,
        bank_verification_status: bankState.verification_status,
        bank_micro_deposits_initiated: bankState.initiated,
        bank_can_confirm: bankState.can_confirm,
        bank_should_initiate: bankState.should_initiate,
        complete,
        live: true,
        payment_method_count: paymentMethods.length,
      },
      payer: {
        name: tenant?.name ?? 'ChecksOps',
        logo_url: tenant?.logo_url ?? null,
        primary_color: tenant?.primary_color ?? null,
        secondary_color: tenant?.secondary_color ?? null,
      },
      account_id: accountId,
      account_id_fp: fingerprintMoovId(accountId),
      environment: 'production',
      token: null,
      drop: 'moov-terms-of-service',
      public_key: null,
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    if (error?.code === 'read_only_method_denied' || error?.code === 'read_only_path_denied') {
      return fail(error.code, 403, {
        productionRead: true,
        message: redactMoovText(error.message),
        spoofFieldsIgnored: spoof,
      });
    }
    return fail('recipient_session_failed', 503, {
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    });
  } finally {
    if (owned && client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}
