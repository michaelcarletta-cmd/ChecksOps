import { loadProviderSecrets } from '../../provider-secrets.mjs';

export const PRODUCTION_MOOV_SECRET_ID = 'checksops/production/providers';

export const PRODUCTION_MOOV_HTTP_SECRET_NAMES = Object.freeze([
  'MOOV_PUBLIC_KEY',
  'MOOV_SECRET_KEY',
]);

const present = (secrets, key) => {
  const value = secrets?.[key];
  return typeof value === 'string' && value.trim().length > 0;
};

export const classifyProductionMoovSecrets = (secrets = {}) => {
  const missingHttp = PRODUCTION_MOOV_HTTP_SECRET_NAMES.filter((key) => !present(secrets, key));
  const environment = String(secrets.MOOV_ENVIRONMENT || '').toLowerCase();
  const sandboxKeysPresent = present(secrets, 'MOOV_SANDBOX_PUBLIC_KEY')
    || present(secrets, 'MOOV_SANDBOX_SECRET_KEY');
  return {
    provider: 'moov',
    environment: 'production',
    secretId: PRODUCTION_MOOV_SECRET_ID,
    providerSecretsArnConfigured: Boolean(process.env.PROVIDER_SECRETS_ARN),
    requiredNames: [...PRODUCTION_MOOV_HTTP_SECRET_NAMES],
    missingNames: missingHttp,
    productionKeysComplete: missingHttp.length === 0,
    declaredEnvironment: environment || null,
    productionEnvironmentDeclared: environment === 'production',
    sandboxKeysCannotSatisfyProduction: true,
    sandboxKeysPresent,
  };
};

const secretMissing = (extra = {}) => ({
  ok: false,
  statusCode: 503,
  error: 'production_secret_missing',
  provider: 'moov',
  liveProviderCalled: false,
  productionExecution: false,
  secretId: PRODUCTION_MOOV_SECRET_ID,
  requiredNames: [...PRODUCTION_MOOV_HTTP_SECRET_NAMES],
  message: 'Production Moov secrets are absent. Fail closed. Sandbox keys cannot satisfy this path.',
  ...extra,
});

export const loadProductionMoovSecrets = async (getSecrets = loadProviderSecrets) => {
  const arn = process.env.PROVIDER_SECRETS_ARN;
  if (!arn) {
    return { ok: false, ...secretMissing({ reason: 'PROVIDER_SECRETS_ARN_unset' }) };
  }
  let secrets;
  try {
    secrets = await getSecrets();
  } catch {
    return { ok: false, ...secretMissing({ reason: 'secret_load_failed' }) };
  }
  const snapshot = classifyProductionMoovSecrets(secrets);
  if (!snapshot.productionKeysComplete) {
    return {
      ok: false,
      ...secretMissing({
        reason: snapshot.missingNames.length ? 'required_names_missing' : 'incomplete',
        missingNames: snapshot.missingNames,
      }),
    };
  }
  if (!snapshot.productionEnvironmentDeclared) {
    return {
      ok: false,
      statusCode: 503,
      error: 'production_environment_refused',
      provider: 'moov',
      liveProviderCalled: false,
      productionExecution: false,
      message: 'MOOV_ENVIRONMENT is not production. Sandbox credentials cannot satisfy this path.',
    };
  }
  return {
    ok: true,
    snapshot,
    credentials: {
      environment: 'production',
      publicKey: secrets.MOOV_PUBLIC_KEY,
      secretKey: secrets.MOOV_SECRET_KEY,
      platformAccountId: secrets.MOOV_ACCOUNT_ID || null,
    },
  };
};

export const productionMoovContext = (credentials, fetchImpl) => ({
  environment: 'production',
  productionPublicKey: credentials.publicKey,
  productionSecretKey: credentials.secretKey,
  productionPlatformAccountId: credentials.platformAccountId || null,
  sandboxPublicKey: null,
  sandboxSecretKey: null,
  sandboxPlatformAccountId: null,
  allowedOrigin: 'https://checksops.com',
  appUrl: 'https://checksops.com',
  apiVersion: 'v2024.01.00',
  fetchImpl,
});
