import { configuredFlags, loadProviderSecrets } from './provider-secrets.mjs';

export const MOOV_SANDBOX_HOST = 'https://api.moov.io';
export const PLAID_SANDBOX_HOST = 'https://sandbox.plaid.com';
export const PLAID_PRODUCTION_HOST = 'https://production.plaid.com';
export const CHECKALT_UAT_HOST = 'https://uatapi.checkalt.com';
export const CHECKALT_UAT_MERCHANT_EXPECTED = 'lockbox5';
export const CHECKALT_UAT_AUTH_PATH = '/public/fincapture/authenticate';

export const SANDBOX_SECRET_KEYS = [
  'MOOV_SANDBOX_PUBLIC_KEY',
  'MOOV_SANDBOX_SECRET_KEY',
  'MOOV_SANDBOX_PLATFORM_ACCOUNT_ID',
  'MOOV_SANDBOX_ALLOWED_ORIGIN',
  'MOOV_SANDBOX_WEBHOOK_SECRET',
  'MOOV_SANDBOX_API_VERSION',
  'CHECKALT_UAT_BASE_URL',
  'CHECKALT_UAT_USER_ID',
  'CHECKALT_UAT_PASSWORD',
  'CHECKALT_UAT_FI_KEY',
  'CHECKALT_UAT_MERCHANT',
  'CHECKALT_UAT_DEPOSIT_ACCOUNT_NUMBER',
  'CHECKALT_SANDBOX_USERNAME',
  'CHECKALT_SANDBOX_PASSWORD',
  'CHECKALT_SANDBOX_FI_KEY',
  'CHECKALT_SANDBOX_BASE_URL',
  'CHECKALT_SANDBOX_MERCHANT',
  'CHECKALT_SANDBOX_WEBHOOK_SECRET',
  'PLAID_SANDBOX_CLIENT_ID',
  'PLAID_SANDBOX_SECRET',
  'PLAID_SANDBOX_WEBHOOK_SECRET',
];

const PRODUCTION_KEY_NAMES = [
  'MOOV_PUBLIC_KEY',
  'MOOV_SECRET_KEY',
  'MOOV_ACCOUNT_ID',
  'MOOV_WEBHOOK_SECRET',
  'CHECKALT_USERNAME',
  'CHECKALT_PASSWORD',
  'CHECKALT_FI_KEY',
  'CHECKALT_WEBHOOK_SECRET',
  'CHECKALT_BASE_URL',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_WEBHOOK_SECRET',
];

const SANDBOX_HOST_RE = /(^|\.)(sandbox|uat|test|staging|qa|dev)(-|\.|$)|sandbox|uat|fincapture-test/;

export const looksLikeSandboxHost = (value) => {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return SANDBOX_HOST_RE.test(host);
  } catch {
    return SANDBOX_HOST_RE.test(String(value).toLowerCase());
  }
};

/**
 * Approved CheckAlt UAT merchant is lockbox5.
 * A labeled secret value is accepted only if it contains lockbox5 and does not look like production.
 */
export const isApprovedCheckAltMerchant = (value) => {
  if (!value) return true;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return true;
  if (raw === CHECKALT_UAT_MERCHANT_EXPECTED) return true;
  if (raw.includes('prod')) return false;
  const segments = raw.split(/[:|/,-]+/).map((part) => part.trim()).filter(Boolean);
  if (segments.includes(CHECKALT_UAT_MERCHANT_EXPECTED)) return true;
  return raw.includes(CHECKALT_UAT_MERCHANT_EXPECTED);
};

export const merchantHeaderForCheckAltUat = (value) => {
  if (isApprovedCheckAltMerchant(value) && String(value || '').trim()) {
    const raw = String(value).trim();
    if (raw.toLowerCase() === CHECKALT_UAT_MERCHANT_EXPECTED) return CHECKALT_UAT_MERCHANT_EXPECTED;
    const match = raw.split(/[:|/,-]+/).map((part) => part.trim()).find((part) => part.toLowerCase() === CHECKALT_UAT_MERCHANT_EXPECTED);
    return match || CHECKALT_UAT_MERCHANT_EXPECTED;
  }
  return CHECKALT_UAT_MERCHANT_EXPECTED;
};

/** Approved CheckAlt FinCapture UAT only. Scheme, host, and empty path must match exactly. */
export const isApprovedCheckAltUatUrl = (value) => {
  if (!value) return false;
  try {
    const url = new URL(value);
    const pathOk = url.pathname === '/' || url.pathname === '';
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'uatapi.checkalt.com'
      && pathOk
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
};

export const normalizeCheckAltUatUrl = (value) => {
  if (!isApprovedCheckAltUatUrl(value)) return null;
  return CHECKALT_UAT_HOST;
};

const present = (secrets, key) => Boolean(secrets?.[key]);

/** Node undici / VPC-egress failures. Not a database error. */
export const isProviderNetworkError = (error) => {
  if (!error) return false;
  if (error.code === 'PROVIDER_EGRESS_FAILED') return true;
  const msg = String(error.message || '');
  const causeMsg = String(error.cause?.message || '');
  const causeCode = String(error.cause?.code || error.code || '');
  if (msg === 'fetch failed' || causeMsg === 'fetch failed') return true;
  return /^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/i.test(causeCode);
};

export const providerEgressFailure = (provider, extra = {}) => ({
  ok: false,
  statusCode: 503,
  error: 'provider_egress_failed',
  provider,
  message: 'Staging cannot reach the provider HTTPS endpoint. No production keys were used.',
  ...extra,
});

export const classifyMoovSandbox = (secrets = {}) => {
  const sandboxKeys = present(secrets, 'MOOV_SANDBOX_PUBLIC_KEY') && present(secrets, 'MOOV_SANDBOX_SECRET_KEY');
  const productionKeys = present(secrets, 'MOOV_PUBLIC_KEY') && present(secrets, 'MOOV_SECRET_KEY');
  return {
    provider: 'moov',
    available: sandboxKeys,
    reason: sandboxKeys ? 'sandbox_keys_configured' : 'sandbox_keys_missing',
    host: MOOV_SANDBOX_HOST,
    environmentDeterminedBy: 'credential_set',
    sameHostAsProduction: true,
    productionKeysPresent: productionKeys,
    platformAccountConfigured: present(secrets, 'MOOV_SANDBOX_PLATFORM_ACCOUNT_ID'),
    webhookSecretConfigured: present(secrets, 'MOOV_SANDBOX_WEBHOOK_SECRET'),
    allowedOriginConfigured: present(secrets, 'MOOV_SANDBOX_ALLOWED_ORIGIN'),
    refuseProductionKeys: true,
    safeOperationsWithoutMoney: [
      'oauth_token',
      'account_read',
      'wallet_lookup',
      'payment_method_lookup',
      'capability_lookup',
    ],
    moneyOperationsIfMapped: [
      'create_test_transfer',
      'retrieve_transfer',
      'idempotent_retry',
      'cancel_if_supported',
    ],
    note: 'Moov sandbox and production share https://api.moov.io. Only MOOV_SANDBOX_* keys may be used. Production payment_provider_accounts must not be used as sandbox account IDs.',
  };
};

export const classifyCheckAltSandbox = (secrets = {}) => {
  const uatUrl = secrets.CHECKALT_UAT_BASE_URL || null;
  const uatCreds = present(secrets, 'CHECKALT_UAT_USER_ID') && present(secrets, 'CHECKALT_UAT_PASSWORD');
  const uatUrlOk = isApprovedCheckAltUatUrl(uatUrl);
  const merchant = secrets.CHECKALT_UAT_MERCHANT || null;
  const merchantOk = isApprovedCheckAltMerchant(merchant);
  const productionCreds = present(secrets, 'CHECKALT_USERNAME') || present(secrets, 'CHECKALT_PASSWORD');
  const legacyUrl = secrets.CHECKALT_SANDBOX_BASE_URL || null;
  const legacyCreds = present(secrets, 'CHECKALT_SANDBOX_USERNAME') && present(secrets, 'CHECKALT_SANDBOX_PASSWORD');
  const available = Boolean(uatCreds && uatUrlOk && merchantOk);
  let reason = 'uat_keys_missing';
  if (uatCreds && !uatUrl) reason = 'uat_base_url_missing';
  else if (uatCreds && uatUrl && !uatUrlOk) reason = 'uat_host_refused';
  else if (uatCreds && uatUrlOk && !merchantOk) reason = 'uat_merchant_refused';
  else if (available) reason = 'uat_keys_configured';
  else if (legacyCreds && looksLikeSandboxHost(legacyUrl) && !uatCreds) reason = 'legacy_sandbox_keys_present_uat_required';
  else if (productionCreds && !uatCreds) reason = 'no_sandbox_fincapture_environment';
  return {
    provider: 'checkalt',
    available,
    reason,
    approvedHost: CHECKALT_UAT_HOST,
    approvedMerchant: CHECKALT_UAT_MERCHANT_EXPECTED,
    authPath: CHECKALT_UAT_AUTH_PATH,
    dedicatedUatUrlConfigured: Boolean(uatUrl),
    dedicatedUatUrlApproved: uatUrlOk,
    merchantConfigured: Boolean(merchant),
    merchantApproved: merchantOk,
    approvedDepositAccountConfigured: present(secrets, 'CHECKALT_UAT_DEPOSIT_ACCOUNT_NUMBER'),
    productionKeysPresent: productionCreds,
    webhookSecretConfigured: present(secrets, 'CHECKALT_SANDBOX_WEBHOOK_SECRET'),
    refuseProductionKeys: true,
    refuseUnapprovedHost: true,
    refuseNegotiableCheck: true,
    note: 'Only CHECKALT_UAT_* against https://uatapi.checkalt.com (merchant lockbox5) is allowed. Production CHECKALT_* and any other host are refused. Do not submit a negotiable check.',
  };
};

export const classifyPlaidSandbox = (secrets = {}) => {
  const sandboxKeys = (present(secrets, 'PLAID_SANDBOX_CLIENT_ID') && present(secrets, 'PLAID_SANDBOX_SECRET'))
    || (String(secrets.PLAID_ENV || '').toLowerCase() === 'sandbox'
      && present(secrets, 'PLAID_CLIENT_ID')
      && present(secrets, 'PLAID_SECRET')
      && !present(secrets, 'PLAID_SANDBOX_CLIENT_ID'));
  const dedicated = present(secrets, 'PLAID_SANDBOX_CLIENT_ID') && present(secrets, 'PLAID_SANDBOX_SECRET');
  const env = String(secrets.PLAID_ENV || '').toLowerCase();
  const productionEnv = env === 'production';
  return {
    provider: 'plaid',
    available: Boolean(dedicated || (sandboxKeys && env === 'sandbox')),
    reason: dedicated
      ? 'sandbox_keys_configured'
      : (sandboxKeys && env === 'sandbox')
        ? 'plaid_env_sandbox'
        : 'sandbox_keys_missing',
    host: PLAID_SANDBOX_HOST,
    productionHost: PLAID_PRODUCTION_HOST,
    plaidEnv: env || null,
    productionEnvBlocked: productionEnv,
    relevantToMoneyPath: false,
    note: 'Plaid Link is account-connection, not the ChecksOps deposit→disburse money path. Only sandbox.plaid.com is allowed. Do not initiate real financial movement.',
  };
};

export const sandboxCredentialSnapshot = (secrets = {}) => ({
  moov: classifyMoovSandbox(secrets),
  checkalt: classifyCheckAltSandbox(secrets),
  plaid: classifyPlaidSandbox(secrets),
  configured: configuredFlags({
    ...Object.fromEntries(SANDBOX_SECRET_KEYS.map((key) => [key, secrets[key]])),
  }),
  productionKeyNamesPresent: PRODUCTION_KEY_NAMES.filter((key) => present(secrets, key)),
});

export const loadSandboxCredentials = async (getSecrets = loadProviderSecrets) => {
  const secrets = await getSecrets();
  const snapshot = sandboxCredentialSnapshot(secrets);
  return {
    secrets,
    snapshot,
    moov: snapshot.moov.available
      ? {
        environment: 'sandbox',
        host: MOOV_SANDBOX_HOST,
        publicKey: secrets.MOOV_SANDBOX_PUBLIC_KEY,
        secretKey: secrets.MOOV_SANDBOX_SECRET_KEY,
        platformAccountId: secrets.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID || null,
        origin: secrets.MOOV_SANDBOX_ALLOWED_ORIGIN || 'https://checksops.com',
        webhookSecret: secrets.MOOV_SANDBOX_WEBHOOK_SECRET || null,
        apiVersion: secrets.MOOV_SANDBOX_API_VERSION || 'v2024.01.00',
      }
      : null,
    checkalt: snapshot.checkalt.available
      ? {
        environment: 'uat',
        baseUrl: CHECKALT_UAT_HOST,
        username: secrets.CHECKALT_UAT_USER_ID,
        userId: secrets.CHECKALT_UAT_USER_ID,
        password: secrets.CHECKALT_UAT_PASSWORD,
        fiKey: secrets.CHECKALT_UAT_FI_KEY || null,
        merchant: merchantHeaderForCheckAltUat(secrets.CHECKALT_UAT_MERCHANT),
        depositAccountNumber: secrets.CHECKALT_UAT_DEPOSIT_ACCOUNT_NUMBER || null,
        webhookSecret: secrets.CHECKALT_SANDBOX_WEBHOOK_SECRET || null,
        authPath: CHECKALT_UAT_AUTH_PATH,
      }
      : null,
    plaid: snapshot.plaid.available
      ? {
        environment: 'sandbox',
        host: PLAID_SANDBOX_HOST,
        clientId: secrets.PLAID_SANDBOX_CLIENT_ID || secrets.PLAID_CLIENT_ID,
        secret: secrets.PLAID_SANDBOX_SECRET || secrets.PLAID_SECRET,
        webhookSecret: secrets.PLAID_SANDBOX_WEBHOOK_SECRET || secrets.PLAID_WEBHOOK_SECRET || null,
      }
      : null,
  };
};

export const publicSandboxCapability = (loaded) => ({
  moov: loaded.snapshot.moov,
  checkalt: loaded.snapshot.checkalt,
  plaid: loaded.snapshot.plaid,
  productionKeyNamesPresent: loaded.snapshot.productionKeyNamesPresent,
});
