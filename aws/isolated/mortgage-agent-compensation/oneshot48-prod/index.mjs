/**
 * Dedicated production Mortgage Agent Return-to-Queue SQL 48 oneshot.
 *
 * Embeds accepted 48_return_mortgage_request_to_queue.sql only.
 * Refuses caller SQL, staging, demo, SQL 47 reapply, SQL 49, Return CALL,
 * and shared/prior oneshots.
 * GATE 0: existing check_billing_events_mortgage_ops_check_uidx must be
 * present; the fallback unique must never be created.
 * Does not modify checksops-production-prep-api, SPA, Cognito, or release locks.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL47_SHA256,
  PINNED_SQL48_SHA256,
  PINNED_SQL49_SHA256,
  EXPECTED_SQL39_HASH,
  EXPECTED_SQL47_CATALOG,
  EXPECTED_SQL47_FN_HASHES,
  EXPECTED_CBE_COUNT,
  EXPECTED_CBE_UIDX_NAME,
  EXPECTED_CBE_UIDX_DEF,
  FALLBACK_UIDX_NAME,
  FREEDOM_REQUEST_ID,
  FREEDOM_CBE_ID,
  SYNTHETIC_A,
  SYNTHETIC_B,
  KNOWN_CBE_IDS,
} from './constants.mjs';
import { snapshotMortgageOpsState } from './mortgage-ops-sql39.mjs';

export {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL47_SHA256,
  PINNED_SQL48_SHA256,
  PINNED_SQL49_SHA256,
  EXPECTED_SQL39_HASH,
  EXPECTED_SQL47_CATALOG,
};

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.join(ROOT, 'sql', '48_return_mortgage_request_to_queue.sql');
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  '/var/task/rds-global-bundle.pem',
].find((p) => fs.existsSync(p));

const SQL47_TABLES = [
  'mortgage_agent_accounts',
  'mortgage_agent_compensation_rates',
  'mortgage_agent_compensation_exclusions',
  'mortgage_agent_compensation_entries',
  'mortgage_agent_compensation_batches',
  'mortgage_agent_compensation_audit',
];
const SQL47_FUNCTIONS = [
  'aws_is_active_mortgage_agent',
  'aws_can_admin_mortgage_agent_compensation',
  'earn_mortgage_agent_compensation',
  'set_mortgage_agent_account_status',
  'approve_mortgage_agent_compensation',
  'mark_mortgage_agent_compensation_paid',
  'mortgage_agent_compensation_reconciliation',
];
const SQL47_TRIGGERS = [
  'tr_reject_inactive_mortgage_agent_accept',
  'tr_earn_mortgage_agent_compensation',
];
const ENTRY_PROTECT_TRIGGER = 'tr_protect_mortgage_agent_compensation_facts';
const SQL48_TABLE = 'mortgage_ops_request_audit';
const SQL48_FUNCTION = 'return_mortgage_handling_request_to_queue';
const SQL49_FUNCTION = 'adjust_mortgage_agent_compensation';
const consumed = new Set();

function normalizeRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const key of Object.keys(out)) {
    if (out[key] instanceof Date) out[key] = out[key].toISOString();
  }
  return out;
}

export function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

export function fail(code, message, details = {}) {
  return { ok: false, code, message, details, errors: [{ code, message, details }], mutated: false };
}

export function ok(details = {}) {
  return { ok: true, code: null, message: null, details, errors: [], mutated: Boolean(details.applied) };
}

export function refuseEvent(event = {}, env = process.env) {
  if (event.sql_text != null || event.sql != null || event.statement != null || event.arbitrary_sql != null) {
    return fail('UNRELATED_MUTATION', 'arbitrary SQL text is forbidden');
  }
  if (event.call_return || event.return_request_id || event.exercise_return || event.p_request_id) {
    return fail('UNRELATED_MUTATION', 'Return RPC exercise is forbidden in this production SQL 48 stop');
  }
  if (event.reapply_sql47 === true || event.apply_sql47 === true) {
    return fail('UNRELATED_MUTATION', 'SQL 47 reapply is forbidden');
  }
  if (event.apply_sql49 === true || event.reapply_sql49 === true) {
    return fail('UNRELATED_MUTATION', 'SQL 49 is not authorized');
  }
  if (event.filename) {
    const name = String(event.filename);
    if (name.endsWith('47_mortgage_agent_compensation.sql')) {
      return fail('UNRELATED_MUTATION', 'SQL 47 reapply is forbidden');
    }
    if (name.endsWith('49_adjust_mortgage_agent_compensation.sql')) {
      return fail('UNRELATED_MUTATION', 'SQL 49 is not authorized');
    }
    if (!name.endsWith('48_return_mortgage_request_to_queue.sql')) {
      return fail('UNRELATED_MUTATION', 'only accepted SQL 48 may be applied', { filename: event.filename });
    }
  }
  if (event.migration_id && event.migration_id !== '48_return_mortgage_request_to_queue') {
    return fail('UNRELATED_MUTATION', 'only migration 48_return_mortgage_request_to_queue is authorized', {
      migration_id: event.migration_id,
    });
  }
  const host = String(env.RDS_HOST || event.rds_host || '');
  if (/staging/i.test(host) || event.target_environment === 'staging') {
    return fail('UNRELATED_MUTATION', 'this oneshot is production-only and must not target staging');
  }
  if (event.target_environment && event.target_environment !== 'production') {
    return fail('PRODUCTION_APPROVAL_REQUIRED', 'target_environment must be production');
  }
  const name = event.function_name || env.AWS_LAMBDA_FUNCTION_NAME || FUNCTION_NAME;
  if (FORBIDDEN_FUNCTIONS.includes(name) || name !== FUNCTION_NAME) {
    return fail('UNRELATED_MUTATION', 'oneshot may not retarget a shared, staging, prior, or unrelated function', {
      function_name: name,
    });
  }
  const action = String(event.action || 'inspect').trim();
  if (!['inspect', 'apply', 'verify'].includes(action)) {
    return fail('INVALID_MANIFEST', `unsupported action ${action}; demo and Return exercise are forbidden in production`);
  }
  return null;
}

export function readEmbeddedSql(sqlFile = SQL_FILE, expected = PINNED_SQL48_SHA256) {
  if (!fs.existsSync(sqlFile)) {
    return fail('INVALID_MANIFEST', 'embedded SQL 48 is missing');
  }
  const text = fs.readFileSync(sqlFile, 'utf8');
  const hash = sha256(text);
  if (hash !== expected) {
    return fail('SQL_COLLISION', 'embedded SQL 48 hash mismatch', { hash, expected });
  }
  if (hash === PINNED_SQL47_SHA256 || hash === PINNED_SQL49_SHA256) {
    return fail('UNRELATED_MUTATION', 'embedded file is not accepted SQL 48');
  }
  const executable = text.replace(/--.*$/gm, '');
  if (/GRANT\s+UPDATE\s+ON\s+TABLE\s+public\.mortgage_handling_requests/i.test(text)) {
    return fail('UNRELATED_MUTATION', 'SQL 48 must not grant table-level MHR UPDATE');
  }
  if (/ALTER\s+TABLE\s+public\.mortgage_handling_requests/i.test(text)) {
    return fail('UNRELATED_MUTATION', 'SQL 48 must not ALTER mortgage_handling_requests');
  }
  if (/ALTER\s+TABLE\s+public\.check_billing_events/i.test(text)) {
    return fail('UNRELATED_MUTATION', 'SQL 48 must not ALTER check_billing_events');
  }
  if (/\bmoov\b|\bstripe\b|\bach\b|\bwallet\b/i.test(executable)) {
    return fail('UNRELATED_MUTATION', 'SQL 48 must not reference money rails');
  }
  if (!/CREATE TABLE IF NOT EXISTS public\.mortgage_ops_request_audit/i.test(text)) {
    return fail('INVALID_MANIFEST', 'SQL 48 must create mortgage_ops_request_audit');
  }
  if (!/CREATE OR REPLACE FUNCTION public\.return_mortgage_handling_request_to_queue/i.test(text)) {
    return fail('INVALID_MANIFEST', 'SQL 48 must create return_mortgage_handling_request_to_queue');
  }
  if (!/accepted_at_must_be_preserved/i.test(text)) {
    return fail('INVALID_MANIFEST', 'SQL 48 must preserve accepted_at');
  }
  if (!/check_billing_events_mortgage_ops_check_uidx|Mortgage Ops per-check unique already present/i.test(text)) {
    return fail('INVALID_MANIFEST', 'SQL 48 must recognize the existing GATE 0 unique');
  }
  if (/CREATE OR REPLACE FUNCTION public\.adjust_mortgage_agent_compensation/i.test(text)) {
    return fail('UNRELATED_MUTATION', 'SQL 48 must not embed SQL 49 adjust');
  }
  return ok({ text, hash });
}

function consumeOneUse(id) {
  if (!id) throw new Error('one_use_id required');
  if (consumed.has(id)) throw new Error(`one_use_replay:${id}`);
  consumed.add(id);
}

async function adminClient(env = process.env) {
  const { default: pg } = await import('pg');
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const { Client } = pg;
  const arn = env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops-production/i.test(arn) || !/checksops_admin/i.test(arn)) {
    throw new Error('ADMIN_SECRET_ARN must be the production checksops_admin secret');
  }
  if (/staging/i.test(arn)) {
    throw new Error('staging admin secret is forbidden');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : env.RDS_HOST;
  if (!host || !/checksops-production/i.test(host) || /staging/i.test(host)) {
    throw new Error(`refusing host ${host}`);
  }
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  await client.connect();
  return { client, host };
}

async function functionDef(client, name) {
  const { rows } = await client.query(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = $1
    ORDER BY p.pronargs
    LIMIT 1
  `, [name]);
  return rows[0]?.def || null;
}

export async function snapshotProduction(client) {
  const sql39 = await snapshotMortgageOpsState(client);
  if (!sql39.ok) {
    throw new Error(sql39.message || 'sql39_snapshot_failed');
  }
  const tables = (await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    ORDER BY 1
  `, [SQL47_TABLES])).rows.map((r) => r.table_name);
  const functions = (await client.query(`
    SELECT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
    ORDER BY 1
  `, [SQL47_FUNCTIONS])).rows.map((r) => r.proname);
  const mhrTableUpdate = (await client.query(`
    SELECT grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'mortgage_handling_requests'
      AND privilege_type = 'UPDATE'
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY 1
  `)).rows;
  const macGrants = tables.length ? (await client.query(`
    SELECT table_name, grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY 1, 2, 3
  `, [SQL47_TABLES])).rows : [];
  const executeGrants = functions.length ? (await client.query(`
    SELECT p.proname AS routine_name, r.grantee, r.privilege_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN information_schema.routine_privileges r
      ON r.routine_schema = 'public' AND r.routine_name = p.proname
    WHERE n.nspname = 'public'
      AND p.proname = ANY($1::text[])
      AND r.grantee IN ('checksops', 'authenticated')
    ORDER BY 1, 2, 3
  `, [SQL47_FUNCTIONS])).rows : [];
  const triggers = (await client.query(`
    SELECT c.relname AS table_name, t.tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
      AND (
        (c.relname = 'mortgage_handling_requests' AND t.tgname = ANY($1::text[]))
        OR (c.relname = 'mortgage_agent_compensation_entries' AND t.tgname = $2)
      )
    ORDER BY 1, 2
  `, [SQL47_TRIGGERS, ENTRY_PROTECT_TRIGGER])).rows;
  const cbeIndexes = (await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'check_billing_events'
    ORDER BY 1
  `)).rows;
  const cbeUnique = cbeIndexes.find((row) => row.indexname === EXPECTED_CBE_UIDX_NAME) || null;
  const fallbackUnique = cbeIndexes.find((row) => row.indexname === FALLBACK_UIDX_NAME) || null;
  const knownEvents = (await client.query(`
    SELECT id::text, event_type, status, unit_price_cents,
           tenant_id::text, claim_id::text, check_intake_item_id::text,
           mortgage_request_id::text, billed_at, created_at
    FROM public.check_billing_events
    WHERE id = ANY($1::uuid[])
    ORDER BY created_at
  `, [KNOWN_CBE_IDS])).rows.map(normalizeRow);
  const cbeCount = Number((await client.query(`
    SELECT count(*)::int AS n FROM public.check_billing_events
  `)).rows[0]?.n || 0);
  const freedomRequest = (await client.query(`
    SELECT id::text, status, assigned_employee_id::text, accepted_at, completed_at,
           cancelled_at, tenant_id::text, check_intake_item_id::text, mortgage_company
    FROM public.mortgage_handling_requests
    WHERE id = $1::uuid
  `, [FREEDOM_REQUEST_ID])).rows.map(normalizeRow)[0] || null;
  const exclusionTableExists = tables.includes('mortgage_agent_compensation_exclusions');
  const exclusions = exclusionTableExists ? (await client.query(`
    SELECT mortgage_request_id::text, reason
    FROM public.mortgage_agent_compensation_exclusions
    ORDER BY mortgage_request_id
  `)).rows : [];
  const entryTableExists = tables.includes('mortgage_agent_compensation_entries');
  const compensationCounts = entryTableExists ? (await client.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE mortgage_request_id = $1::uuid)::int AS freedom,
      count(*) FILTER (WHERE mortgage_request_id = $2::uuid)::int AS synthetic_a,
      count(*) FILTER (WHERE mortgage_request_id = $3::uuid)::int AS synthetic_b
    FROM public.mortgage_agent_compensation_entries
  `, [FREEDOM_REQUEST_ID, SYNTHETIC_A, SYNTHETIC_B])).rows[0] : {
    total: 0, freedom: 0, synthetic_a: 0, synthetic_b: 0,
  };
  const sql47FunctionHashes = {};
  for (const name of SQL47_FUNCTIONS) {
    const def = await functionDef(client, name);
    sql47FunctionHashes[name] = def ? sha256(def) : null;
  }
  const auditPresent = (await client.query(`
    SELECT to_regclass('public.mortgage_ops_request_audit') IS NOT NULL AS present
  `)).rows[0]?.present === true;
  const returnDef = await functionDef(client, SQL48_FUNCTION);
  const adjustDef = await functionDef(client, SQL49_FUNCTION);
  const auditCount = auditPresent ? Number((await client.query(`
    SELECT count(*)::int AS n FROM public.mortgage_ops_request_audit
  `)).rows[0]?.n || 0) : 0;
  const compensationAuditReturnCount = tables.includes('mortgage_agent_compensation_audit')
    ? Number((await client.query(`
        SELECT count(*)::int AS n
        FROM public.mortgage_agent_compensation_audit
        WHERE action = 'return_to_queue'
      `)).rows[0]?.n || 0)
    : 0;
  const auditGrants = auditPresent ? (await client.query(`
    SELECT grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = $1
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY 1, 2
  `, [SQL48_TABLE])).rows : [];
  const returnGrants = returnDef ? (await client.query(`
    SELECT r.grantee, r.privilege_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN information_schema.routine_privileges r
      ON r.routine_schema = 'public' AND r.routine_name = p.proname
    WHERE n.nspname = 'public'
      AND p.proname = $1
      AND r.grantee IN ('checksops', 'authenticated')
    ORDER BY 1, 2
  `, [SQL48_FUNCTION])).rows : [];
  const auditPolicy = auditPresent ? (await client.query(`
    SELECT pol.polname, pol.polcmd
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1
    ORDER BY 1
  `, [SQL48_TABLE])).rows : [];
  const sql47Snapshot = {
    sql39_hash: sql39.details.hash,
    sql39_membership_601: {
      user_can_move_tenant_checks_sha256: sql39.details.snapshot.user_can_move_tenant_checks_sha256,
      admin_override_check_status_sha256: sql39.details.snapshot.admin_override_check_status_sha256,
    },
    owned_tables: tables,
    owned_functions: functions,
    owned_function_hashes: sql47FunctionHashes,
    owned_triggers: triggers,
    mhr_table_update: mhrTableUpdate,
    mac_table_grants: macGrants,
    mac_execute_grants: executeGrants,
    cbe_unique: cbeUnique,
    cbe_index_names: cbeIndexes.map((row) => row.indexname),
    known_billing_events: knownEvents,
    freedom_request: freedomRequest,
    exclusions,
    compensation_counts: compensationCounts,
  };
  const snapshot = {
    ...sql47Snapshot,
    sql47_catalog_fingerprint: sha256(JSON.stringify(sql47Snapshot)),
    cbe_count: cbeCount,
    fallback_unique: fallbackUnique,
    sql48_audit_present: auditPresent,
    sql48_return_present: Boolean(returnDef),
    sql48_return_hash: returnDef ? sha256(returnDef) : null,
    sql49_adjust_present: Boolean(adjustDef),
    audit_count: auditCount,
    compensation_audit_return_count: compensationAuditReturnCount,
    audit_grants: auditGrants,
    return_grants: returnGrants,
    audit_policies: auditPolicy,
    return_called: false,
  };
  return {
    snapshot,
    sql39: sql39.details,
    live_definition_sha256: sha256(JSON.stringify(snapshot)),
  };
}

function invariantStops(before) {
  const stops = [];
  if (before.snapshot.sql39_hash !== EXPECTED_SQL39_HASH) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'SQL 39 catalog hash drifted from accepted production authority',
      expected: EXPECTED_SQL39_HASH,
      live: before.snapshot.sql39_hash,
    });
  }
  if (before.snapshot.sql47_catalog_fingerprint !== EXPECTED_SQL47_CATALOG) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'SQL 47 catalog fingerprint drifted from accepted production authority',
      expected: EXPECTED_SQL47_CATALOG,
      live: before.snapshot.sql47_catalog_fingerprint,
    });
  }
  for (const [name, expected] of Object.entries(EXPECTED_SQL47_FN_HASHES)) {
    if (before.snapshot.owned_function_hashes[name] !== expected) {
      stops.push({
        code: 'SQL_COLLISION',
        message: `SQL 47 function ${name} drifted`,
        expected,
        live: before.snapshot.owned_function_hashes[name],
      });
    }
  }
  if ((before.snapshot.mhr_table_update || []).length !== 0) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'refusing apply while MHR has table-level UPDATE grants',
      live: before.snapshot.mhr_table_update,
    });
  }
  if (!before.snapshot.cbe_unique || before.snapshot.cbe_unique.indexdef !== EXPECTED_CBE_UIDX_DEF) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'GATE 0 failed: production Mortgage Ops CBE unique is missing or changed; SQL 48 must not create the fallback unique',
      live: before.snapshot.cbe_unique,
    });
  }
  if (before.snapshot.fallback_unique) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'fallback unique already exists; refusing apply',
      live: before.snapshot.fallback_unique,
    });
  }
  if (Number(before.snapshot.cbe_count) !== EXPECTED_CBE_COUNT) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'check_billing_events count drifted from accepted 131',
      live: before.snapshot.cbe_count,
    });
  }
  const freedom = before.snapshot.freedom_request;
  if (!freedom
    || freedom.id !== FREEDOM_REQUEST_ID
    || freedom.status !== 'in_progress'
    || freedom.assigned_employee_id !== 'b100f05d-9e81-4a7b-b9cc-9baf173131d9'
    || freedom.accepted_at !== '2026-10-03T11:45:11.665Z') {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'Freedom request drifted from accepted preflight',
      live: freedom,
    });
  }
  const events = new Map((before.snapshot.known_billing_events || []).map((row) => [row.id, row]));
  if (events.size !== 3 || !events.has(FREEDOM_CBE_ID)) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'known Mortgage Ops billing events drifted from accepted complete-table census',
      live: before.snapshot.known_billing_events,
    });
  }
  const freedomCbe = events.get(FREEDOM_CBE_ID);
  if (!freedomCbe
    || freedomCbe.event_type !== 'mortgage_ops_initial'
    || freedomCbe.status !== 'recorded'
    || Number(freedomCbe.unit_price_cents) !== 1000
    || freedomCbe.mortgage_request_id !== FREEDOM_REQUEST_ID) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'Freedom CBE drifted from accepted preflight',
      live: freedomCbe || null,
    });
  }
  if (Number(before.snapshot.compensation_counts.total) !== 0) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'compensation entries drifted from zero before SQL 48',
      live: before.snapshot.compensation_counts,
    });
  }
  if (before.snapshot.sql49_adjust_present) {
    stops.push({
      code: 'UNRELATED_MUTATION',
      message: 'SQL 49 adjust function is already present; this stop is SQL 48 only',
    });
  }
  if (Number(before.snapshot.audit_count) !== 0 || Number(before.snapshot.compensation_audit_return_count) !== 0) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'Return audit already exists; refusing apply so no Return operation is implied',
      live: {
        audit_count: before.snapshot.audit_count,
        compensation_audit_return_count: before.snapshot.compensation_audit_return_count,
      },
    });
  }
  return stops;
}

function unchanged(before, after, key) {
  return JSON.stringify(before.snapshot[key]) === JSON.stringify(after.snapshot[key]);
}

function expectedAuditGrants(grants) {
  const wanted = [
    { grantee: 'authenticated', privilege_type: 'SELECT' },
    { grantee: 'checksops', privilege_type: 'SELECT' },
  ];
  return JSON.stringify(grants) === JSON.stringify(wanted);
}

function expectedReturnGrants(grants) {
  const wanted = [
    { grantee: 'authenticated', privilege_type: 'EXECUTE' },
    { grantee: 'checksops', privilege_type: 'EXECUTE' },
  ];
  return JSON.stringify(grants) === JSON.stringify(wanted);
}

export async function handleEvent(event = {}, env = process.env, deps = {}) {
  const refused = refuseEvent(event, env);
  if (refused) return refused;
  const embedded = readEmbeddedSql(deps.sqlFile || SQL_FILE);
  if (!embedded.ok) return embedded;
  const action = String(event.action || 'inspect');
  if (action !== 'inspect') consumeOneUse(event.one_use_id);

  const connected = deps.client ? { client: deps.client, host: env.RDS_HOST } : await adminClient(env);
  const client = connected.client;
  const close = !deps.client;
  try {
    const identity = (await client.query(`
      SELECT current_database() AS database,
             current_user AS db_user,
             inet_server_addr()::text AS server_addr
    `)).rows[0];
    if (identity.database !== 'checksops') {
      return fail('UNRELATED_MUTATION', `connected_to_${identity.database}`);
    }
    const before = await snapshotProduction(client);
    const stops = invariantStops(before);
    if (action === 'inspect') {
      return ok({
        action,
        inspect_only: true,
        mutated: false,
        host: connected.host,
        identity,
        sql48_sha256: embedded.details.hash,
        live_definition_sha256: before.live_definition_sha256,
        sql39_hash: before.snapshot.sql39_hash,
        sql47_catalog_fingerprint: before.snapshot.sql47_catalog_fingerprint,
        prewrite_stops: stops,
        snapshot: before.snapshot,
        return_called: false,
      });
    }
    if (stops.length) {
      return fail('SQL_COLLISION', 'pre-apply production invariants failed', { prewrite_stops: stops });
    }
    if (action === 'apply') {
      if (event.expected_live_definition_sha256
        && event.expected_live_definition_sha256 !== before.live_definition_sha256) {
        return fail('DEPLOYMENT_COLLISION', 'live catalog drifted after preflight (TOCTOU)', {
          expected_live_definition_sha256: event.expected_live_definition_sha256,
          live_definition_sha256: before.live_definition_sha256,
        });
      }
      if (!event.expected_live_definition_sha256) {
        return fail('SQL_COLLISION', 'apply requires expected_live_definition_sha256 from the immediate inspect');
      }
      await client.query(embedded.details.text);
      const after = await snapshotProduction(client);
      const afterStops = [];
      if (after.snapshot.sql39_hash !== EXPECTED_SQL39_HASH) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 48 changed SQL 39 hash', live: after.snapshot.sql39_hash });
      }
      if (after.snapshot.sql47_catalog_fingerprint !== EXPECTED_SQL47_CATALOG) {
        afterStops.push({
          code: 'SQL_COLLISION',
          message: 'SQL 48 changed the frozen SQL 47 catalog fingerprint',
          expected: EXPECTED_SQL47_CATALOG,
          live: after.snapshot.sql47_catalog_fingerprint,
        });
      }
      for (const [name, expected] of Object.entries(EXPECTED_SQL47_FN_HASHES)) {
        if (after.snapshot.owned_function_hashes[name] !== expected) {
          afterStops.push({ code: 'SQL_COLLISION', message: `SQL 48 changed SQL 47 function ${name}` });
        }
      }
      if (after.snapshot.mhr_table_update.length) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 48 introduced MHR table UPDATE grants' });
      }
      if (!after.snapshot.cbe_unique || after.snapshot.cbe_unique.indexdef !== EXPECTED_CBE_UIDX_DEF) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 48 changed the Mortgage Ops CBE unique' });
      }
      if (after.snapshot.fallback_unique) {
        afterStops.push({
          code: 'SQL_COLLISION',
          message: 'SQL 48 created the forbidden fallback unique',
          live: after.snapshot.fallback_unique,
        });
      }
      if (!unchanged(before, after, 'cbe_index_names')) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 48 changed CBE index names' });
      }
      if (!unchanged(before, after, 'known_billing_events')) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 48 changed existing Mortgage Ops billing events' });
      }
      if (!unchanged(before, after, 'freedom_request')) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 48 changed the Freedom request' });
      }
      if (Number(after.snapshot.cbe_count) !== EXPECTED_CBE_COUNT) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 48 changed CBE row count', live: after.snapshot.cbe_count });
      }
      if (Number(after.snapshot.compensation_counts.total) !== 0) {
        afterStops.push({
          code: 'UNRELATED_MUTATION',
          message: 'SQL 48 accidentally earned or backfilled compensation',
          live: after.snapshot.compensation_counts,
        });
      }
      if (!after.snapshot.sql48_audit_present || !after.snapshot.sql48_return_present) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 48 objects missing after apply' });
      }
      if (after.snapshot.sql49_adjust_present) {
        afterStops.push({ code: 'UNRELATED_MUTATION', message: 'SQL 49 adjust function appeared during SQL 48 apply' });
      }
      if (Number(after.snapshot.audit_count) !== 0 || Number(after.snapshot.compensation_audit_return_count) !== 0) {
        afterStops.push({
          code: 'UNRELATED_MUTATION',
          message: 'a Return operation occurred during SQL 48 apply',
          live: {
            audit_count: after.snapshot.audit_count,
            compensation_audit_return_count: after.snapshot.compensation_audit_return_count,
          },
        });
      }
      if (!expectedAuditGrants(after.snapshot.audit_grants)) {
        afterStops.push({
          code: 'SQL_COLLISION',
          message: 'SQL 48 audit grants are not SELECT-only to checksops/authenticated',
          live: after.snapshot.audit_grants,
        });
      }
      if (!expectedReturnGrants(after.snapshot.return_grants)) {
        afterStops.push({
          code: 'SQL_COLLISION',
          message: 'SQL 48 Return RPC grants are not EXECUTE to checksops/authenticated',
          live: after.snapshot.return_grants,
        });
      }
      const policyNames = after.snapshot.audit_policies.map((row) => row.polname);
      if (!policyNames.includes('aws_select_mortgage_ops_request_audit')) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 48 SELECT policy missing on mortgage_ops_request_audit' });
      }
      if (afterStops.length) {
        return fail('SQL_COLLISION', 'SQL 48 post-apply invariants failed', {
          after_stops: afterStops,
          before_hash: before.live_definition_sha256,
          after_hash: after.live_definition_sha256,
          snapshot: after.snapshot,
        });
      }
      return ok({
        action,
        applied: true,
        mutated: true,
        host: connected.host,
        identity,
        sql48_sha256: embedded.details.hash,
        before_hash: before.live_definition_sha256,
        after_hash: after.live_definition_sha256,
        sql39_hash_before: before.snapshot.sql39_hash,
        sql39_hash_after: after.snapshot.sql39_hash,
        sql47_catalog_fingerprint: after.snapshot.sql47_catalog_fingerprint,
        sql47_function_hashes: after.snapshot.owned_function_hashes,
        sql48_audit_present: after.snapshot.sql48_audit_present,
        sql48_return_present: after.snapshot.sql48_return_present,
        sql48_return_hash: after.snapshot.sql48_return_hash,
        sql49_adjust_present: after.snapshot.sql49_adjust_present,
        audit_count: after.snapshot.audit_count,
        compensation_audit_return_count: after.snapshot.compensation_audit_return_count,
        audit_grants: after.snapshot.audit_grants,
        return_grants: after.snapshot.return_grants,
        audit_policies: after.snapshot.audit_policies,
        cbe_unique: after.snapshot.cbe_unique,
        fallback_unique: after.snapshot.fallback_unique,
        cbe_count: after.snapshot.cbe_count,
        known_billing_events: after.snapshot.known_billing_events,
        freedom_request: after.snapshot.freedom_request,
        compensation_counts: after.snapshot.compensation_counts,
        mhr_table_update: after.snapshot.mhr_table_update,
        return_called: false,
        snapshot_before: before.snapshot,
        snapshot_after: after.snapshot,
      });
    }
    const missing = [
      !before.snapshot.sql48_audit_present && 'request_audit',
      !before.snapshot.sql48_return_present && 'return_fn',
      before.snapshot.fallback_unique && 'fallback_unique_present',
      before.snapshot.sql49_adjust_present && 'sql49_adjust_present',
    ].filter(Boolean);
    return ok({
      action,
      present: missing.length === 0,
      missing,
      sql48_sha256: embedded.details.hash,
      live_definition_sha256: before.live_definition_sha256,
      sql39_hash: before.snapshot.sql39_hash,
      sql47_catalog_fingerprint: before.snapshot.sql47_catalog_fingerprint,
      snapshot: before.snapshot,
      return_called: false,
    });
  } finally {
    if (close) await client.end().catch(() => null);
  }
}

export async function handler(event = {}) {
  try {
    return await handleEvent(event, process.env);
  } catch (error) {
    return fail('UNRELATED_MUTATION', error.message, { stack: String(error.stack || '').slice(0, 800) });
  }
}
