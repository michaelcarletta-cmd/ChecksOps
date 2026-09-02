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

export const getSecretStringFromAws = async (secretArn) => {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) {
    throw new Error('database secret has no SecretString');
  }
  return response.SecretString;
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
