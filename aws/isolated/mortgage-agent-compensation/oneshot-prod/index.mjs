/**
 * Dedicated production Mortgage Agent compensation SQL 47 oneshot.
 *
 * Embeds accepted 47_mortgage_agent_compensation.sql only.
 * Refuses caller SQL, staging, demo, SQL 48/49, and shared executors.
 * Does not create or modify check_billing_events_mortgage_ops_check_uidx.
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
  EXPECTED_SQL39_HASH,
  EXPECTED_CBE_UIDX_NAME,
  EXPECTED_CBE_UIDX_DEF,
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
  EXPECTED_SQL39_HASH,
};

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.join(ROOT, 'sql', '47_mortgage_agent_compensation.sql');
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  '/var/task/rds-global-bundle.pem',
].find((p) => fs.existsSync(p));

const OWNED_TABLES = [
  'mortgage_agent_accounts',
  'mortgage_agent_compensation_rates',
  'mortgage_agent_compensation_exclusions',
  'mortgage_agent_compensation_entries',
  'mortgage_agent_compensation_batches',
  'mortgage_agent_compensation_audit',
];
const OWNED_FUNCTIONS = [
  'aws_is_active_mortgage_agent',
  'aws_can_admin_mortgage_agent_compensation',
  'earn_mortgage_agent_compensation',
  'set_mortgage_agent_account_status',
  'approve_mortgage_agent_compensation',
  'mark_mortgage_agent_compensation_paid',
  'mortgage_agent_compensation_reconciliation',
];
const OWNED_TRIGGERS = [
  'tr_reject_inactive_mortgage_agent_accept',
  'tr_earn_mortgage_agent_compensation',
];
const ENTRY_PROTECT_TRIGGER = 'tr_protect_mortgage_agent_compensation_facts';
const consumed = new Set();

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return new Date(text).toISOString();
  return text;
}

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
  if (event.filename && !String(event.filename).endsWith('47_mortgage_agent_compensation.sql')) {
    return fail('UNRELATED_MUTATION', 'only accepted SQL 47 may be applied', { filename: event.filename });
  }
  if (event.migration_id && event.migration_id !== '47_mortgage_agent_compensation') {
    return fail('UNRELATED_MUTATION', 'only migration 47_mortgage_agent_compensation is authorized', {
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
    return fail('UNRELATED_MUTATION', 'oneshot may not retarget a shared, staging, or unrelated function', {
      function_name: name,
    });
  }
  const action = String(event.action || 'inspect').trim();
  if (!['inspect', 'apply', 'verify'].includes(action)) {
    return fail('INVALID_MANIFEST', `unsupported action ${action}; demo is forbidden in production`);
  }
  return null;
}

export function readEmbeddedSql(sqlFile = SQL_FILE, expected = PINNED_SQL47_SHA256) {
  if (!fs.existsSync(sqlFile)) {
    return fail('INVALID_MANIFEST', 'embedded SQL 47 is missing');
  }
  const text = fs.readFileSync(sqlFile, 'utf8');
  const hash = sha256(text);
  if (hash !== expected) {
    return fail('SQL_COLLISION', 'embedded SQL 47 hash mismatch', { hash, expected });
  }
  const executable = text.replace(/--.*$/gm, '');
  if (/GRANT\s+UPDATE\s+ON\s+TABLE\s+public\.mortgage_handling_requests/i.test(text)) {
    return fail('UNRELATED_MUTATION', 'SQL 47 must not grant table-level MHR UPDATE');
  }
  if (/ALTER\s+TABLE\s+public\.mortgage_handling_requests/i.test(text)) {
    return fail('UNRELATED_MUTATION', 'SQL 47 must not ALTER mortgage_handling_requests');
  }
  if (/ALTER\s+TABLE\s+public\.check_billing_events/i.test(text)) {
    return fail('UNRELATED_MUTATION', 'SQL 47 must not ALTER check_billing_events');
  }
  if (/check_billing_events_mortgage_ops_check_uidx|one_mortgage_ops_per_check/i.test(text)) {
    return fail('UNRELATED_MUTATION', 'SQL 47 must not create or modify Mortgage Ops CBE uniques');
  }
  if (/\bmoov\b|\bstripe\b|\bach\b|\bwallet\b/i.test(executable)) {
    return fail('UNRELATED_MUTATION', 'SQL 47 must not reference money rails');
  }
  if (!text.includes(FREEDOM_REQUEST_ID)) {
    return fail('INVALID_MANIFEST', 'SQL 47 must contain the Freedom exclusion');
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
  `, [OWNED_TABLES])).rows.map((r) => r.table_name);
  const functions = (await client.query(`
    SELECT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
    ORDER BY 1
  `, [OWNED_FUNCTIONS])).rows.map((r) => r.proname);
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
  `, [OWNED_TABLES])).rows : [];
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
  `, [OWNED_FUNCTIONS])).rows : [];
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
  `, [OWNED_TRIGGERS, ENTRY_PROTECT_TRIGGER])).rows;
  const cbeIndexes = (await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'check_billing_events'
    ORDER BY 1
  `)).rows;
  const cbeUnique = cbeIndexes.find((row) => row.indexname === EXPECTED_CBE_UIDX_NAME) || null;
  const knownEvents = (await client.query(`
    SELECT id::text, event_type, status, unit_price_cents,
           tenant_id::text, claim_id::text, check_intake_item_id::text,
           mortgage_request_id::text, billed_at, created_at
    FROM public.check_billing_events
    WHERE id = ANY($1::uuid[])
    ORDER BY created_at
  `, [KNOWN_CBE_IDS])).rows.map(normalizeRow);
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
  const ownedFunctionHashes = {};
  for (const name of OWNED_FUNCTIONS) {
    const def = await functionDef(client, name);
    ownedFunctionHashes[name] = def ? sha256(def) : null;
  }
  const snapshot = {
    sql39_hash: sql39.details.hash,
    sql39_membership_601: {
      user_can_move_tenant_checks_sha256: sql39.details.snapshot.user_can_move_tenant_checks_sha256,
      admin_override_check_status_sha256: sql39.details.snapshot.admin_override_check_status_sha256,
    },
    owned_tables: tables,
    owned_functions: functions,
    owned_function_hashes: ownedFunctionHashes,
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
      message: 'production Mortgage Ops CBE unique is missing or changed; SQL 47 must not create or modify it',
      live: before.snapshot.cbe_unique,
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
  return stops;
}

function unchanged(before, after, key) {
  return JSON.stringify(before.snapshot[key]) === JSON.stringify(after.snapshot[key]);
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
        sql47_sha256: embedded.details.hash,
        live_definition_sha256: before.live_definition_sha256,
        sql39_hash: before.snapshot.sql39_hash,
        prewrite_stops: stops,
        snapshot: before.snapshot,
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
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 47 changed SQL 39 hash', live: after.snapshot.sql39_hash });
      }
      if (after.snapshot.mhr_table_update.length) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 47 introduced MHR table UPDATE grants' });
      }
      if (!after.snapshot.cbe_unique || after.snapshot.cbe_unique.indexdef !== EXPECTED_CBE_UIDX_DEF) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 47 changed the Mortgage Ops CBE unique' });
      }
      if (!unchanged(before, after, 'known_billing_events')) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 47 changed existing Mortgage Ops billing events' });
      }
      if (!unchanged(before, after, 'freedom_request')) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'SQL 47 changed the Freedom request' });
      }
      if (Number(after.snapshot.compensation_counts.total) !== 0) {
        afterStops.push({
          code: 'UNRELATED_MUTATION',
          message: 'SQL 47 accidentally earned or backfilled compensation',
          live: after.snapshot.compensation_counts,
        });
      }
      const exclusionIds = new Set(after.snapshot.exclusions.map((row) => row.mortgage_request_id));
      if (!exclusionIds.has(FREEDOM_REQUEST_ID) || !exclusionIds.has(SYNTHETIC_A) || !exclusionIds.has(SYNTHETIC_B)) {
        afterStops.push({ code: 'SQL_COLLISION', message: 'required exclusion rows missing after SQL 47' });
      }
      const missingTables = OWNED_TABLES.filter((name) => !after.snapshot.owned_tables.includes(name));
      const missingFns = OWNED_FUNCTIONS.filter((name) => !after.snapshot.owned_functions.includes(name));
      const triggerNames = after.snapshot.owned_triggers.map((row) => row.tgname);
      const missingTriggers = [...OWNED_TRIGGERS, ENTRY_PROTECT_TRIGGER].filter((name) => !triggerNames.includes(name));
      if (missingTables.length || missingFns.length || missingTriggers.length) {
        afterStops.push({
          code: 'SQL_COLLISION',
          message: 'SQL 47 objects missing after apply',
          missingTables,
          missingFns,
          missingTriggers,
        });
      }
      if (afterStops.length) {
        return fail('SQL_COLLISION', 'SQL 47 post-apply invariants failed', {
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
        sql47_sha256: embedded.details.hash,
        before_hash: before.live_definition_sha256,
        after_hash: after.live_definition_sha256,
        sql39_hash_before: before.snapshot.sql39_hash,
        sql39_hash_after: after.snapshot.sql39_hash,
        owned_tables: after.snapshot.owned_tables,
        owned_functions: after.snapshot.owned_functions,
        owned_function_hashes: after.snapshot.owned_function_hashes,
        owned_triggers: after.snapshot.owned_triggers,
        mac_table_grants: after.snapshot.mac_table_grants,
        mac_execute_grants: after.snapshot.mac_execute_grants,
        exclusions: after.snapshot.exclusions,
        cbe_unique: after.snapshot.cbe_unique,
        known_billing_events: after.snapshot.known_billing_events,
        freedom_request: after.snapshot.freedom_request,
        compensation_counts: after.snapshot.compensation_counts,
        mhr_table_update: after.snapshot.mhr_table_update,
        snapshot_before: before.snapshot,
        snapshot_after: after.snapshot,
      });
    }
    const missingTables = OWNED_TABLES.filter((name) => !before.snapshot.owned_tables.includes(name));
    const missingFns = OWNED_FUNCTIONS.filter((name) => !before.snapshot.owned_functions.includes(name));
    return ok({
      action,
      present: missingTables.length === 0 && missingFns.length === 0,
      missingTables,
      missingFns,
      sql47_sha256: embedded.details.hash,
      live_definition_sha256: before.live_definition_sha256,
      sql39_hash: before.snapshot.sql39_hash,
      snapshot: before.snapshot,
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
