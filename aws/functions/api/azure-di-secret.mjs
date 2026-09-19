/**
 * Azure Document Intelligence secret loader.
 * Never logs or returns endpoint / api_key to HTTP callers.
 * Staging may load only the staging Azure DI secret.
 * production and production-prep may load only the production Azure DI secret.
 */
import { parseAzureDiSecret } from './azure-check-ocr.mjs';

export const STAGING_AZURE_DI_SECRET_ID = 'checksops/staging/providers/azure-document-intelligence';
export const PRODUCTION_AZURE_DI_SECRET_ID = 'checksops/production/providers/azure-document-intelligence';

const AZURE_DI_ALLOWED_ENVS = new Set(['staging', 'production', 'production-prep']);

let cached = null;

const defaultGetSecretString = async (secretId) => {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (out?.SecretString) return out.SecretString;
  if (out?.SecretBinary) {
    const buf = Buffer.isBuffer(out.SecretBinary)
      ? out.SecretBinary
      : Buffer.from(out.SecretBinary);
    return buf.toString('utf8');
  }
  return null;
};

export const resolveAzureDiSecretId = (env = process.env) => (
  env.AZURE_DI_SECRET_ID || STAGING_AZURE_DI_SECRET_ID
);

export const assertAzureDiSecretIdAllowed = (secretId, envName) => {
  if (!AZURE_DI_ALLOWED_ENVS.has(envName)) return { ok: false, code: 'wrong_env' };
  if (secretId == null || String(secretId).trim() === '') {
    return { ok: false, code: 'secret_id_missing' };
  }
  const id = String(secretId).trim();
  if (id.includes('/isolated/')) return { ok: false, code: 'isolated_secret_blocked' };
  const expected = envName === 'staging'
    ? STAGING_AZURE_DI_SECRET_ID
    : PRODUCTION_AZURE_DI_SECRET_ID;
  if (id !== expected) return { ok: false, code: 'secret_id_rejected' };
  return { ok: true, secretId: id };
};

export const resetAzureDiSecretCache = () => {
  cached = null;
};

/**
 * Public loader status. Never includes endpoint or api_key.
 */
export const loadAzureDiStagingSecret = async (deps = {}) => {
  const env = deps.env || process.env;
  const envName = env.CHECKSOPS_ENV;
  const allowed = assertAzureDiSecretIdAllowed(
    deps.secretId || resolveAzureDiSecretId(env),
    envName,
  );
  if (!allowed.ok) return { configured: false, code: allowed.code };

  if (cached?.configured && !deps.skipCache) {
    return { configured: true, code: 'ok' };
  }

  const getSecretString = typeof deps.getSecretString === 'function'
    ? deps.getSecretString
    : defaultGetSecretString;

  let raw;
  try {
    raw = await getSecretString(allowed.secretId);
  } catch {
    return { configured: false, code: 'secret_missing' };
  }
  if (raw == null || raw === '') return { configured: false, code: 'secret_missing' };

  const parsed = parseAzureDiSecret(raw);
  if (!parsed) return { configured: false, code: 'secret_malformed' };

  cached = { configured: true, raw };
  return { configured: true, code: 'ok' };
};

/**
 * secretLoader for analyzeAzureCheck / extractCheck only.
 * Callers must not copy this return value into HTTP responses or logs.
 */
export const azureDiAnalyzeSecretLoader = (deps = {}) => async () => {
  const status = await loadAzureDiStagingSecret(deps);
  if (!status.configured) return null;
  return cached?.raw || null;
};
