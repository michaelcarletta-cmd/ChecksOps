import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDatabaseCredentials } from './secrets.mjs';

const { Client } = pg;

/**
 * node-pg returns PostgreSQL `numeric` as JS strings. Frontend totals that use
 * `+= amount` then concatenate ("3802.10" + "17357.80" → "3802.1017357.80").
 * Coerce numeric (OID 1700) to Number for JSON API responses. Money magnitudes
 * in ChecksOps are well within Number precision; do not coerce int8/OID 20
 * (can be large identifiers).
 */
export const installPgJsonTypeParsers = () => {
  pg.types.setTypeParser(1700, (value) => {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  });
};
installPgJsonTypeParsers();

export const READ_ONLY_PROBE = 'SELECT 1 AS ok';
export const VERSION_PROBE = 'SHOW server_version';
export const IDENTITY_PROBE = "SELECT current_database() AS current_database, current_user AS current_user, current_setting('transaction_read_only') AS transaction_read_only, current_setting('default_transaction_read_only') AS default_transaction_read_only";
export const EXPECTED_APPLICATION_ROLE = 'checksops';
const CA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rds-global-bundle.pem');

export const tlsConfig = () => ({
  rejectUnauthorized: true,
  ca: fs.readFileSync(CA_PATH, 'utf8'),
});

export const sanitizePublicError = (error) => {
  const message = String(error?.message || error || 'unknown error');
  return message
    .replace(/password\s*=\s*\S+/gi, 'password=redacted')
    .replace(/Password:\s*\S+/gi, 'Password: redacted')
    .replace(/\/\/[^:]+:[^@]+@/g, '//redacted@');
};

export const classifyDbError = (error, stage) => {
  const message = sanitizePublicError(error);
  const code = error?.code || error?.name || '';
  if (stage === 'secrets' || /DATABASE_SECRET_ARN|checksops_admin|secret/i.test(message) || code.startsWith('AccessDenied') || code === 'ResourceNotFoundException') {
    return { stage: 'secretsManager', message };
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code) || /timeout|timed out|getaddrinfo/i.test(message)) {
    return { stage: 'networkTls', message };
  }
  if (/certificate|ssl|tls|UNABLE_TO_GET_ISSUER|unable to verify/i.test(message) || ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)) {
    return { stage: 'networkTls', message };
  }
  if (code === '28P01' || /password authentication failed|no pg_hba.conf|authentication/i.test(message)) {
    return { stage: 'authentication', message };
  }
  if (stage === 'query') {
    return { stage: 'select1', message };
  }
  if (stage === 'connect') {
    return { stage: 'networkTls', message };
  }
  return { stage: stage || 'unknown', message };
};

export const buildClientConfig = (credentials, { queryTimeoutMillis = 5000, readOnly = true } = {}) => {
  if (/checksops_admin/i.test(credentials.username || '')) {
    throw new Error('refusing to authenticate as checksops_admin');
  }
  return {
    host: credentials.host,
    port: credentials.port || 5432,
    user: credentials.username,
    password: credentials.password,
    database: credentials.database || 'postgres',
    ssl: tlsConfig(),
    connectionTimeoutMillis: 8000,
    query_timeout: queryTimeoutMillis,
    ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
  };
};

export const buildWriteClientConfig = (credentials, { queryTimeoutMillis = 12000 } = {}) => (
  buildClientConfig(credentials, { queryTimeoutMillis, readOnly: false })
);

export const probeIsHealthy = (probe) => {
  const expectedDatabase = String(process.env.DATABASE_NAME || '').trim();
  const databaseMatches = !expectedDatabase || probe.currentDatabase === expectedDatabase;
  const userMatches = probe.currentUser === EXPECTED_APPLICATION_ROLE;
  return probe.secretsManager === 'ok'
    && probe.networkTls === 'ok'
    && probe.authentication === 'ok'
    && probe.select1 === 'ok'
    && databaseMatches
    && userMatches;
};

export const probeDatabase = async ({
  loadCredentials = loadDatabaseCredentials,
  createClient = (config) => new Client(config),
} = {}) => {
  const result = {
    secretsManager: 'not-run',
    networkTls: 'not-run',
    authentication: 'not-run',
    postgresqlVersion: null,
    select1: 'not-run',
    currentDatabase: null,
    currentUser: null,
    transactionReadOnly: null,
    defaultTransactionReadOnly: null,
    connectedDatabase: null,
    secretDatabase: null,
    databaseNameOverride: String(process.env.DATABASE_NAME || '').trim() || null,
  };
  let client;
  try {
    const credentials = await loadCredentials();
    result.secretsManager = 'ok';
    result.connectedDatabase = credentials.database || null;
    result.secretDatabase = credentials.secretDatabase || null;
    client = createClient(buildClientConfig(credentials));
    await client.connect();
    result.networkTls = 'ok';
    result.authentication = 'ok';
    const selectResult = await client.query(READ_ONLY_PROBE);
    if (selectResult?.rows?.[0]?.ok !== 1 && selectResult?.rows?.[0]?.ok !== '1') {
      throw Object.assign(new Error('SELECT 1 did not return 1'), { stage: 'query' });
    }
    result.select1 = 'ok';
    const versionResult = await client.query(VERSION_PROBE);
    result.postgresqlVersion = versionResult?.rows?.[0]?.server_version || null;
    const identityResult = await client.query(IDENTITY_PROBE);
    const identity = identityResult?.rows?.[0] || {};
    result.currentDatabase = identity.current_database || null;
    result.currentUser = identity.current_user || null;
    result.transactionReadOnly = identity.transaction_read_only || null;
    result.defaultTransactionReadOnly = identity.default_transaction_read_only || null;
    if (result.currentUser && result.currentUser !== EXPECTED_APPLICATION_ROLE) {
      throw Object.assign(new Error(`connected as unexpected role ${result.currentUser}`), { stage: 'query' });
    }
    const expectedDatabase = String(process.env.DATABASE_NAME || '').trim();
    if (expectedDatabase && result.currentDatabase !== expectedDatabase) {
      throw Object.assign(new Error(`connected to ${result.currentDatabase}, expected ${expectedDatabase}`), { stage: 'query' });
    }
    return result;
  } catch (error) {
    const classified = classifyDbError(error, error.stage);
    if (classified.stage === 'secretsManager') result.secretsManager = 'failed';
    else if (result.secretsManager === 'not-run') result.secretsManager = 'failed';
    if (classified.stage === 'networkTls') result.networkTls = 'failed';
    if (classified.stage === 'authentication') {
      result.networkTls = result.networkTls === 'not-run' ? 'ok' : result.networkTls;
      result.authentication = 'failed';
    }
    if (classified.stage === 'select1') {
      result.networkTls = result.networkTls === 'not-run' ? 'ok' : result.networkTls;
      result.authentication = result.authentication === 'not-run' ? 'ok' : result.authentication;
      result.select1 = 'failed';
    }
    result.error = classified.message;
    return result;
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // ignore disconnect errors
      }
    }
  }
};
