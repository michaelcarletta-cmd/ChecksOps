/**
 * Dedicated production SQL70 apply.
 * Applies only:
 *   GRANT UPDATE (claim_number, updated_at) ON TABLE public.claims TO checksops;
 * Refuses arbitrary SQL, table-level UPDATE, id/org_id grants, RLS changes,
 * claim_settlements privilege changes, and SQL43/SQL44/#601.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SQL_FILE = path.join(ROOT, '70_staging_claims_number_grant.sql');

const PINNED_SOURCE_SHA256 = '0a5109e102f6d8014c9e6e6e6d99c259eecb82c0c576fef62834ebb869bffa5c';
const PINNED_GRANT = 'GRANT UPDATE (claim_number, updated_at) ON TABLE public.claims TO checksops;';
const CONFIRM = 'APPLY_SQL70_CLAIMS_COLUMN_GRANT';
const CLAIMS_COLUMNS = ['id', 'org_id', 'claim_number', 'updated_at'];
const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const COLUMN_PRIVS = ['SELECT', 'INSERT', 'UPDATE'];

function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function extractGrant(sql) {
  const lines = String(sql || '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('--'));
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

async function connectAdmin() {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops-production/i.test(arn)) {
    throw new Error('apply requires production admin secret');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (!/checksops-production/i.test(String(host || ''))) {
    throw new Error(`refusing_non_production_host:${host}`);
  }
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 30000,
  });
  await client.connect();
  return client;
}

async function probe(client) {
  const identity = (await client.query(`
    SELECT current_database() AS database,
           current_user AS db_user,
           inet_server_addr()::text AS server_addr,
           current_setting('transaction_read_only') AS read_only,
           current_setting('server_version') AS server_version
  `)).rows[0];
  const owners = (await client.query(`
    SELECT c.relname AS table_name,
           pg_get_userbyid(c.relowner) AS owner,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('claims', 'claim_settlements')
      AND c.relkind = 'r'
    ORDER BY 1
  `)).rows;
  const tablePrivs = {};
  for (const table of ['claims', 'claim_settlements']) {
    const row = {};
    for (const priv of TABLE_PRIVS) {
      const q = await client.query(
        'SELECT has_table_privilege($1, $2, $3) AS ok',
        ['checksops', `public.${table}`, priv],
      );
      row[priv] = q.rows[0].ok === true;
    }
    tablePrivs[table] = row;
  }
  const claimsColumns = {};
  for (const column of CLAIMS_COLUMNS) {
    const row = {};
    for (const priv of COLUMN_PRIVS) {
      const q = await client.query(
        'SELECT has_column_privilege($1, $2, $3, $4) AS ok',
        ['checksops', 'public.claims', column, priv],
      );
      row[priv] = q.rows[0].ok === true;
    }
    claimsColumns[column] = row;
  }
  const claimsColumnUpdate = (await client.query(`
    SELECT a.attname AS column_name,
           has_column_privilege('checksops', 'public.claims', a.attname, 'UPDATE') AS can_update
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'claims'
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum
  `)).rows;
  const unexpectedUpdateColumns = claimsColumnUpdate
    .filter((row) => row.can_update && !['claim_number', 'updated_at'].includes(row.column_name))
    .map((row) => row.column_name);
  const fingerprint = {
    claims_table: tablePrivs.claims,
    claims_columns: claimsColumns,
    claim_settlements_table: tablePrivs.claim_settlements,
    rls: owners.map((row) => ({
      table: row.table_name,
      rls_enabled: row.rls_enabled,
      rls_forced: row.rls_forced,
    })),
  };
  return {
    identity,
    owners,
    has_table_privilege: tablePrivs,
    has_column_privilege_claims: claimsColumns,
    claims_column_update: claimsColumnUpdate,
    unexpected_update_columns: unexpectedUpdateColumns,
    privilege_fingerprint: fingerprint,
    privilege_sha256: sha256(canonicalJson(fingerprint)),
  };
}

function privilegeSha256(probeResult) {
  return sha256(canonicalJson(probeResult.privilege_fingerprint));
}

export const handler = async (event = {}) => {
  const action = event.action || 'inspect';
  if (event.sql || event.statement || event.query || event.extra_sql) {
    return { ok: false, error: 'refuses_caller_sql' };
  }
  if (action !== 'inspect' && action !== 'apply') {
    return { ok: false, error: `refuses_action:${action}` };
  }

  const sourceSql = fs.readFileSync(SQL_FILE, 'utf8');
  const sourceHash = sha256(sourceSql);
  if (sourceHash !== PINNED_SOURCE_SHA256) {
    return { ok: false, error: 'pinned_source_mismatch', sourceHash };
  }
  const grant = extractGrant(sourceSql);
  if (grant !== PINNED_GRANT) {
    return { ok: false, error: 'pinned_grant_mismatch', grant };
  }

  const client = await connectAdmin();
  try {
    if (action === 'inspect') {
      await client.query('SET default_transaction_read_only = on');
      const before = await probe(client);
      if (before.identity.database !== 'checksops') {
        return { ok: false, error: `connected_to_${before.identity.database}` };
      }
      return {
        ok: true,
        inspect_only: true,
        mutated: false,
        source_sha256: sourceHash,
        grant: PINNED_GRANT,
        ...before,
        privilege_sha256: privilegeSha256(before),
        already_has_required_claims_column_update:
          before.has_column_privilege_claims.claim_number.UPDATE
          && before.has_column_privilege_claims.updated_at.UPDATE,
      };
    }

    if (event.confirm !== CONFIRM) {
      return { ok: false, error: 'missing_or_invalid_confirm_phrase' };
    }

    const before = await probe(client);
    if (before.identity.database !== 'checksops') {
      return { ok: false, error: `connected_to_${before.identity.database}` };
    }
    const beforeHash = privilegeSha256(before);
    if (event.expected_live_definition_sha256 && event.expected_live_definition_sha256 !== beforeHash) {
      return {
        ok: false,
        error: 'SQL_COLLISION',
        message: 'live privilege fingerprint differs from expected baseline; grant not applied',
        expected_live_definition_sha256: event.expected_live_definition_sha256,
        live_definition_sha256: beforeHash,
        before,
      };
    }
    const claimNumberUpdate = before.has_column_privilege_claims.claim_number.UPDATE === true;
    const updatedAtUpdate = before.has_column_privilege_claims.updated_at.UPDATE === true;
    if (claimNumberUpdate || updatedAtUpdate) {
      return {
        ok: false,
        error: 'required_column_update_already_exists',
        mutated: false,
        before,
      };
    }
    if (before.has_table_privilege.claims.UPDATE === true) {
      return { ok: false, error: 'unexpected_table_level_update', mutated: false, before };
    }
    if (before.has_column_privilege_claims.id.UPDATE || before.has_column_privilege_claims.org_id.UPDATE) {
      return { ok: false, error: 'unexpected_id_or_org_id_update', mutated: false, before };
    }
    if (before.unexpected_update_columns.length) {
      return { ok: false, error: 'unexpected_update_columns', mutated: false, before };
    }

    await client.query('BEGIN');
    await client.query(PINNED_GRANT);
    await client.query('COMMIT');

    const after = await probe(client);
    const afterHash = privilegeSha256(after);
    const settlementsUnchanged = JSON.stringify(before.has_table_privilege.claim_settlements)
      === JSON.stringify(after.has_table_privilege.claim_settlements);
    const rlsUnchanged = JSON.stringify(before.owners) === JSON.stringify(after.owners);
    const requiredGranted = after.has_column_privilege_claims.claim_number.UPDATE === true
      && after.has_column_privilege_claims.updated_at.UPDATE === true;
    const idUntouched = after.has_column_privilege_claims.id.UPDATE === false
      && after.has_column_privilege_claims.org_id.UPDATE === false;
    const noUnexpected = after.unexpected_update_columns.length === 0;
    const tableInsertUnchanged = before.has_table_privilege.claims.INSERT === after.has_table_privilege.claims.INSERT
      && before.has_table_privilege.claims.SELECT === after.has_table_privilege.claims.SELECT
      && before.has_table_privilege.claims.DELETE === after.has_table_privilege.claims.DELETE;

    return {
      ok: requiredGranted && idUntouched && noUnexpected && settlementsUnchanged && rlsUnchanged && tableInsertUnchanged,
      inspect_only: false,
      mutated: true,
      grant_applied: PINNED_GRANT,
      source_sha256: sourceHash,
      before_privilege_sha256: beforeHash,
      after_privilege_sha256: afterHash,
      before: {
        has_table_privilege: before.has_table_privilege,
        has_column_privilege_claims: before.has_column_privilege_claims,
        owners: before.owners,
      },
      after: {
        has_table_privilege: after.has_table_privilege,
        has_column_privilege_claims: after.has_column_privilege_claims,
        owners: after.owners,
        unexpected_update_columns: after.unexpected_update_columns,
      },
      settlements_privileges_unchanged: settlementsUnchanged,
      rls_unchanged: rlsUnchanged,
      table_insert_select_delete_unchanged: tableInsertUnchanged,
    };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
};
