/**
 * Staging-only A47/A48 demo compensation exclude oneshot.
 * Default action is inspect. Apply requires confirm token.
 * Does not accept caller SQL. Does not target production.
 * Does not delete rows. Does not touch tenant billing or money rails.
 * Does not permanently weaken paid-row immutability.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL50_DOC_SHA256,
  PINNED_TEMP_TRIGGER_SHA256,
  PINNED_RESTORE_TRIGGER_SHA256,
  APPLY_CONFIRM,
  AUTHORIZED_IDS_FINGERPRINT,
  SYNTHETIC_TENANT_ID,
  ALLOWED_AGENTS,
  ALLOWED_REQUESTS,
  ALLOWED_CHECKS,
  KNOWN_ROOT_IDS,
  FORBIDDEN_REQUESTS,
  EXCLUDE_REASON,
  EXCLUSIONS_INSERT_SQL,
  EXCLUDE_UPDATE_SQL,
  AUDIT_INSERT_SQL,
  TRIGGER_DEF_SQL,
} from './constants.mjs';

export {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL50_DOC_SHA256,
  PINNED_TEMP_TRIGGER_SHA256,
  PINNED_RESTORE_TRIGGER_SHA256,
  APPLY_CONFIRM,
  AUTHORIZED_IDS_FINGERPRINT,
  SYNTHETIC_TENANT_ID,
  ALLOWED_REQUESTS,
  ALLOWED_CHECKS,
  KNOWN_ROOT_IDS,
  EXCLUDE_REASON,
  EXCLUSIONS_INSERT_SQL,
  EXCLUDE_UPDATE_SQL,
};

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = [
  path.join(ROOT, '..', 'sql'),
  path.join(ROOT, 'sql'),
].find((dir) => fs.existsSync(path.join(dir, '50_restore_sql47_trigger.sql')));
const SQL50_DOC = path.join(SQL_DIR || ROOT, '50_exclude_mortgage_agent_compensation.sql');
const SQL_TEMP = path.join(SQL_DIR || ROOT, '50_temp_allowlist_trigger.sql');
const SQL_RESTORE = path.join(SQL_DIR || ROOT, '50_restore_sql47_trigger.sql');
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
  if (action === 'apply' && event.expected_ids_fingerprint !== AUTHORIZED_IDS_FINGERPRINT) {
    return fail('ID_FINGERPRINT_MISMATCH', 'apply requires the inspect-locked A47/A48 fingerprint', {
      expected: AUTHORIZED_IDS_FINGERPRINT,
      got: event.expected_ids_fingerprint || null,
    });
  }
  if (event.reapply_sql47 === true || event.delete === true || event.demo === true) {
    return fail('UNRELATED_MUTATION', 'delete / demo / SQL 47 reapply are forbidden');
  }
  return null;
}

function readPinned(sqlFile, expected, label) {
  if (!fs.existsSync(sqlFile)) {
    return fail('INVALID_MANIFEST', `${label} is missing`);
  }
  const text = fs.readFileSync(sqlFile, 'utf8');
  const hash = sha256(text);
  if (hash !== expected) {
    return fail('SQL_COLLISION', `${label} hash mismatch`, { hash, expected });
  }
  const executable = text.replace(/--.*$/gm, '');
  if (/DELETE\s+FROM\s+public\.mortgage_agent_compensation_entries/i.test(text)) {
    return fail('UNRELATED_MUTATION', `${label} must not delete compensation rows`);
  }
  if (/mortgage_handling_requests|check_billing_events/i.test(executable)) {
    return fail('UNRELATED_MUTATION', `${label} must not touch Desk requests or tenant billing`);
  }
  if (/\bmoov\b|\bstripe\b|\bach\b|\bwallet\b/i.test(executable)) {
    return fail('UNRELATED_MUTATION', `${label} must not reference money rails`);
  }
  return ok({ text, hash, label });
}

export function readEmbeddedSql() {
  const doc = readPinned(SQL50_DOC, PINNED_SQL50_DOC_SHA256, 'SQL 50 doc');
  if (!doc.ok) return doc;
  const temp = readPinned(SQL_TEMP, PINNED_TEMP_TRIGGER_SHA256, 'temp allowlist trigger');
  if (!temp.ok) return temp;
  const restore = readPinned(SQL_RESTORE, PINNED_RESTORE_TRIGGER_SHA256, 'SQL 47 trigger restore');
  if (!restore.ok) return restore;
  if (!/a47cad99-0000-4000-8000-000000000021/.test(temp.details.text)) {
    return fail('INVALID_MANIFEST', 'temp trigger must hard-bind the A47/A48 allowlist');
  }
  if (/NEW\.status NOT IN \('voided', 'excluded'\)/.test(restore.details.text)
      || /NEW\.status = 'excluded'/.test(restore.details.text)) {
    return fail('UNRELATED_MUTATION', 'restore trigger must not keep a paid carve-out');
  }
  if (!/OLD\.status = 'paid' AND NEW\.status IS DISTINCT FROM 'paid'/.test(restore.details.text)) {
    return fail('INVALID_MANIFEST', 'restore trigger must keep paid-row immutability');
  }
  return ok({
    hash: doc.details.hash,
    temp: temp.details.text,
    restore: restore.details.text,
    temp_sha256: temp.details.hash,
    restore_sha256: restore.details.hash,
  });
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

export function triggerPreservesPaidImmutability(definition) {
  const def = String(definition || '');
  return /OLD\.status = 'paid' AND NEW\.status IS DISTINCT FROM 'paid'/.test(def)
    && !/NEW\.status = 'excluded'/.test(def)
    && !/NEW\.status NOT IN \('voided', 'excluded'\)/.test(def);
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

async function liveTriggerState(client) {
  const def = (await client.query(TRIGGER_DEF_SQL)).rows[0]?.def || '';
  return {
    trigger_restored: triggerPreservesPaidImmutability(def),
    trigger_has_demo_allowlist: /a47cad99-0000-4000-8000-000000000021/.test(def),
  };
}

export function boundaryFingerprint(rows) {
  return sha256(JSON.stringify(rows));
}

async function loadBoundaries(client) {
  const cbe = await client.query(
    `SELECT id::text, check_intake_item_id::text, event_type, unit_price_cents, status
       FROM public.check_billing_events
      WHERE check_intake_item_id = ANY($1::uuid[])
      ORDER BY id`,
    [ALLOWED_CHECKS],
  );
  const mhr = await client.query(
    `SELECT id::text, status, assigned_employee_id::text, accepted_at, completed_at, cancelled_at
       FROM public.mortgage_handling_requests
      WHERE id = ANY($1::uuid[])
      ORDER BY id`,
    [ALLOWED_REQUESTS],
  );
  const exclusions = await client.query(
    `SELECT mortgage_request_id::text, reason
       FROM public.mortgage_agent_compensation_exclusions
      WHERE mortgage_request_id = ANY($1::uuid[])
      ORDER BY mortgage_request_id`,
    [ALLOWED_REQUESTS],
  );
  const foreign = await client.query(
    `SELECT count(*)::int AS n
       FROM public.mortgage_agent_compensation_entries
      WHERE mortgage_request_id = ANY($1::uuid[])`,
    [FORBIDDEN_REQUESTS],
  );
  return {
    cbe_rows: cbe.rows,
    cbe_fingerprint: boundaryFingerprint(cbe.rows),
    mhr_rows: mhr.rows,
    mhr_fingerprint: boundaryFingerprint(mhr.rows),
    exclusion_rows: exclusions.rows,
    forbidden_entry_count: Number(foreign.rows[0]?.n || 0),
  };
}

async function probeUnauthorizedPaidExclude(client) {
  const paid = await client.query(
    `SELECT id::text
       FROM public.mortgage_agent_compensation_entries
      WHERE status = 'paid'
        AND tenant_id IS DISTINCT FROM $1::uuid
      ORDER BY id
      LIMIT 1`,
    [SYNTHETIC_TENANT_ID],
  );
  if (!paid.rows[0]) {
    return { probed: false, rejected: null, reason: 'no_non_synthetic_paid_row' };
  }
  await client.query('BEGIN');
  try {
    await client.query(
      `UPDATE public.mortgage_agent_compensation_entries
          SET status = 'excluded'
        WHERE id = $1::uuid`,
      [paid.rows[0].id],
    );
    await client.query('ROLLBACK');
    return { probed: true, rejected: false, id: paid.rows[0].id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    return {
      probed: true,
      rejected: /compensation_paid_immutable/.test(String(error.message || '')),
      id: paid.rows[0].id,
      message: String(error.message || '').slice(0, 200),
    };
  }
}

export async function handleEvent(event = {}, env = process.env, deps = {}) {
  const refused = refuseEvent(event, env);
  if (refused) return refused;
  const embedded = readEmbeddedSql();
  if (!embedded.ok) return embedded;
  const action = String(event.action || 'inspect');
  const period = String(event.period || '2026-10');
  if (action !== 'inspect') consumeOneUse(event.one_use_id);

  const client = deps.client || await adminClient(env);
  const close = !deps.client;
  try {
    const snapshot = await loadSnapshot(client, period);
    const trigger = await liveTriggerState(client);
    const boundaries = await loadBoundaries(client);
    if (action === 'inspect' || action === 'verify') {
      const probe = action === 'verify'
        ? await probeUnauthorizedPaidExclude(client)
        : { probed: false, reason: 'inspect_skips_mutation_probe' };
      return ok({
        action,
        executed: false,
        sql50_doc_sha256: embedded.details.hash,
        temp_trigger_sha256: embedded.details.temp_sha256,
        restore_trigger_sha256: embedded.details.restore_sha256,
        period,
        ...snapshot,
        ...trigger,
        ...boundaries,
        unauthorized_paid_exclude: probe,
        known_roots_present: KNOWN_ROOT_IDS.filter((id) => snapshot.entry_ids.includes(id)),
        note: action === 'verify'
          ? 'Verify only. No exclude applied in this action.'
          : 'Inspect only. Apply is a later authorization. SQL 50 is not a permanent trigger weakening.',
      });
    }
    if (!snapshot.safe) {
      return fail('ALLOWLIST_VIOLATION', 'refusing apply; family contains non-allowlisted rows', snapshot);
    }
    if (snapshot.ids_fingerprint !== AUTHORIZED_IDS_FINGERPRINT) {
      return fail('ID_FINGERPRINT_MISMATCH', 'live family IDs drifted after inspect', {
        expected: AUTHORIZED_IDS_FINGERPRINT,
        live: snapshot.ids_fingerprint,
        entry_ids: snapshot.entry_ids,
      });
    }
    const owner = (await client.query(
      `SELECT user_id FROM public.user_roles WHERE role = 'admin' ORDER BY user_id LIMIT 1`,
    )).rows[0];
    if (!owner?.user_id) {
      return fail('NOT_AUTHORIZED', 'no staging admin identity for exclude audit');
    }

    await client.query('BEGIN');
    try {
      await client.query(embedded.details.temp);
      const updated = await client.query(EXCLUDE_UPDATE_SQL, [
        [...snapshot.entry_ids],
        EXCLUDE_REASON,
        SYNTHETIC_TENANT_ID,
        [...ALLOWED_REQUESTS],
        [...ALLOWED_CHECKS],
        [...ALLOWED_AGENTS],
      ]);
      if (updated.rows.length !== snapshot.entry_ids.length) {
        throw new Error(`allowlisted update counted ${updated.rows.length}, expected ${snapshot.entry_ids.length}`);
      }
      for (const row of snapshot.rows) {
        await client.query(AUDIT_INSERT_SQL, [
          row.id,
          owner.user_id,
          row.status,
          EXCLUDE_REASON,
        ]);
      }
      await client.query(EXCLUSIONS_INSERT_SQL, [ALLOWED_REQUESTS, EXCLUDE_REASON]);
      await client.query(embedded.details.restore);
      const afterTrigger = await liveTriggerState(client);
      if (!afterTrigger.trigger_restored || afterTrigger.trigger_has_demo_allowlist) {
        throw new Error('SQL 47 paid-immutability trigger was not restored');
      }
      await client.query('COMMIT');
      const after = await loadSnapshot(client, period);
      const afterBoundaries = await loadBoundaries(client);
      const probe = await probeUnauthorizedPaidExclude(client);
      return ok({
        action,
        executed: true,
        excluded: updated.rows.length,
        payment_references_preserved: updated.rows.map((row) => ({
          id: row.id,
          status: row.status,
          payment_reference: row.payment_reference,
          paid_at: row.paid_at,
          amount_cents: row.amount_cents,
        })),
        before: snapshot,
        after,
        boundaries_before: boundaries,
        boundaries_after: afterBoundaries,
        billing_unchanged: boundaries.cbe_fingerprint === afterBoundaries.cbe_fingerprint,
        desk_unchanged: boundaries.mhr_fingerprint === afterBoundaries.mhr_fingerprint,
        unauthorized_paid_exclude: probe,
        ...afterTrigger,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => null);
      return fail('UNRELATED_MUTATION', error.message);
    }
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
