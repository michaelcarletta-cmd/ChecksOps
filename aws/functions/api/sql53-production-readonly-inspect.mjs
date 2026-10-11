import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  buildClientConfig,
  EXPECTED_APPLICATION_ROLE,
  IDENTITY_PROBE,
} from './db-health.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';

const { Client } = pg;

export const SQL53_READONLY_INSPECT_AUTHORIZATION = 'OWNER_AUTHORIZED_PRODUCTION_SQL53_READONLY_INSPECT';
export const SQL53_READONLY_INSPECT_AUTHORIZATION_ENV = 'CHECKSOPS_SQL53_READONLY_INSPECT_AUTHORIZATION';
export const SQL53_READONLY_INSPECT_AUTHORIZATION_MIN_LENGTH = 32;
export const SQL53_READONLY_INSPECT_EXPIRES_AT_ENV = 'CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT';
export const SQL53_READONLY_INSPECT_MAX_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SQL53_READONLY_INSPECT_DIAGNOSTIC = 'sql53-production-readonly-inspect';
export const SQL53_READONLY_INSPECT_EXPECTED_DATABASE = 'checksops';
export const SQL53_READONLY_INSPECT_EXPECTED_FUNCTION = 'checksops-production-prep-api';
export const SQL53_READONLY_INSPECT_ALLOWED_ENVS = Object.freeze(['production', 'production-prep']);
export const SQL53_READONLY_INSPECT_EXPECTED_RDS_IDENTIFIER = 'checksops-production';
export const SQL53_READONLY_INSPECT_SECRETS_SHA256 = 'f8fa9ee63cb56bd0de49a746afbb18322c9376b0277aaf057a748f0c1ba0dba3';
export const SQL53_READONLY_INSPECT_EVENT_KEYS = Object.freeze(['diagnostic', 'authorization']);

export const SQL53_FUNCTION_DEF_INSPECT_SQL = `
SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_functiondef(p.oid) AS def
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1::text
  AND p.proname = $2::text
  AND p.pronargs = COALESCE(cardinality($3::text[]), 0)
  AND (
    SELECT COALESCE(ARRAY_AGG(proc_t.typ ORDER BY proc_t.ord), ARRAY[]::oid[])
    FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS proc_t(typ, ord)
  ) = (
    SELECT COALESCE(ARRAY_AGG(u.typ::regtype::oid ORDER BY u.ord), ARRAY[]::oid[])
    FROM unnest(COALESCE($3::text[], ARRAY[]::text[])) WITH ORDINALITY AS u(typ, ord)
  )
`.trim();

export const SQL53_SETTLEMENT_COLUMN_INSPECT_SQL = `SELECT a.attname AS column_name
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'claim_settlements'
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND a.attname = ANY($1::text[])`;

export const SQL53_LEDGER_TRIGGER_INSPECT_SQL = `SELECT c.relname AS table_name,
       t.tgname AS trigger_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND c.relname = $1::text
  AND t.tgname = ANY($2::text[])`;

export const SQL53_PINNED_FUNCTION_LOOKUPS = Object.freeze([
  Object.freeze({
    identity: 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)',
    schema: 'public',
    name: 'save_claim_settlement_breakdown',
    argTypes: Object.freeze(['uuid', 'uuid', 'jsonb']),
  }),
  Object.freeze({
    identity: 'public.sync_homeowner_ledger_from_check()',
    schema: 'public',
    name: 'sync_homeowner_ledger_from_check',
    argTypes: Object.freeze([]),
  }),
  Object.freeze({
    identity: 'public.aws_can_write_claim(uuid)',
    schema: 'public',
    name: 'aws_can_write_claim',
    argTypes: Object.freeze(['uuid']),
  }),
  Object.freeze({
    identity: 'public.hle_on_check_intake_insert()',
    schema: 'public',
    name: 'hle_on_check_intake_insert',
    argTypes: Object.freeze([]),
  }),
]);

export const SQL53_REQUIRED_SETTLEMENT_COLUMNS = Object.freeze([
  'replacement_cost_value',
  'recoverable_depreciation',
  'non_recoverable_depreciation',
  'deductible',
  'other_structures_rcv',
  'other_structures_recoverable_depreciation',
  'other_structures_non_recoverable_depreciation',
  'other_structures_deductible',
  'pwi_rcv',
  'pwi_recoverable_depreciation',
  'pwi_non_recoverable_depreciation',
  'personal_property_rcv',
  'personal_property_recoverable_depreciation',
  'personal_property_non_recoverable_depreciation',
  'ale_rcv',
  'ale_recoverable_depreciation',
  'ale_non_recoverable_depreciation',
]);

export const SQL53_REQUIRED_LEDGER_TRIGGERS = Object.freeze([
  Object.freeze({ table: 'check_intake_items', trigger: 'trg_sync_homeowner_ledger_ins' }),
  Object.freeze({ table: 'check_intake_items', trigger: 'trg_sync_homeowner_ledger_upd' }),
  Object.freeze({ table: 'check_intake_items', trigger: 'trg_hle_check_intake_insert' }),
]);

const ALLOWED_SQL = new Set([
  'BEGIN READ ONLY',
  'ROLLBACK',
  IDENTITY_PROBE,
  SQL53_FUNCTION_DEF_INSPECT_SQL,
  SQL53_SETTLEMENT_COLUMN_INSPECT_SQL,
  SQL53_LEDGER_TRIGGER_INSPECT_SQL,
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function hashSql53Definition(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

export function hashSql53PackageMember(relativePath, root = MODULE_DIR) {
  return createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
}

export function assertSql53InspectQueryAllowlisted(sql) {
  const text = String(sql || '').trim();
  if (!ALLOWED_SQL.has(text)) {
    throw new Error('sql53 inspect query is not allowlisted');
  }
  return text;
}

export function isHttpApiGatewayEvent(event = {}) {
  return Boolean(
    event?.requestContext?.http
    || event?.requestContext?.apiId
    || event?.requestContext?.stage
    || event?.rawPath
    || event?.httpMethod
    || event?.headers
    || event?.queryStringParameters
  );
}

export function isSql53ProductionReadonlyInspectEvent(event = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (isHttpApiGatewayEvent(event)) return false;
  const keys = Object.keys(event);
  if (keys.length !== SQL53_READONLY_INSPECT_EVENT_KEYS.length) return false;
  if (SQL53_READONLY_INSPECT_EVENT_KEYS.some((key) => !keys.includes(key))) return false;
  return event.diagnostic === SQL53_READONLY_INSPECT_DIAGNOSTIC;
}

export function secretHostBindsProvenRds(host, identifier = SQL53_READONLY_INSPECT_EXPECTED_RDS_IDENTIFIER) {
  if (typeof host !== 'string') return false;
  const hostname = host.trim().toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || /[\s:/@\\?#]/.test(hostname)) return false;
  if (!hostname.endsWith('.rds.amazonaws.com')) return false;
  const labels = hostname.split('.');
  if (labels.length < 5 || labels[0] !== identifier) return false;
  if (hostname.includes('checksops-staging')) return false;
  return true;
}

export function sql53ReadonlyInspectExpiryState(env = {}, now = Date.now()) {
  const raw = env[SQL53_READONLY_INSPECT_EXPIRES_AT_ENV];
  if (raw == null || raw === '') return 'absent';
  const expires = Date.parse(raw);
  if (!Number.isFinite(expires)) return 'invalid';
  if (expires <= now) return 'expired';
  if (expires - now > SQL53_READONLY_INSPECT_MAX_WINDOW_MS) return 'invalid';
  return 'valid';
}

export function sql53ReadonlyInspectAuthorizationState(env = {}, event = {}) {
  if (!isSql53ProductionReadonlyInspectEvent(event)) return 'invalid';
  const configured = env[SQL53_READONLY_INSPECT_AUTHORIZATION_ENV];
  const requested = event.authorization;
  if ((configured == null || configured === '') && (requested == null || requested === '')) {
    return 'absent';
  }
  if (typeof configured !== 'string' || typeof requested !== 'string') return 'invalid';
  if (configured.length < SQL53_READONLY_INSPECT_AUTHORIZATION_MIN_LENGTH) return 'invalid';
  if (requested.length < SQL53_READONLY_INSPECT_AUTHORIZATION_MIN_LENGTH) return 'invalid';
  if (configured === SQL53_READONLY_INSPECT_AUTHORIZATION) return 'invalid';
  if (requested === SQL53_READONLY_INSPECT_AUTHORIZATION) return 'invalid';
  if (configured !== requested) return 'invalid';
  if (!SQL53_READONLY_INSPECT_ALLOWED_ENVS.includes(String(env.CHECKSOPS_ENV || '').toLowerCase())) {
    return 'invalid';
  }
  if (sql53ReadonlyInspectExpiryState(env) !== 'valid') return 'invalid';
  return 'authorized';
}

export function proveSql53ReadonlyInspectProvenance(env = {}, { hashMember = hashSql53PackageMember } = {}) {
  if (!SQL53_READONLY_INSPECT_ALLOWED_ENVS.includes(String(env.CHECKSOPS_ENV || '').toLowerCase())) {
    return { ok: false, reason: 'sql53 inspect requires a production Lambda environment' };
  }
  if (env.AWS_LAMBDA_FUNCTION_NAME !== SQL53_READONLY_INSPECT_EXPECTED_FUNCTION) {
    return { ok: false, reason: 'sql53 inspect package provenance is not the production Lambda' };
  }
  let secretsSha;
  try {
    secretsSha = hashMember('secrets.mjs');
  } catch {
    return { ok: false, reason: 'sql53 inspect could not hash live secrets.mjs' };
  }
  if (secretsSha !== SQL53_READONLY_INSPECT_SECRETS_SHA256) {
    return { ok: false, reason: 'sql53 inspect refused a secrets.mjs provenance mismatch' };
  }
  try {
    hashMember('sql53-production-readonly-inspect.mjs');
  } catch {
    return { ok: false, reason: 'sql53 inspect could not hash its own deployed member' };
  }
  return { ok: true, secrets_sha256: secretsSha };
}

function refused(reason, extras = {}) {
  return {
    statusCode: 403,
    body: redactSql53InspectResponse({
      status: 'refused',
      reason,
      readOnly: true,
      inspect: extras.inspect || null,
    }),
  };
}

function functionRow(identity, exists, definitionSha256 = null) {
  return {
    identity,
    exists: exists === true ? true : exists === false ? false : null,
    definitionSha256: exists === true && SHA256_RE.test(String(definitionSha256 || ''))
      ? definitionSha256
      : null,
  };
}

function classifyFunctionRows(rows) {
  if (!Array.isArray(rows)) return { complete: false };
  if (rows.length === 0) return { complete: true, exists: false, definitionSha256: null };
  if (rows.length !== 1 || typeof rows[0]?.def !== 'string' || !rows[0].def) {
    return { complete: false };
  }
  return { complete: true, exists: true, definitionSha256: hashSql53Definition(rows[0].def) };
}

export function redactSql53InspectResponse(result = {}) {
  const inspect = result.inspect && typeof result.inspect === 'object' ? result.inspect : null;
  return {
    status: result.status || 'refused',
    reason: result.reason || 'sql53 inspect refused',
    readOnly: true,
    rdsIdentifier: result.rdsIdentifier === SQL53_READONLY_INSPECT_EXPECTED_RDS_IDENTIFIER
      ? SQL53_READONLY_INSPECT_EXPECTED_RDS_IDENTIFIER
      : null,
    inspect: inspect ? {
      readOnly: true,
      functions: SQL53_PINNED_FUNCTION_LOOKUPS.map((target) => {
        const found = (inspect.functions || []).find((row) => row?.identity === target.identity);
        return functionRow(target.identity, found?.exists, found?.definitionSha256);
      }),
      settlementColumns: SQL53_REQUIRED_SETTLEMENT_COLUMNS.map((column) => {
        const found = (inspect.settlementColumns || []).find((row) => row?.column === column);
        return {
          table: 'claim_settlements',
          column,
          exists: found?.exists === true ? true : found?.exists === false ? false : null,
        };
      }),
      ledgerTriggers: SQL53_REQUIRED_LEDGER_TRIGGERS.map((row) => {
        const found = (inspect.ledgerTriggers || []).find((item) => (
          item?.table === row.table && item?.trigger === row.trigger
        ));
        return {
          table: row.table,
          trigger: row.trigger,
          exists: found?.exists === true ? true : found?.exists === false ? false : null,
        };
      }),
    } : null,
  };
}

function wrapAllowlistedClient(client) {
  const query = (...args) => {
    assertSql53InspectQueryAllowlisted(args[0]);
    return client.query(...args);
  };
  return { query, end: (...args) => client.end?.(...args) };
}

async function inspectSql53Catalog(client) {
  const functions = [];
  for (const target of SQL53_PINNED_FUNCTION_LOOKUPS) {
    const result = await client.query(SQL53_FUNCTION_DEF_INSPECT_SQL, [
      target.schema,
      target.name,
      [...target.argTypes],
    ]);
    const classified = classifyFunctionRows(result?.rows);
    if (!classified.complete) {
      return { ok: false, reason: 'sql53 function catalog evidence is incomplete' };
    }
    functions.push(functionRow(target.identity, classified.exists, classified.definitionSha256));
  }

  const columnResult = await client.query(
    SQL53_SETTLEMENT_COLUMN_INSPECT_SQL,
    [[...SQL53_REQUIRED_SETTLEMENT_COLUMNS]],
  );
  if (!Array.isArray(columnResult?.rows)) {
    return { ok: false, reason: 'sql53 settlement column evidence is incomplete' };
  }
  const presentColumns = new Set(columnResult.rows.map((row) => String(row.column_name || '')));
  const settlementColumns = SQL53_REQUIRED_SETTLEMENT_COLUMNS.map((column) => ({
    table: 'claim_settlements',
    column,
    exists: presentColumns.has(column),
  }));

  const triggerResult = await client.query(SQL53_LEDGER_TRIGGER_INSPECT_SQL, [
    'check_intake_items',
    SQL53_REQUIRED_LEDGER_TRIGGERS.map((row) => row.trigger),
  ]);
  if (!Array.isArray(triggerResult?.rows)) {
    return { ok: false, reason: 'sql53 ledger trigger evidence is incomplete' };
  }
  const presentTriggers = new Set(
    triggerResult.rows.map((row) => `${row.table_name || ''}\0${row.trigger_name || ''}`),
  );
  const ledgerTriggers = SQL53_REQUIRED_LEDGER_TRIGGERS.map((row) => ({
    table: row.table,
    trigger: row.trigger,
    exists: presentTriggers.has(`${row.table}\0${row.trigger}`),
  }));

  return {
    ok: true,
    inspect: { readOnly: true, functions, settlementColumns, ledgerTriggers },
  };
}

export async function handleSql53ProductionReadonlyInspect(event = {}, {
  env = process.env,
  loadCredentials = loadDatabaseCredentials,
  createClient = (config) => new Client(config),
  hashMember = hashSql53PackageMember,
} = {}) {
  const auth = sql53ReadonlyInspectAuthorizationState(env, event);
  if (auth !== 'authorized') {
    return refused('sql53 inspect authorization is missing or invalid; database was not contacted');
  }
  const provenance = proveSql53ReadonlyInspectProvenance(env, { hashMember });
  if (!provenance.ok) {
    return refused(provenance.reason);
  }

  let rawClient;
  try {
    const credentials = await loadCredentials();
    if (!secretHostBindsProvenRds(credentials?.host)) {
      return refused('sql53 inspect refused a secret host that is not the proven production RDS');
    }
    if (/checksops_admin/i.test(credentials?.username || '')) {
      return refused('sql53 inspect refused a privileged database user');
    }
    rawClient = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 10000, readOnly: true }));
    await rawClient.connect();
    const client = wrapAllowlistedClient(rawClient);
    await client.query('BEGIN READ ONLY');
    const identity = (await client.query(IDENTITY_PROBE)).rows[0] || {};
    if (identity.current_database !== SQL53_READONLY_INSPECT_EXPECTED_DATABASE) {
      return refused('sql53 inspect refused a database identity mismatch');
    }
    if (identity.current_user !== EXPECTED_APPLICATION_ROLE) {
      return refused('sql53 inspect refused a database role mismatch');
    }
    if (identity.transaction_read_only !== 'on') {
      return refused('sql53 inspect refused a writable transaction');
    }
    const catalog = await inspectSql53Catalog(client);
    if (!catalog.ok) {
      return refused(catalog.reason);
    }
    return {
      statusCode: 200,
      body: redactSql53InspectResponse({
        status: 'complete',
        reason: 'authorized sql53 catalog inspect completed inside a read-only transaction',
        rdsIdentifier: SQL53_READONLY_INSPECT_EXPECTED_RDS_IDENTIFIER,
        inspect: catalog.inspect,
      }),
    };
  } catch {
    return refused('sql53 inspect failed closed before complete catalog evidence');
  } finally {
    if (rawClient) {
      try {
        await wrapAllowlistedClient(rawClient).query('ROLLBACK');
      } catch {
        // keep the fail-closed response
      }
      try {
        await rawClient.end();
      } catch {
        // ignore disconnect errors
      }
    }
  }
}
