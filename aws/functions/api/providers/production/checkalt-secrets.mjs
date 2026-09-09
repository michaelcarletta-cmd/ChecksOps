import { loadProviderSecrets } from '../../provider-secrets.mjs';
import { CHECKALT_UAT_HOST, looksLikeSandboxHost } from '../../sandbox-credentials.mjs';

export const PRODUCTION_CHECKALT_SECRET_ID = 'checksops/production/providers';

export const PRODUCTION_CHECKALT_SECRET_NAMES = Object.freeze([
  'CHECKALT_USERNAME',
  'CHECKALT_PASSWORD',
  'CHECKALT_FI_KEY',
  'CHECKALT_BASE_URL',
  'CHECKALT_WEBHOOK_SECRET',
]);

export const UAT_CHECKALT_SECRET_NAMES = Object.freeze([
  'CHECKALT_UAT_BASE_URL',
  'CHECKALT_UAT_USER_ID',
  'CHECKALT_UAT_PASSWORD',
  'CHECKALT_UAT_FI_KEY',
  'CHECKALT_UAT_MERCHANT',
  'CHECKALT_SANDBOX_USERNAME',
  'CHECKALT_SANDBOX_PASSWORD',
  'CHECKALT_SANDBOX_FI_KEY',
  'CHECKALT_SANDBOX_BASE_URL',
  'CHECKALT_SANDBOX_MERCHANT',
]);

const present = (secrets, key) => {
  const value = secrets?.[key];
  return typeof value === 'string' && value.trim().length > 0;
};

export const isApprovedCheckAltProductionUrl = (value) => {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const pathOk = url.pathname === '/' || url.pathname === '';
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password || url.search || url.hash) return false;
    if (!pathOk) return false;
    if (host === 'uatapi.checkalt.com') return false;
    if (looksLikeSandboxHost(value)) return false;
    return host === 'api.checkalt.com'
      || host === 'api2.checkalt.com'
      || (host.endsWith('.checkalt.com') && !host.includes('uat') && !host.includes('sandbox'));
  } catch {
    return false;
  }
};

export const normalizeProductionCheckAltUrl = (value) => {
  if (!isApprovedCheckAltProductionUrl(value)) return null;
  return String(value).replace(/\/$/, '');
};

export const productionSecretMissing = (extra = {}) => ({
  ok: false,
  statusCode: 503,
  error: 'production_secret_missing',
  provider: 'checkalt',
  liveProviderCalled: false,
  productionExecution: false,
  secretId: PRODUCTION_CHECKALT_SECRET_ID,
  requiredNames: [...PRODUCTION_CHECKALT_SECRET_NAMES],
  message: 'Production CheckAlt secrets are absent. Fail closed. UAT keys cannot satisfy this path.',
  ...extra,
});

export const classifyProductionCheckAltSecrets = (secrets = {}) => {
  const missing = PRODUCTION_CHECKALT_SECRET_NAMES.filter((key) => !present(secrets, key));
  const uatPresent = UAT_CHECKALT_SECRET_NAMES.filter((key) => present(secrets, key));
  const baseUrl = secrets.CHECKALT_BASE_URL || null;
  const baseUrlOk = isApprovedCheckAltProductionUrl(baseUrl);
  const uatHostUsed = String(baseUrl || '').replace(/\/$/, '') === CHECKALT_UAT_HOST
    || looksLikeSandboxHost(baseUrl);
  return {
    provider: 'checkalt',
    environment: 'production',
    secretId: PRODUCTION_CHECKALT_SECRET_ID,
    providerSecretsArnConfigured: Boolean(process.env.PROVIDER_SECRETS_ARN),
    requiredNames: [...PRODUCTION_CHECKALT_SECRET_NAMES],
    missingNames: missing,
    uatNamesPresent: uatPresent,
    productionKeysComplete: missing.length === 0,
    baseUrlApproved: baseUrlOk,
    refusedUatHost: Boolean(uatHostUsed),
    uatCannotSatisfyProduction: true,
  };
};

export const loadProductionCheckAltSecrets = async (getSecrets = loadProviderSecrets) => {
  const arn = process.env.PROVIDER_SECRETS_ARN;
  if (!arn) {
    return {
      ok: false,
      ...productionSecretMissing({ reason: 'PROVIDER_SECRETS_ARN_unset' }),
    };
  }
  let secrets;
  try {
    secrets = await getSecrets();
  } catch {
    return {
      ok: false,
      ...productionSecretMissing({ reason: 'secret_load_failed' }),
    };
  }
  const snapshot = classifyProductionCheckAltSecrets(secrets);
  if (!snapshot.productionKeysComplete) {
    return {
      ok: false,
      ...productionSecretMissing({
        reason: snapshot.missingNames.length ? 'required_names_missing' : 'incomplete',
        missingNames: snapshot.missingNames,
        uatNamesPresent: snapshot.uatNamesPresent,
      }),
    };
  }
  if (!snapshot.baseUrlApproved || snapshot.refusedUatHost) {
    return {
      ok: false,
      statusCode: 503,
      error: 'production_host_refused',
      provider: 'checkalt',
      liveProviderCalled: false,
      productionExecution: false,
      reason: snapshot.refusedUatHost ? 'uat_host_refused' : 'unapproved_host',
      message: 'CHECKALT_BASE_URL is not an approved production FinCapture host. UAT is refused.',
    };
  }
  return {
    ok: true,
    snapshot,
    credentials: {
      environment: 'production',
      username: secrets.CHECKALT_USERNAME,
      password: secrets.CHECKALT_PASSWORD,
      fiKey: secrets.CHECKALT_FI_KEY,
      baseUrl: normalizeProductionCheckAltUrl(secrets.CHECKALT_BASE_URL),
      webhookSecretConfigured: present(secrets, 'CHECKALT_WEBHOOK_SECRET'),
    },
  };
};
