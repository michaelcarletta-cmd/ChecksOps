import { loadProviderSecrets } from '../../provider-secrets.mjs';

export const PRODUCTION_MOOV_SECRET_ID = 'checksops/production/providers';
export const PRODUCTION_MOOV_ORIGIN = 'https://checksops.com';
export const PRODUCTION_MOOV_HOST = 'https://api.moov.io';
export const PRODUCTION_MOOV_API_VERSION = 'v2024.01.00';

export const PRODUCTION_MOOV_READ_SECRET_NAMES = Object.freeze([
  'MOOV_PUBLIC_KEY',
  'MOOV_SECRET_KEY',
  'MOOV_ENVIRONMENT',
  'MOOV_ALLOWED_ORIGIN',
]);

const present = (secrets, key) => {
  const value = secrets?.[key];
  return typeof value === 'string' && value.trim().length > 0;
};

const normalizeOrigin = (value) => {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
};

export const productionMoovSecretMissing = (extra = {}) => ({
  ok: false,
  statusCode: 503,
  error: 'production_secret_missing',
  provider: 'moov',
  liveProviderCalled: false,
  productionExecution: false,
  secretId: PRODUCTION_MOOV_SECRET_ID,
  requiredNames: [...PRODUCTION_MOOV_READ_SECRET_NAMES],
  message: 'Production Moov secrets are absent. Fail closed. Sandbox keys cannot satisfy this path.',
  ...extra,
});

export const classifyProductionMoovSecrets = (secrets = {}) => {
  const missingRead = PRODUCTION_MOOV_READ_SECRET_NAMES.filter((key) => !present(secrets, key));
  const environment = String(secrets.MOOV_ENVIRONMENT || '').trim().toLowerCase();
  const origin = normalizeOrigin(secrets.MOOV_ALLOWED_ORIGIN);
  return {
    provider: 'moov',
    environment: 'production',
    secretId: PRODUCTION_MOOV_SECRET_ID,
    providerSecretsArnConfigured: Boolean(process.env.PROVIDER_SECRETS_ARN),
    readRequiredNames: [...PRODUCTION_MOOV_READ_SECRET_NAMES],
    missingReadNames: missingRead,
    productionReadKeysComplete: missingRead.length === 0,
    environmentIsProduction: environment === 'production',
    originApproved: origin === PRODUCTION_MOOV_ORIGIN,
    originValueHost: origin,
    platformAccountIdPresent: present(secrets, 'MOOV_PLATFORM_ACCOUNT_ID'),
  };
};

export const loadProductionMoovReadSecrets = async (getSecrets = loadProviderSecrets) => {
  const arn = process.env.PROVIDER_SECRETS_ARN;
  if (!arn) {
    return productionMoovSecretMissing({ reason: 'PROVIDER_SECRETS_ARN_unset' });
  }
  let secrets;
  try {
    secrets = await getSecrets();
  } catch {
    return productionMoovSecretMissing({ reason: 'secret_unreadable' });
  }
  const snapshot = classifyProductionMoovSecrets(secrets);
  if (!snapshot.productionReadKeysComplete) {
    return productionMoovSecretMissing({
      reason: 'read_names_missing',
      missingNames: snapshot.missingReadNames,
    });
  }
  if (!snapshot.environmentIsProduction) {
    return {
      ok: false,
      statusCode: 503,
      error: 'production_environment_refused',
      provider: 'moov',
      liveProviderCalled: false,
      productionExecution: false,
      reason: 'MOOV_ENVIRONMENT_not_production',
      message: 'MOOV_ENVIRONMENT must equal production. Sandbox is refused.',
    };
  }
  if (!snapshot.originApproved) {
    return {
      ok: false,
      statusCode: 503,
      error: 'production_origin_refused',
      provider: 'moov',
      liveProviderCalled: false,
      productionExecution: false,
      reason: 'unapproved_origin',
      message: 'MOOV_ALLOWED_ORIGIN must be https://checksops.com. Staging/sandbox origins are refused.',
    };
  }
  return {
    ok: true,
    credentials: {
      environment: 'production',
      host: PRODUCTION_MOOV_HOST,
      publicKey: String(secrets.MOOV_PUBLIC_KEY).trim(),
      secretKey: String(secrets.MOOV_SECRET_KEY).trim(),
      origin: PRODUCTION_MOOV_ORIGIN,
      apiVersion: PRODUCTION_MOOV_API_VERSION,
      platformAccountId: present(secrets, 'MOOV_PLATFORM_ACCOUNT_ID')
        ? String(secrets.MOOV_PLATFORM_ACCOUNT_ID).trim()
        : null,
    },
    snapshot,
  };
};
