import { configuredFlags, loadProviderSecrets } from './provider-secrets.mjs';

export const MOOV_SANDBOX_HOST = 'https://api.moov.io';
export const PLAID_SANDBOX_HOST = 'https://sandbox.plaid.com';
export const PLAID_PRODUCTION_HOST = 'https://production.plaid.com';

export const SANDBOX_SECRET_KEYS = [
  'MOOV_SANDBOX_PUBLIC_KEY',
  'MOOV_SANDBOX_SECRET_KEY',
  'MOOV_SANDBOX_PLATFORM_ACCOUNT_ID',
  'MOOV_SANDBOX_ALLOWED_ORIGIN',
  'MOOV_SANDBOX_WEBHOOK_SECRET',
  'MOOV_SANDBOX_API_VERSION',
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

const present = (secrets, key) => Boolean(secrets?.[key]);

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
  const url = secrets.CHECKALT_SANDBOX_BASE_URL || null;
  const sandboxCreds = present(secrets, 'CHECKALT_SANDBOX_USERNAME')
    && present(secrets, 'CHECKALT_SANDBOX_PASSWORD');
  const urlOk = looksLikeSandboxHost(url);
  const productionCreds = present(secrets, 'CHECKALT_USERNAME') || present(secrets, 'CHECKALT_PASSWORD');
  const available = Boolean(sandboxCreds && urlOk);
  let reason = 'no_sandbox_fincapture_environment';
  if (sandboxCreds && !url) reason = 'sandbox_base_url_missing';
  else if (sandboxCreds && url && !urlOk) reason = 'sandbox_base_url_not_test_host';
  else if (available) reason = 'sandbox_keys_configured';
  return {
    provider: 'checkalt',
    available,
    reason,
    dedicatedSandboxUrlConfigured: Boolean(url),
    dedicatedSandboxUrlLooksLikeTest: urlOk,
    productionKeysPresent: productionCreds,
    webhookSecretConfigured: present(secrets, 'CHECKALT_SANDBOX_WEBHOOK_SECRET'),
    refuseProductionKeys: true,
    refuseNegotiableCheck: true,
    note: 'CheckAlt/FinCapture has no first-class sandbox key names in production code. A dedicated CHECKALT_SANDBOX_BASE_URL on a test/UAT host is required. Production FinCapture credentials must not be used. Do not submit a negotiable check.',
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
        environment: 'sandbox',
        baseUrl: String(secrets.CHECKALT_SANDBOX_BASE_URL).replace(/\/$/, ''),
        username: secrets.CHECKALT_SANDBOX_USERNAME,
        password: secrets.CHECKALT_SANDBOX_PASSWORD,
        fiKey: secrets.CHECKALT_SANDBOX_FI_KEY || null,
        merchant: secrets.CHECKALT_SANDBOX_MERCHANT || null,
        webhookSecret: secrets.CHECKALT_SANDBOX_WEBHOOK_SECRET || null,
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
