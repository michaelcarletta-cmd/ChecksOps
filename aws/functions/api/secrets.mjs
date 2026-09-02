export const databaseSecretConfigured = () => Boolean(process.env.DATABASE_SECRET_ARN);

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
  return {
    username: parsed.username,
    host: parsed.host,
    port: Number(parsed.port || 5432),
    database: parsed.dbname || parsed.database || null,
    password: parsed.password,
  };
};

export const publicCredentialFields = (credentials) => ({
  username: credentials?.username || null,
  host: credentials?.host || null,
  port: credentials?.port || null,
  database: credentials?.database || null,
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
