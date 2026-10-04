/**
 * Staging-only SQL 50 demo-compensation exclude oneshot.
 * Default action is inspect. Apply requires confirm token.
 * Does not accept caller SQL. Does not target production.
 * Does not delete rows. Does not touch tenant billing or money rails.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL50_SHA256,
  APPLY_CONFIRM,
  SYNTHETIC_TENANT_ID,
  ALLOWED_AGENTS,
  ALLOWED_REQUESTS,
  ALLOWED_CHECKS,
  KNOWN_ROOT_IDS,
  FORBIDDEN_REQUESTS,
  EXCLUDE_REASON,
  EXCLUSIONS_INSERT_SQL,
} from './constants.mjs';

export {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL50_SHA256,
  APPLY_CONFIRM,
  SYNTHETIC_TENANT_ID,
  ALLOWED_REQUESTS,
  ALLOWED_CHECKS,
  KNOWN_ROOT_IDS,
  EXCLUDE_REASON,
  EXCLUSIONS_INSERT_SQL,
};

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL50 = path.join(ROOT, '..', 'sql', '50_exclude_mortgage_agent_compensation.sql');
const consumed = new Set();

export function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

export function fail(code, message, details = {}) {
  return { ok: false, code, message, details, errors: [{ code, message, details }] };
}

export function ok(details = {}) {
  return { ok: true, code: null, message: null, details, errors: [] };
}

export function refuseEvent(event = {}, env = process.env) {
  if (event.sql_text != null || event.sql != null || event.statement != null || event.arbitrary_sql != null) {
    return fail('UNRELATED_MUTATION', 'arbitrary SQL text is forbidden');
  }
  const host = String(env.RDS_HOST || event.rds_host || '');
  if (/production/i.test(host) || event.target_environment === 'production') {
    return fail('PRODUCTION_APPROVAL_REQUIRED', 'this oneshot is staging-only');
  }
  const name = event.function_name || env.AWS_LAMBDA_FUNCTION_NAME || FUNCTION_NAME;
  if (FORBIDDEN_FUNCTIONS.includes(name) || name !== FUNCTION_NAME) {
    return fail('UNRELATED_MUTATION', 'oneshot may not retarget a shared or production function', {
      function_name: name,
    });
  }
  const action = String(event.action || 'inspect').trim();
  if (!['inspect', 'apply', 'verify'].includes(action)) {
    return fail('INVALID_MANIFEST', `unsupported action ${action}`);
  }
  if (action === 'apply' && event.confirm !== APPLY_CONFIRM) {
    return fail('APPLY_NOT_CONFIRMED', 'apply requires confirm=STAGING_EXCLUDE_MACOMP_DEMO_A47_A48');
  }
  if (event.reapply_sql47 === true || event.delete === true || event.demo === true) {
    return fail('UNRELATED_MUTATION', 'delete / demo / SQL 47 reapply are forbidden');
  }
  return null;
}

export function readEmbeddedSql(sqlFile = SQL50, expected = PINNED_SQL50_SHA256) {
  if (!fs.existsSync(sqlFile)) {
    return fail('INVALID_MANIFEST', 'embedded SQL 50 is missing');
  }
  const text = fs.readFileSync(sqlFile, 'utf8');
  const hash = sha256(text);
  if (hash !== expected) {
    return fail('SQL_COLLISION', 'embedded SQL 50 hash mismatch', { hash, expected });
  }
  const executable = text.replace(/--.*$/gm, '');
  if (/DELETE\s+FROM\s+public\.mortgage_agent_compensation_entries/i.test(text)) {
    return fail('UNRELATED_MUTATION', 'SQL 50 must not delete compensation rows');
  }
  if (/mortgage_handling_requests|check_billing_events/i.test(executable)) {
    return fail('UNRELATED_MUTATION', 'SQL 50 must not touch Desk requests or tenant billing');
  }
  if (/\bmoov\b|\bstripe\b|\bach\b|\bwallet\b/i.test(executable)) {
    return fail('UNRELATED_MUTATION', 'SQL 50 must not reference money rails');
  }
  return ok({ text, hash });
}

export const FAMILY_SELECT_SQL = `
SELECT
    e.id::text,
    e.parent_entry_id::text AS parent_entry_id,
    e.agent_user_id::text AS agent_user_id,
    e.mortgage_request_id::text AS mortgage_request_id,
    e.check_intake_item_id::text AS check_intake_item_id,
    e.claim_id::text AS claim_id,
    e.tenant_id::text AS tenant_id,
    e.classification,
    e.amount_cents,
    e.status,
    e.pay_period,
    e.earned_at,
    e.completed_at,
    e.payment_reference,
    e.paid_at,
    e.adjustment_reason,
    e.exclusion_reason
 FROM public.mortgage_agent_compensation_entries e
 WHERE e.mortgage_request_id = ANY($1::uuid[])
    OR e.check_intake_item_id = ANY($2::uuid[])
    OR e.id = ANY($3::uuid[])
    OR e.parent_entry_id = ANY($3::uuid[])
 ORDER BY e.created_at, e.id`;

export function idsFingerprint(ids) {
  return sha256([...new Set(ids.map((id) => String(id)))].sort().join(','));
}

export function monthlyFromRows(rows, period = '2026-10') {
  const live = rows.filter((row) => (
    row.pay_period === period && !['voided', 'excluded'].includes(row.status)
  ));
  const roots = live.filter((row) => !row.parent_entry_id);
  return {
    initial_count: roots.filter((row) => row.classification === 'initial').length,
    additional_count: roots.filter((row) => row.classification === 'additional').length,
    files_worked: roots.length,
    adjustment_cents: live
      .filter((row) => row.parent_entry_id)
      .reduce((sum, row) => sum + Number(row.amount_cents || 0), 0),
    gross_owed_cents: live.reduce((sum, row) => sum + Number(row.amount_cents || 0), 0),
    paid_cents: live
      .filter((row) => row.status === 'paid')
      .reduce((sum, row) => sum + Number(row.amount_cents || 0), 0),
    balance_cents: live
      .filter((row) => ['earned', 'approved'].includes(row.status))
      .reduce((sum, row) => sum + Number(row.amount_cents || 0), 0),
  };
}

export function classifyFamily(rows) {
  const rejected = [];
  const accepted = [];
  for (const row of rows) {
    const reasons = [];
    if (FORBIDDEN_REQUESTS.includes(row.mortgage_request_id)) reasons.push('forbidden_request');
    if (row.tenant_id !== SYNTHETIC_TENANT_ID) reasons.push('tenant_mismatch');
    if (!ALLOWED_REQUESTS.includes(row.mortgage_request_id)) reasons.push('request_not_allowlisted');
    if (row.check_intake_item_id && !ALLOWED_CHECKS.includes(row.check_intake_item_id)) {
      reasons.push('check_not_allowlisted');
    }
    if (!ALLOWED_AGENTS.includes(row.agent_user_id)) reasons.push('agent_not_allowlisted');
    if (reasons.length) rejected.push({ ...row, reject_reasons: reasons });
    else accepted.push(row);
  }
  return { accepted, rejected };
}

export function summarizeCleanup(familyRows, periodRows, period = '2026-10') {
  const family = classifyFamily(familyRows);
  const beforeFamily = monthlyFromRows(family.accepted, period);
  const afterFamily = {
    initial_count: 0,
    additional_count: 0,
    files_worked: 0,
    adjustment_cents: 0,
    gross_owed_cents: 0,
    paid_cents: 0,
    balance_cents: 0,
  };
  const beforePeriod = monthlyFromRows(periodRows, period);
  const familyIds = new Set(family.accepted.map((row) => row.id));
  const afterPeriod = monthlyFromRows(
    periodRows.filter((row) => !familyIds.has(row.id)),
    period,
  );
  return {
    safe: family.rejected.length === 0,
    rejected: family.rejected,
    entry_ids: family.accepted.map((row) => row.id),
    ids_fingerprint: idsFingerprint(family.accepted.map((row) => row.id)),
    rows: family.accepted,
    before_family: beforeFamily,
    after_family: afterFamily,
    before_period: beforePeriod,
    after_period: afterPeriod,
  };
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
  if (!arn || !/checksops_admin/i.test(arn) || /production/i.test(arn)) {
    throw new Error('ADMIN_SECRET_ARN must be the staging checksops_admin secret');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : env.RDS_HOST;
  if (!host || /production/i.test(host) || host === 'localhost') {
    throw new Error(`refusing host ${host}`);
  }
  const ca = [
    path.join(ROOT, 'rds-global-bundle.pem'),
    '/var/task/rds-global-bundle.pem',
  ].find((p) => fs.existsSync(p));
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(ca, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  await client.connect();
  return client;
}

async function loadSnapshot(client, period) {
  const family = await client.query(FAMILY_SELECT_SQL, [
    ALLOWED_REQUESTS,
    ALLOWED_CHECKS,
    KNOWN_ROOT_IDS,
  ]);
  const periodRows = await client.query(
    `SELECT
        e.id::text,
        e.parent_entry_id::text AS parent_entry_id,
        e.agent_user_id::text AS agent_user_id,
        e.mortgage_request_id::text AS mortgage_request_id,
        e.check_intake_item_id::text AS check_intake_item_id,
        e.claim_id::text AS claim_id,
        e.tenant_id::text AS tenant_id,
        e.classification,
        e.amount_cents,
        e.status,
        e.pay_period,
        e.earned_at,
        e.completed_at,
        e.payment_reference,
        e.paid_at,
        e.adjustment_reason,
        e.exclusion_reason
     FROM public.mortgage_agent_compensation_entries e
     WHERE e.pay_period = $1
     ORDER BY e.created_at, e.id`,
    [period],
  );
  return summarizeCleanup(family.rows, periodRows.rows, period);
}

export async function handleEvent(event = {}, env = process.env, deps = {}) {
  const refused = refuseEvent(event, env);
  if (refused) return refused;
  const embedded = readEmbeddedSql(deps.sqlFile || SQL50);
  if (!embedded.ok) return embedded;
  const action = String(event.action || 'inspect');
  const period = String(event.period || '2026-10');
  if (action !== 'inspect') consumeOneUse(event.one_use_id);

  const client = deps.client || await adminClient(env);
  const close = !deps.client;
  try {
    const snapshot = await loadSnapshot(client, period);
    if (action === 'inspect' || action === 'verify') {
      return ok({
        action,
        executed: false,
        sql50_sha256: embedded.details.hash,
        period,
        ...snapshot,
        known_roots_present: KNOWN_ROOT_IDS.filter((id) => snapshot.entry_ids.includes(id)),
        note: 'Inspect only. Apply is a later authorization.',
      });
    }
    if (!snapshot.safe) {
      return fail('ALLOWLIST_VIOLATION', 'refusing apply; family contains non-allowlisted rows', snapshot);
    }
    if (event.expected_ids_fingerprint && event.expected_ids_fingerprint !== snapshot.ids_fingerprint) {
      return fail('ID_FINGERPRINT_MISMATCH', 'live family IDs drifted after inspect', {
        expected: event.expected_ids_fingerprint,
        live: snapshot.ids_fingerprint,
        entry_ids: snapshot.entry_ids,
      });
    }
    await client.query(embedded.details.text);
    const owner = (await client.query(
      `SELECT user_id FROM public.user_roles WHERE role = 'admin' ORDER BY user_id LIMIT 1`,
    )).rows[0];
    if (!owner?.user_id) {
      return fail('NOT_AUTHORIZED', 'no staging admin identity for exclude RPC');
    }
    const excluded = await client.query(`
      SELECT public.exclude_mortgage_agent_compensation($2::uuid[], $3) AS n
      FROM (SELECT set_config('request.app_user_id', $1, true) AS uid) cfg
    `, [
      owner.user_id,
      snapshot.entry_ids,
      EXCLUDE_REASON,
    ]);
    // Cover allowlisted requests with no payable yet (a47…023 cancel-before-complete).
    await client.query(EXCLUSIONS_INSERT_SQL, [ALLOWED_REQUESTS, EXCLUDE_REASON]);
    const after = await loadSnapshot(client, period);
    return ok({
      action,
      executed: true,
      excluded: Number(excluded.rows[0]?.n || 0),
      before: snapshot,
      after,
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
