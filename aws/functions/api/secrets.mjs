export const databaseSecretConfigured = () => Boolean(process.env.DATABASE_SECRET_ARN);

export const ALLOWED_DATABASE_NAMES = new Set(['checksops', 'postgres']);

export const resolveDatabaseName = (secretDatabase) => {
  const override = String(process.env.DATABASE_NAME || '').trim();
  const resolved = override || secretDatabase || 'postgres';
  if (!ALLOWED_DATABASE_NAMES.has(resolved)) {
    throw new Error('refusing unexpected DATABASE_NAME');
  }
  return resolved;
};

export const parseDatabaseSecretString = (raw) => {
  if (!raw || typeof raw !== 'string') {
    throw new Error('database secret string is missing');
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('database secret JSON is invalid');
  }
  if (/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('refusing to load checksops_admin secret');
  }
  const secretDatabase = parsed.dbname || parsed.database || null;
  return {
    username: parsed.username,
    host: parsed.host,
    port: Number(parsed.port || 5432),
    secretDatabase,
    database: resolveDatabaseName(secretDatabase),
    password: parsed.password,
  };
};

export const publicCredentialFields = (credentials) => ({
  username: credentials?.username || null,
  host: credentials?.host || null,
  port: credentials?.port || null,
  database: credentials?.database || null,
  secretDatabase: credentials?.secretDatabase || null,
});

// One GetSecretValue per secret per warm container per TTL, instead of one per request.
// A rotated password is picked up within the TTL; a failed fetch is never cached.
export const SECRET_STRING_CACHE_MS = 5 * 60 * 1000;

const secretStringCache = new Map();

export const resetSecretStringCacheForTests = () => {
  secretStringCache.clear();
};

const fetchSecretStringFromAws = async (secretArn) => {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) {
    throw new Error('database secret has no SecretString');
  }
  return response.SecretString;
};

export const getSecretStringFromAws = async (secretArn, deps = {}) => {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const fetchSecretString = deps.fetchSecretString || fetchSecretStringFromAws;
  const hit = secretStringCache.get(secretArn);
  if (hit && now - hit.at < SECRET_STRING_CACHE_MS) {
    return hit.promise;
  }
  const promise = fetchSecretString(secretArn);
  const entry = { at: now, promise };
  secretStringCache.set(secretArn, entry);
  try {
    return await promise;
  } catch (error) {
    if (secretStringCache.get(secretArn) === entry) secretStringCache.delete(secretArn);
    throw error;
  }
};

export const loadDatabaseCredentials = async (getSecretString = getSecretStringFromAws) => {
  const arn = process.env.DATABASE_SECRET_ARN;
  if (!arn) {
    throw new Error('DATABASE_SECRET_ARN is not configured');
  }
  if (/checksops_admin/i.test(arn)) {
    throw new Error('refusing to load checksops_admin secret');
  }
  const raw = await getSecretString(arn);
  return parseDatabaseSecretString(raw);
};
