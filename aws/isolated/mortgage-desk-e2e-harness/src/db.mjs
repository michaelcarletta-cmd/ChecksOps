import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  STAGING_DATABASE_NAME,
  STAGING_DB_USER,
  STAGING_RDS_HOST,
} from './constants.mjs';
import { secretLooksProductionOrProvider, stagingSecretArnAllowed } from './fail-closed.mjs';

const { Client } = pg;
const CA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rds-global-bundle.pem');

const WRITE_SQL = /(?:^|;)[\s(]*(insert|update|delete|grant|revoke|alter|drop|create|truncate|comment|copy|call|do)\b/i;

export const assertReadOnlySql = (sql) => {
  const text = String(sql || '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (WRITE_SQL.test(text)) {
    throw new Error(`refusing non-read-only SQL: ${text.slice(0, 80)}`);
  }
  return text;
};

export const parseStagingAppSecret = (raw) => {
  if (!raw || typeof raw !== 'string') throw new Error('database secret string is missing');
  const parsed = JSON.parse(raw);
  if (/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('refusing to load checksops_admin secret');
  }
  if (parsed.username !== STAGING_DB_USER) {
    throw new Error('secret username is not checksops');
  }
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (host !== STAGING_RDS_HOST) {
    throw new Error('secret host is not the approved staging RDS endpoint');
  }
  if (secretLooksProductionOrProvider(JSON.stringify({ username: parsed.username, host }))) {
    throw new Error('secret identity looks production or provider');
  }
  return {
    username: parsed.username,
    host,
    port: Number(parsed.port || 5432),
    secretDatabase: parsed.dbname || parsed.database || null,
    password: parsed.password,
  };
};

export const loadStagingAppSecret = async (getSecretString) => {
  const arn = process.env.DATABASE_SECRET_ARN;
  if (!stagingSecretArnAllowed(arn)) {
    throw new Error('DATABASE_SECRET_ARN is not the staging application secret');
  }
  if (process.env.PROVIDER_SECRETS_ARN || process.env.ADMIN_SECRET_ARN) {
    throw new Error('refusing to run with provider or admin secret env present');
  }
  const raw = await getSecretString(arn);
  const credentials = parseStagingAppSecret(raw);
  return {
    ...credentials,
    secretArnNameOnly: STAGING_RDS_HOST,
    secretName: String(arn).split(':secret:')[1]?.replace(/-[A-Za-z0-9]+$/, '') || null,
  };
};

export const getSecretStringFromAws = async (secretArn) => {
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('database secret has no SecretString');
  return response.SecretString;
};

export const openReadOnlyClient = async (credentials) => {
  if (credentials.username !== STAGING_DB_USER) {
    throw new Error('refusing to authenticate as non-application role');
  }
  const client = new Client({
    host: credentials.host,
    port: credentials.port || 5432,
    user: credentials.username,
    password: credentials.password,
    database: STAGING_DATABASE_NAME,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync(CA_PATH, 'utf8'),
    },
    connectionTimeoutMillis: 8000,
    query_timeout: 20000,
  });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  await client.query('BEGIN READ ONLY');
  return client;
};

export const readOnlyQuery = async (client, sql, params = []) => {
  assertReadOnlySql(sql);
  return client.query(sql, params);
};

export const closeClient = async (client) => {
  if (!client) return;
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  try { await client.end(); } catch { /* ignore */ }
};
