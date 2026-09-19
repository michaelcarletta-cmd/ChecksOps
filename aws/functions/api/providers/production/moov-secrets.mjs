import { loadProviderSecrets } from '../../provider-secrets.mjs';

export const PRODUCTION_MOOV_SECRET_ID = 'checksops/production/providers';
export const PRODUCTION_MOOV_ORIGIN = 'https://checksops.com';
export const PRODUCTION_MOOV_HOST = 'https://api.moov.io';
export const PRODUCTION_MOOV_API_VERSION = 'v2024.01.00';

/** Full money-execution contract. Do not weaken. */
export const PRODUCTION_MOOV_SECRET_NAMES = Object.freeze([
  'MOOV_PUBLIC_KEY',
  'MOOV_SECRET_KEY',
  'MOOV_PLATFORM_ACCOUNT_ID',
  'MOOV_WEBHOOK_SECRET',
  'MOOV_ENVIRONMENT',
  'MOOV_ALLOWED_ORIGIN',
]);

/**
 * M3.1 GET-only minimum. Moov OAuth client_credentials needs public/secret.
 * This integration's token request still requires Origin (missing Origin → 401).
 * Webhook secret is not used for GET. Platform account id is not required to
 * GET a tenant connected account; it is required to GET facilitator transfers.
 */
export const PRODUCTION_MOOV_READ_SECRET_NAMES = Object.freeze([
  'MOOV_PUBLIC_KEY',
  'MOOV_SECRET_KEY',
  'MOOV_ENVIRONMENT',
  'MOOV_ALLOWED_ORIGIN',
]);

export const SANDBOX_MOOV_SECRET_NAMES = Object.freeze([
  'MOOV_SANDBOX_PUBLIC_KEY',
  'MOOV_SANDBOX_SECRET_KEY',
  'MOOV_SANDBOX_PLATFORM_ACCOUNT_ID',
  'MOOV_SANDBOX_ALLOWED_ORIGIN',
  'MOOV_SANDBOX_WEBHOOK_SECRET',
  'MOOV_SANDBOX_API_VERSION',
]);

export const REFUSED_FACILITATOR_NAME = 'MOOV_ACCOUNT_ID';

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

export const isApprovedProductionMoovOrigin = (value) => (
  normalizeOrigin(value) === PRODUCTION_MOOV_ORIGIN
);

export const productionSecretMissing = (extra = {}) => ({
  ok: false,
  statusCode: 503,
  error: 'production_secret_missing',
  provider: 'moov',
  liveProviderCalled: false,
  productionExecution: false,
  secretId: PRODUCTION_MOOV_SECRET_ID,
  requiredNames: [...PRODUCTION_MOOV_SECRET_NAMES],
  message: 'Production Moov secrets are absent. Fail closed. Sandbox keys cannot satisfy this path.',
  ...extra,
});

const sandboxContamination = (secrets = {}) => {
  const productionValues = PRODUCTION_MOOV_SECRET_NAMES
    .filter((key) => present(secrets, key))
    .map((key) => String(secrets[key]).trim());
  const hits = [];
  for (const name of SANDBOX_MOOV_SECRET_NAMES) {
    if (!present(secrets, name)) continue;
    const value = String(secrets[name]).trim();
    if (productionValues.includes(value)) hits.push(name);
  }
  const stagingWebhook = String(process.env.AWS_MOOV_WEBHOOK_SECRET || '').trim();
  if (stagingWebhook && present(secrets, 'MOOV_WEBHOOK_SECRET')
    && stagingWebhook === String(secrets.MOOV_WEBHOOK_SECRET).trim()) {
    hits.push('AWS_MOOV_WEBHOOK_SECRET');
  }
  return hits;
};

export const classifyProductionMoovSecrets = (secrets = {}) => {
  const missing = PRODUCTION_MOOV_SECRET_NAMES.filter((key) => !present(secrets, key));
  const missingRead = PRODUCTION_MOOV_READ_SECRET_NAMES.filter((key) => !present(secrets, key));
  const sandboxPresent = SANDBOX_MOOV_SECRET_NAMES.filter((key) => present(secrets, key));
  const environment = String(secrets.MOOV_ENVIRONMENT || '').trim().toLowerCase();
  const origin = normalizeOrigin(secrets.MOOV_ALLOWED_ORIGIN);
  const contamination = sandboxContamination(secrets);
  return {
    provider: 'moov',
    environment: 'production',
    secretId: PRODUCTION_MOOV_SECRET_ID,
    providerSecretsArnConfigured: Boolean(process.env.PROVIDER_SECRETS_ARN),
    requiredNames: [...PRODUCTION_MOOV_SECRET_NAMES],
    readRequiredNames: [...PRODUCTION_MOOV_READ_SECRET_NAMES],
    missingNames: missing,
    missingReadNames: missingRead,
    sandboxNamesPresent: sandboxPresent,
    refusedFacilitatorName: REFUSED_FACILITATOR_NAME,
    facilitatorName: 'MOOV_PLATFORM_ACCOUNT_ID',
    productionKeysComplete: missing.length === 0,
    productionReadKeysComplete: missingRead.length === 0,
    environmentIsProduction: environment === 'production',
    originApproved: origin === PRODUCTION_MOOV_ORIGIN,
    originValueHost: origin,
    sandboxContamination: contamination,
    sandboxCannotSatisfyProduction: true,
    awsWebhookFallbackRefused: true,
    webhookRequiredForExecution: true,
    webhookRequiredForRead: false,
    platformAccountRequiredForExecution: true,
    platformAccountRequiredForAccountGet: false,
  };
};

export const loadProductionMoovWebhookSecret = (secrets = {}) => {
  if (!present(secrets, 'MOOV_WEBHOOK_SECRET')) return null;
  return String(secrets.MOOV_WEBHOOK_SECRET).trim();
};

const refuseSnapshot = (snapshot, extra = {}) => {
  if (!snapshot.environmentIsProduction) {
    return {
      ok: false,
      statusCode: 503,
      error: 'production_environment_refused',
      provider: 'moov',
      liveProviderCalled: false,
      productionExecution: false,
      productionRead: false,
      reason: 'MOOV_ENVIRONMENT_not_production',
      message: 'MOOV_ENVIRONMENT must equal production. Sandbox is refused.',
      ...extra,
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
      productionRead: false,
      reason: 'unapproved_origin',
      message: 'MOOV_ALLOWED_ORIGIN must be https://checksops.com. Staging/sandbox origins are refused.',
      ...extra,
    };
  }
  if (snapshot.sandboxContamination.length) {
    return {
      ok: false,
      statusCode: 503,
      error: 'sandbox_credential_contamination',
      provider: 'moov',
      liveProviderCalled: false,
      productionExecution: false,
      productionRead: false,
      contaminatedNames: snapshot.sandboxContamination,
      message: 'Sandbox or staging credential values cannot satisfy production Moov.',
      ...extra,
    };
  }
  return null;
};

const credentialsFromSecrets = (secrets, snapshot) => ({
  environment: 'production',
  host: PRODUCTION_MOOV_HOST,
  publicKey: secrets.MOOV_PUBLIC_KEY,
  secretKey: secrets.MOOV_SECRET_KEY,
  platformAccountId: present(secrets, 'MOOV_PLATFORM_ACCOUNT_ID')
    ? String(secrets.MOOV_PLATFORM_ACCOUNT_ID).trim()
    : null,
  origin: PRODUCTION_MOOV_ORIGIN,
  webhookSecretConfigured: present(secrets, 'MOOV_WEBHOOK_SECRET'),
  apiVersion: PRODUCTION_MOOV_API_VERSION,
  snapshot,
});

export const loadProductionMoovReadSecrets = async (getSecrets = loadProviderSecrets) => {
  const arn = process.env.PROVIDER_SECRETS_ARN;
  if (!arn) {
    return {
      ok: false,
      ...productionSecretMissing({
        reason: 'PROVIDER_SECRETS_ARN_unset',
        requiredNames: [...PRODUCTION_MOOV_READ_SECRET_NAMES],
        contract: 'read',
      }),
    };
  }
  let secrets;
  try {
    secrets = await getSecrets();
  } catch {
    return {
      ok: false,
      ...productionSecretMissing({ reason: 'secret_load_failed', contract: 'read' }),
    };
  }
  const snapshot = classifyProductionMoovSecrets(secrets);
  if (!snapshot.productionReadKeysComplete) {
    return {
      ok: false,
      ...productionSecretMissing({
        reason: 'required_read_names_missing',
        missingNames: snapshot.missingReadNames,
        requiredNames: [...PRODUCTION_MOOV_READ_SECRET_NAMES],
        sandboxNamesPresent: snapshot.sandboxNamesPresent,
        contract: 'read',
      }),
    };
  }
  const refused = refuseSnapshot(snapshot);
  if (refused) return refused;
  return {
    ok: true,
    contract: 'read',
    snapshot,
    credentials: credentialsFromSecrets(secrets, snapshot),
  };
};

const sandboxCredentialsFromSecrets = (secrets) => ({
  environment: 'sandbox',
  host: PRODUCTION_MOOV_HOST,
  publicKey: secrets.MOOV_SANDBOX_PUBLIC_KEY,
  secretKey: secrets.MOOV_SANDBOX_SECRET_KEY,
  platformAccountId: present(secrets, 'MOOV_SANDBOX_PLATFORM_ACCOUNT_ID')
    ? String(secrets.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID).trim()
    : null,
  origin: present(secrets, 'MOOV_SANDBOX_ALLOWED_ORIGIN')
    ? String(secrets.MOOV_SANDBOX_ALLOWED_ORIGIN).trim()
    : PRODUCTION_MOOV_ORIGIN,
  webhookSecretConfigured: present(secrets, 'MOOV_SANDBOX_WEBHOOK_SECRET'),
  apiVersion: present(secrets, 'MOOV_SANDBOX_API_VERSION')
    ? String(secrets.MOOV_SANDBOX_API_VERSION).trim()
    : PRODUCTION_MOOV_API_VERSION,
});

/** Sandbox-only credential path. Never copies production key values into the returned object. */
export const loadSandboxMoovReadSecrets = async (getSecrets = loadProviderSecrets) => {
  const arn = process.env.PROVIDER_SECRETS_ARN;
  if (!arn) {
    return {
      ok: false,
      statusCode: 503,
      error: 'sandbox_secret_missing',
      provider: 'moov',
      environment: 'sandbox',
      secretNames: [...SANDBOX_MOOV_SECRET_NAMES],
      configured: false,
      message: 'Sandbox Moov secrets are absent. Production keys cannot satisfy this path.',
    };
  }
  let secrets;
  try {
    secrets = await getSecrets();
  } catch {
    return {
      ok: false,
      statusCode: 503,
      error: 'sandbox_secret_missing',
      provider: 'moov',
      environment: 'sandbox',
      configured: false,
    };
  }
  if (!present(secrets, 'MOOV_SANDBOX_PUBLIC_KEY') || !present(secrets, 'MOOV_SANDBOX_SECRET_KEY')) {
    return {
      ok: false,
      statusCode: 503,
      error: 'sandbox_secret_missing',
      provider: 'moov',
      environment: 'sandbox',
      secretNames: ['MOOV_SANDBOX_PUBLIC_KEY', 'MOOV_SANDBOX_SECRET_KEY'],
      configured: false,
      message: 'Sandbox Moov secrets are absent. Production keys cannot satisfy this path.',
    };
  }
  return {
    ok: true,
    contract: 'read',
    environment: 'sandbox',
    configured: true,
    secretNames: [...SANDBOX_MOOV_SECRET_NAMES],
    credentials: sandboxCredentialsFromSecrets(secrets),
  };
};

export const loadProductionMoovSecrets = async (getSecrets = loadProviderSecrets) => {
  const arn = process.env.PROVIDER_SECRETS_ARN;
  if (!arn) {
    return {
      ok: false,
      ...productionSecretMissing({ reason: 'PROVIDER_SECRETS_ARN_unset', contract: 'execute' }),
    };
  }
  let secrets;
  try {
    secrets = await getSecrets();
  } catch {
    return {
      ok: false,
      ...productionSecretMissing({ reason: 'secret_load_failed', contract: 'execute' }),
    };
  }
  const snapshot = classifyProductionMoovSecrets(secrets);
  if (!snapshot.productionKeysComplete) {
    return {
      ok: false,
      ...productionSecretMissing({
        reason: snapshot.missingNames.length ? 'required_names_missing' : 'incomplete',
        missingNames: snapshot.missingNames,
        sandboxNamesPresent: snapshot.sandboxNamesPresent,
        contract: 'execute',
      }),
    };
  }
  const refused = refuseSnapshot(snapshot);
  if (refused) return refused;
  return {
    ok: true,
    contract: 'execute',
    snapshot,
    credentials: {
      ...credentialsFromSecrets(secrets, snapshot),
      platformAccountId: String(secrets.MOOV_PLATFORM_ACCOUNT_ID).trim(),
    },
  };
};
