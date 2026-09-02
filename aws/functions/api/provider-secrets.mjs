import { getSecretStringFromAws } from './secrets.mjs';

const SECRET_KEYS = [
  'MOOV_PUBLIC_KEY',
  'MOOV_SECRET_KEY',
  'MOOV_ACCOUNT_ID',
  'MOOV_WEBHOOK_SECRET',
  'MOOV_ENVIRONMENT',
  'CHECKALT_FI_KEY',
  'CHECKALT_USERNAME',
  'CHECKALT_PASSWORD',
  'CHECKALT_WEBHOOK_SECRET',
  'CHECKALT_BASE_URL',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_WEBHOOK_SECRET',
  'PLAID_ENV',
  'ACTUM_USERNAME',
  'ACTUM_PASSWORD',
  'ACTUM_PARENT_ID',
  'QUICKBOOKS_CLIENT_ID',
  'QUICKBOOKS_CLIENT_SECRET',
  'QUICKBOOKS_REDIRECT_URI',
];

const ENV_WEBHOOK_FALLBACK = {
  moov: 'AWS_MOOV_WEBHOOK_SECRET',
  checkalt: 'AWS_CHECKALT_WEBHOOK_SECRET',
  plaid: 'AWS_PLAID_WEBHOOK_SECRET',
};

const SECRET_KEY_BY_PROVIDER = {
  moov: 'MOOV_WEBHOOK_SECRET',
  checkalt: 'CHECKALT_WEBHOOK_SECRET',
  plaid: 'PLAID_WEBHOOK_SECRET',
};

const SECRET_VALUE_RE = /(secret|password|token|key|authorization|bearer|sk_|pk_live)/i;

let cached = null;

const parseSecretObject = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export const configuredFlags = (secrets = {}) => {
  const out = {};
  for (const key of SECRET_KEYS) {
    out[`${key}_configured`] = Boolean(secrets[key]);
  }
  return out;
};

export const redactValue = (value) => {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return '[redacted-non-string]';
  if (value.length <= 4) return '[redacted]';
  return `[redacted:${value.length}chars]`;
};

export const assertNoSecrets = (value, path = 'payload') => {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value) && value.length > 12) {
      throw new Error(`refusing to return possible secret at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_VALUE_RE.test(key) && typeof nested === 'string' && nested.length > 0) {
        throw new Error(`refusing to return secret field ${path}.${key}`);
      }
      assertNoSecrets(nested, `${path}.${key}`);
    }
  }
};

export const loadProviderSecrets = async (getSecretString = getSecretStringFromAws) => {
  if (cached) return cached;
  const arn = process.env.PROVIDER_SECRETS_ARN;
  let fromManager = {};
  if (arn) {
    try {
      fromManager = parseSecretObject(await getSecretString(arn));
    } catch {
      fromManager = {};
    }
  }
  const merged = { ...fromManager };
  for (const key of SECRET_KEYS) {
    if (!merged[key] && process.env[key]) merged[key] = process.env[key];
  }
  cached = merged;
  return cached;
};

export const resetProviderSecretsCache = () => {
  cached = null;
};

export const webhookSecret = (secrets, provider) => {
  const key = SECRET_KEY_BY_PROVIDER[provider];
  if (key && secrets?.[key]) return secrets[key];
  const envName = ENV_WEBHOOK_FALLBACK[provider];
  if (envName && process.env[envName]) return process.env[envName];
  return null;
};

export const providerSecretsConfigured = async () => {
  const secrets = await loadProviderSecrets();
  return {
    providerSecretsArnConfigured: Boolean(process.env.PROVIDER_SECRETS_ARN),
    ...configuredFlags(secrets),
    moovWebhookSecretConfigured: Boolean(webhookSecret(secrets, 'moov')),
    checkaltWebhookSecretConfigured: Boolean(webhookSecret(secrets, 'checkalt')),
    plaidWebhookSecretConfigured: Boolean(webhookSecret(secrets, 'plaid')),
  };
};
