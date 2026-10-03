/**
 * Dedicated staging-only SQL 48/49 oneshot.
 * Does not reapply SQL 47. Does not update the shared executor.
 * Does not target production. Does not accept caller SQL.
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
} from './constants.mjs';

export {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL47_SHA256,
  PINNED_SQL48_SHA256,
  PINNED_SQL49_SHA256,
};

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL47 = path.join(ROOT, 'sql', '47_mortgage_agent_compensation.sql');
const SQL48 = path.join(ROOT, 'sql', '48_return_mortgage_request_to_queue.sql');
const SQL49 = path.join(ROOT, 'sql', '49_adjust_mortgage_agent_compensation.sql');
const FREEDOM = '5b20db20-13e1-4919-9528-06388d8661d2';
const DEMO = Object.freeze({
  req1: 'a48cad99-0000-4000-8000-000000000021',
  reqPromo: 'a48cad99-0000-4000-8000-000000000024',
  check1: 'a48cad99-0000-4000-8000-000000000011',
  checkPromo: 'a48cad99-0000-4000-8000-000000000013',
  claim: 'a48cad99-0000-4000-8000-0000000000c1',
});
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
  if (!['inspect', 'apply', 'verify', 'demo'].includes(action)) {
    return fail('INVALID_MANIFEST', `unsupported action ${action}`);
  }
  if (event.reapply_sql47 === true || event.apply_sql47 === true) {
    return fail('UNRELATED_MUTATION', 'SQL 47 reapply is forbidden');
  }
  return null;
}

function assertSql(file, expected, label) {
  if (!fs.existsSync(file)) return fail('INVALID_MANIFEST', `${label} is missing`);
  const text = fs.readFileSync(file, 'utf8');
  const hash = sha256(text);
  if (hash !== expected) {
    return fail('SQL_COLLISION', `${label} hash mismatch`, { hash, expected });
  }
  const executable = text.replace(/--.*$/gm, '');
  if (/GRANT\s+UPDATE\s+ON\s+TABLE\s+public\.mortgage_handling_requests/i.test(text)) {
    return fail('UNRELATED_MUTATION', `${label} must not grant table-level MHR UPDATE`);
  }
  if (/ALTER\s+TABLE\s+public\.mortgage_handling_requests/i.test(text)) {
    return fail('UNRELATED_MUTATION', `${label} must not ALTER mortgage_handling_requests`);
  }
  if (/\bmoov\b|\bstripe\b|\bach\b|\bwallet\b/i.test(executable)) {
    return fail('UNRELATED_MUTATION', `${label} must not reference money rails`);
  }
  return ok({ text, hash });
}

export function readEmbeddedSql(files = { sql47: SQL47, sql48: SQL48, sql49: SQL49 }) {
  const sql47 = files.sql47 && fs.existsSync(files.sql47)
    ? assertSql(files.sql47, PINNED_SQL47_SHA256, 'SQL 47')
    : ok({ text: null, hash: PINNED_SQL47_SHA256, skipped: true });
  const sql48 = assertSql(files.sql48 || SQL48, PINNED_SQL48_SHA256, 'SQL 48');
  const sql49 = assertSql(files.sql49 || SQL49, PINNED_SQL49_SHA256, 'SQL 49');
  if (!sql47.ok) return sql47;
  if (!sql48.ok) return sql48;
  if (!sql49.ok) return sql49;
  return ok({
    sql47: sql47.details,
    sql48: sql48.details,
    sql49: sql49.details,
  });
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

async function functionDef(client, name, nargs = null) {
  const { rows } = await client.query(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = $1
      AND ($2::int IS NULL OR p.pronargs = $2)
    ORDER BY p.pronargs
    LIMIT 1
  `, [name, nargs]);
  return rows[0]?.def || null;
}

export async function snapshotCatalog(client) {
  const indexes = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'check_billing_events'
    ORDER BY 1
  `);
  const ownedFns = await client.query(`
    SELECT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY($1::text[])
    ORDER BY 1
  `, [[
    'earn_mortgage_agent_compensation',
    'return_mortgage_handling_request_to_queue',
    'adjust_mortgage_agent_compensation',
    'aws_can_admin_mortgage_agent_compensation',
  ]]);
  const audit = await client.query(`
    SELECT to_regclass('public.mortgage_ops_request_audit') IS NOT NULL AS present
  `);
  const adjCol = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='mortgage_agent_compensation_entries'
      AND column_name='adjustment_reason'
  `);
  const mhrTableUpdate = await client.query(`
    SELECT grantee
    FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='mortgage_handling_requests'
      AND privilege_type='UPDATE' AND grantee IN ('checksops','authenticated')
  `);
  const freedom = await client.query(`
    SELECT id, status, assigned_employee_id, accepted_at, completed_at
    FROM public.mortgage_handling_requests WHERE id = $1
  `, [FREEDOM]).catch(() => ({ rows: [] }));
  const protectedDefs = {
    accrue_mortgage_ops_billing: await functionDef(client, 'accrue_mortgage_ops_billing', 1),
    aws_is_mortgage_ops_agent: await functionDef(client, 'aws_is_mortgage_ops_agent', 1),
    earn_mortgage_agent_compensation: await functionDef(client, 'earn_mortgage_agent_compensation', 1),
  };
  const snapshot = {
    cbe_indexes: indexes.rows,
    mortgage_ops_per_check: indexes.rows.filter((row) => (
      /UNIQUE/i.test(row.indexdef)
      && /check_intake_item_id/i.test(row.indexdef)
      && /mortgage_ops_initial/i.test(row.indexdef)
      && /mortgage_ops_additional_check/i.test(row.indexdef)
      && !/\(tenant_id, check_intake_item_id, event_type\)/i.test(row.indexdef)
      && !/\(check_intake_item_id, event_type\)/i.test(row.indexdef)
    )),
    owned_functions: ownedFns.rows.map((r) => r.proname),
    request_audit_present: audit.rows[0]?.present === true,
    adjustment_reason_present: adjCol.rows.length > 0,
    mhr_table_update: mhrTableUpdate.rows,
    freedom: freedom.rows[0] || null,
    protected_hashes: Object.fromEntries(
      Object.entries(protectedDefs).map(([k, v]) => [k, v ? sha256(v) : null]),
    ),
  };
  return { snapshot, live_definition_sha256: sha256(JSON.stringify(snapshot)) };
}

async function tableColumns(client, table) {
  const { rows } = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
  `, [table]);
  return new Set(rows.map((r) => r.column_name));
}

function addIfPresent(names, fields, values, name, value) {
  if (names.has(name)) {
    fields.push(name);
    values.push(value);
  }
}

async function ensureDemoClaim(client, tenantId) {
  const existing = await client.query(`SELECT id FROM public.claims WHERE id=$1`, [DEMO.claim]);
  if (existing.rows[0]) return DEMO.claim;
  const names = await tableColumns(client, 'claims');
  const fields = ['id'];
  const values = [DEMO.claim];
  addIfPresent(names, fields, values, 'org_id', tenantId);
  addIfPresent(names, fields, values, 'tenant_id', tenantId);
  addIfPresent(names, fields, values, 'claim_number', 'MACOMP48-STAGING-DEMO');
  addIfPresent(names, fields, values, 'policyholder_name', 'MACOMP48 STAGING DEMO');
  addIfPresent(names, fields, values, 'insured_name', 'MACOMP48 STAGING DEMO');
  addIfPresent(names, fields, values, 'status', 'open');
  await client.query(
    `INSERT INTO public.claims (${fields.join(', ')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  );
  return DEMO.claim;
}

async function ensureDemoCheck(client, tenantId, checkId, ownerId, claimId) {
  const existing = await client.query(`SELECT id FROM public.check_intake_items WHERE id=$1`, [checkId]);
  if (existing.rows[0]) return checkId;
  const names = await tableColumns(client, 'check_intake_items');
  const fields = ['id'];
  const values = [checkId];
  addIfPresent(names, fields, values, 'tenant_id', tenantId);
  addIfPresent(names, fields, values, 'claim_id', claimId);
  addIfPresent(names, fields, values, 'uploaded_by', ownerId);
  addIfPresent(names, fields, values, 'front_image_path', `synthetic/macomp48/${checkId}/NOT-A-NEGOTIABLE-INSTRUMENT.txt`);
  addIfPresent(names, fields, values, 'status', 'uploaded');
  addIfPresent(names, fields, values, 'payee_line', 'MACOMP48 STAGING DEMO');
  addIfPresent(names, fields, values, 'amount', 0);
  addIfPresent(names, fields, values, 'review_notes', 'MACOMP48 staging fixture. Not a negotiable instrument.');
  await client.query(
    `INSERT INTO public.check_intake_items (${fields.join(', ')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  );
  return checkId;
}

async function asUser(client, userId, sql, params = []) {
  const { rows } = await client.query(`
    SELECT (${sql}) AS result
    FROM (
      SELECT set_config('request.app_user_id', $1, true) AS uid
    ) cfg
  `, [userId, ...params]);
  return rows[0]?.result;
}

async function runDemo(client) {
  const notes = [];
  const scenarios = {};
  const note = (key, line, pass) => {
    notes.push(line);
    if (key) scenarios[key] = { pass, detail: line };
  };
  const scalar = async (sql, params = []) => {
    const { rows } = await client.query(sql, params);
    const first = rows[0] || {};
    return first[Object.keys(first)[0]];
  };

  const owner = (await client.query(`
    SELECT p.id AS user_id, p.email
    FROM public.profiles p
    WHERE lower(p.email) = 'checksopsadmin@gmail.com'
    UNION ALL
    SELECT ur.user_id, p.email
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role = 'admin'
    LIMIT 1
  `)).rows[0];
  const agents = (await client.query(`
    SELECT ur.user_id, p.email
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role = 'mortgage_agent'
    ORDER BY p.email
    LIMIT 2
  `)).rows;
  const tenant = (await client.query(`
    SELECT id, name
    FROM public.tenants
    WHERE COALESCE(is_test_account, false) = true
       OR slug ILIKE '%test%'
       OR name ILIKE '%test%'
    ORDER BY created_at DESC NULLS LAST
    LIMIT 1
  `)).rows[0] || (await client.query(`
    SELECT id, name FROM public.tenants
    WHERE id <> '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a'
    ORDER BY created_at DESC NULLS LAST LIMIT 1
  `)).rows[0];
  const agentA = agents[0];
  const agentB = agents[1];
  if (!owner?.user_id || !agentA?.user_id || !agentB?.user_id || !tenant?.id) {
    return fail('INVALID_MANIFEST', 'demo needs admin + two mortgage agents + tenant', {
      owner, agents, tenant,
    });
  }

  await client.query(`
    INSERT INTO public.mortgage_agent_accounts (application_user_id, status)
    VALUES ($1, 'active'), ($2, 'active')
    ON CONFLICT (application_user_id) DO NOTHING
  `, [agentA.user_id, agentB.user_id]);

  await client.query(`
    DELETE FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id = ANY($1::uuid[])
       OR check_intake_item_id = ANY($2::uuid[])
  `, [[DEMO.req1, DEMO.reqPromo], [DEMO.check1, DEMO.checkPromo]]);
  await client.query(`DELETE FROM public.mortgage_ops_request_audit WHERE mortgage_request_id = ANY($1::uuid[])`, [[DEMO.req1, DEMO.reqPromo]]).catch(() => null);
  await client.query(`DELETE FROM public.mortgage_handling_requests WHERE id = ANY($1::uuid[])`, [[DEMO.req1, DEMO.reqPromo]]);
  await client.query(`
    DELETE FROM public.check_billing_events
    WHERE mortgage_request_id = ANY($1::uuid[])
       OR check_intake_item_id = ANY($2::uuid[])
  `, [[DEMO.req1, DEMO.reqPromo], [DEMO.check1, DEMO.checkPromo]]).catch(() => null);

  const claimId = await ensureDemoClaim(client, tenant.id);
  await ensureDemoCheck(client, tenant.id, DEMO.check1, owner.user_id, claimId);
  await ensureDemoCheck(client, tenant.id, DEMO.checkPromo, owner.user_id, claimId);
  const insertReq = async (id, checkId, loan) => {
    await client.query(`
      INSERT INTO public.mortgage_handling_requests
        (id, tenant_id, check_intake_item_id, claim_id, mortgage_company, loan_number, status)
      VALUES ($1,$2,$3,$4,'MACOMP48 STAGING DEMO',$5,'requested')
    `, [id, tenant.id, checkId, claimId, loan]);
  };
  await insertReq(DEMO.req1, DEMO.check1, 'MACOMP48-1');
  await insertReq(DEMO.reqPromo, DEMO.checkPromo, 'MACOMP48-P');

  const acceptFn = await functionDef(client, 'accept_mortgage_handling_request', 1);
  const accept = async (reqId, agentId) => {
    if (acceptFn) {
      await asUser(client, agentId, `public.accept_mortgage_handling_request($2::uuid)`, [reqId]);
      return;
    }
    await client.query(`
      UPDATE public.mortgage_handling_requests
         SET assigned_employee_id=$2, status='in_progress',
             accepted_at=COALESCE(accepted_at, now()), updated_at=now()
       WHERE id=$1 AND assigned_employee_id IS NULL AND status='requested'
    `, [reqId, agentId]);
  };

  await accept(DEMO.req1, agentA.user_id);
  const billing = await client.query(`
    SELECT id, event_type, unit_price_cents, status, created_at
    FROM public.check_billing_events
    WHERE check_intake_item_id=$1
      AND event_type IN ('mortgage_ops_initial','mortgage_ops_additional_check')
    ORDER BY created_at
  `, [DEMO.check1]);
  note('s1', `1 Agent A Accept billing=${billing.rows.length}`, billing.rows.length >= 1);
  note('s2', `2 exactly one tenant event=${billing.rows.length}`, billing.rows.length === 1);
  const acceptedAt = await scalar(`SELECT accepted_at FROM public.mortgage_handling_requests WHERE id=$1`, [DEMO.req1]);
  const billingFp = JSON.stringify(billing.rows[0] || null);

  await asUser(client, owner.user_id, `public.return_mortgage_handling_request_to_queue($2::uuid, $3)`, [DEMO.req1, 'Agent A unavailable']);
  const afterReturn = (await client.query(`
    SELECT status, assigned_employee_id, accepted_at FROM public.mortgage_handling_requests WHERE id=$1
  `, [DEMO.req1])).rows[0];
  const billingAfterReturn = await client.query(`
    SELECT id, event_type, unit_price_cents, status FROM public.check_billing_events WHERE id=$1
  `, [billing.rows[0]?.id]);
  note('s3', `3 returned status=${afterReturn.status} assignee=${afterReturn.assigned_employee_id}`, afterReturn.status === 'requested' && afterReturn.assigned_employee_id == null);
  note('s4', `4 accepted_at preserved`, String(afterReturn.accepted_at) === String(acceptedAt));
  note('s5', `5 original billing unchanged`, JSON.stringify(billingAfterReturn.rows[0]) === JSON.stringify({
    id: billing.rows[0]?.id,
    event_type: billing.rows[0]?.event_type,
    unit_price_cents: billing.rows[0]?.unit_price_cents,
    status: billing.rows[0]?.status,
  }));

  await accept(DEMO.req1, agentB.user_id);
  const billingAfterB = Number(await scalar(`
    SELECT count(*) FROM public.check_billing_events
    WHERE check_intake_item_id=$1
      AND event_type IN ('mortgage_ops_initial','mortgage_ops_additional_check')
  `, [DEMO.check1]));
  const assigneeB = await scalar(`SELECT assigned_employee_id FROM public.mortgage_handling_requests WHERE id=$1`, [DEMO.req1]);
  note('s6', `6 Agent B Accept assignee=${assigneeB}`, String(assigneeB) === String(agentB.user_id));
  note('s7', `7 no second tenant event count=${billingAfterB}`, billingAfterB === 1);

  await client.query(`
    UPDATE public.mortgage_handling_requests
       SET status='completed', completed_at=now(), updated_at=now()
     WHERE id=$1
  `, [DEMO.req1]);
  const roots = await client.query(`
    SELECT id, agent_user_id, amount_cents, status
    FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id=$1 AND parent_entry_id IS NULL AND status NOT IN ('voided','excluded')
  `, [DEMO.req1]);
  const aPay = Number(await scalar(`
    SELECT count(*) FROM public.mortgage_agent_compensation_entries
    WHERE agent_user_id=$1 AND mortgage_request_id=$2 AND parent_entry_id IS NULL
  `, [agentA.user_id, DEMO.req1]));
  note('s8', `8 B complete roots=${roots.rows.length}`, roots.rows.length === 1);
  note('s9', `9 root earned by B`, String(roots.rows[0]?.agent_user_id) === String(agentB.user_id));
  note('s10', `10 A earns nothing=${aPay}`, aPay === 0);

  await client.query(`
    UPDATE public.mortgage_handling_requests
       SET status='completed', completed_at=completed_at, updated_at=now()
     WHERE id=$1
  `, [DEMO.req1]);
  const dup = Number(await scalar(`
    SELECT count(*) FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id=$1 AND parent_entry_id IS NULL
  `, [DEMO.req1]));
  note('s11', `11 duplicate complete roots=${dup}`, dup === 1);

  let s12 = false;
  try {
    await asUser(client, owner.user_id, `public.return_mortgage_handling_request_to_queue($2::uuid, $3)`, [DEMO.req1, 'too late']);
  } catch (error) {
    s12 = /compensation_already_exists|request_not_returnable/i.test(error.message);
  }
  note('s12', '12 return after compensation refused', s12);
  note('s13', '13 return after completion refused', s12);

  let s14 = false;
  try {
    await asUser(client, agentB.user_id, `public.return_mortgage_handling_request_to_queue($2::uuid, $3)`, [DEMO.req1, 'agent']);
  } catch (error) {
    s14 = /not_authorized/i.test(error.message);
  }
  note('s14', '14 mortgage agent return 403', s14);

  let s15 = false;
  try {
    await asUser(client, owner.user_id, `public.return_mortgage_handling_request_to_queue($2::uuid, $3)`, [FREEDOM, 'no']);
  } catch (error) {
    s15 = /request_excluded|request_not_returnable|not_authorized/i.test(error.message);
  }
  const freedomAfter = (await client.query(`
    SELECT id, status, assigned_employee_id, accepted_at, completed_at
    FROM public.mortgage_handling_requests WHERE id=$1
  `, [FREEDOM])).rows[0] || null;
  note('s15', '15 excluded Freedom refused', s15);

  const parentId = roots.rows[0]?.id;
  const factBefore = await client.query(`
    SELECT id, agent_user_id, amount_cents, classification, pay_period, accepted_at, completed_at, status
    FROM public.mortgage_agent_compensation_entries WHERE id=$1
  `, [parentId]);
  await asUser(client, owner.user_id, `public.adjust_mortgage_agent_compensation($2::uuid, $3::int, $4, NULL, NULL)`, [parentId, 250, 'underpayment']);
  const plus = Number(await scalar(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id=$1 AND amount_cents=250`, [parentId]));
  note('s16', `16 positive adjustment=${plus}`, plus === 1);
  await asUser(client, owner.user_id, `public.adjust_mortgage_agent_compensation($2::uuid, $3::int, $4, NULL, NULL)`, [parentId, -100, 'overpayment']);
  const minus = Number(await scalar(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id=$1 AND amount_cents=-100`, [parentId]));
  note('s17', `17 negative adjustment=${minus}`, minus === 1);

  await asUser(client, owner.user_id, `public.mark_mortgage_agent_compensation_paid(ARRAY[$2::uuid], CURRENT_DATE, $3, $4)`, [parentId, 'MACOMP48', 'bookkeeping only']);
  const paidBeforePair = await client.query(`
    SELECT id, agent_user_id, amount_cents, classification, pay_period, accepted_at, completed_at, status, payment_reference, paid_at
    FROM public.mortgage_agent_compensation_entries WHERE id=$1
  `, [parentId]);
  const beforePair = Number(await scalar(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id=$1`, [parentId]));
  let badPair = false;
  try {
    await asUser(client, owner.user_id, `public.adjust_mortgage_agent_compensation($2::uuid, $3::int, $4, $5::uuid, NULL)`, [
      parentId, 1000, 'bad', '00000000-0000-4000-8000-000000000099',
    ]);
  } catch (error) {
    badPair = /invalid_counterparty/i.test(error.message);
  }
  const afterBad = Number(await scalar(`SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE parent_entry_id=$1`, [parentId]));
  await asUser(client, owner.user_id, `public.adjust_mortgage_agent_compensation($2::uuid, $3::int, $4, $5::uuid, NULL)`, [
    parentId, 1000, 'wrong agent', agentA.user_id,
  ]);
  const pairedNeg = Number(await scalar(`
    SELECT count(*) FROM public.mortgage_agent_compensation_entries
    WHERE parent_entry_id=$1 AND agent_user_id=$2 AND amount_cents=-1000
  `, [parentId, agentB.user_id]));
  const pairedPos = Number(await scalar(`
    SELECT count(*) FROM public.mortgage_agent_compensation_entries
    WHERE parent_entry_id=$1 AND agent_user_id=$2 AND amount_cents=1000
  `, [parentId, agentA.user_id]));
  note('s18', `18 paired atomic bad=${badPair} afterBad=${afterBad} -B=${pairedNeg} +A=${pairedPos}`, badPair && afterBad === beforePair && pairedNeg === 1 && pairedPos === 1);

  const paidAfter = await client.query(`
    SELECT id, agent_user_id, amount_cents, classification, pay_period, accepted_at, completed_at, status, payment_reference, paid_at
    FROM public.mortgage_agent_compensation_entries WHERE id=$1
  `, [parentId]);
  note('s19', '19 paid parent unchanged', JSON.stringify(paidBeforePair.rows[0]) === JSON.stringify(paidAfter.rows[0]));

  const files = Number(await scalar(`
    SELECT count(*) FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id=$1 AND parent_entry_id IS NULL AND status NOT IN ('voided','excluded')
  `, [DEMO.req1]));
  const money = Number(await scalar(`
    SELECT coalesce(sum(amount_cents),0) FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id=$1 AND status NOT IN ('voided','excluded')
  `, [DEMO.req1]));
  note('s20', `20 monthly file count=${files}`, files === 1);
  note('s21', `21 monetary total=${money}`, money === 1000 + 250 - 100 - 1000 + 1000);

  try {
    await client.query(`
      INSERT INTO public.check_billing_events
        (tenant_id, check_intake_item_id, claim_id, mortgage_request_id, event_type, unit_price_cents)
      VALUES ($1,$2,$3,$4,'mortgage_ops_additional_check',0)
    `, [tenant.id, DEMO.checkPromo, claimId, DEMO.reqPromo]);
  } catch (error) {
    notes.push(`promo_billing_insert:${error.message.slice(0, 160)}`);
  }
  await accept(DEMO.reqPromo, agentB.user_id);
  await client.query(`
    UPDATE public.mortgage_handling_requests
       SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1
  `, [DEMO.reqPromo]);
  const promoPay = Number(await scalar(`
    SELECT amount_cents FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id=$1 AND parent_entry_id IS NULL LIMIT 1
  `, [DEMO.reqPromo]));
  const promoBill = Number(await scalar(`
    SELECT coalesce(unit_price_cents, -1) FROM public.check_billing_events
    WHERE check_intake_item_id=$1
      AND event_type IN ('mortgage_ops_initial','mortgage_ops_additional_check')
    LIMIT 1
  `, [DEMO.checkPromo]).catch(() => -1));
  note('s22', `22 $0 promo tenant=${promoBill} agent=${promoPay}`, (promoBill === 0 || promoBill === 500 || promoBill === 1000) && (promoPay === 500 || promoPay === 1000));

  const mhrUpdate = Number(await scalar(`
    SELECT count(*) FROM information_schema.role_table_grants
    WHERE table_name='mortgage_handling_requests' AND privilege_type='UPDATE'
      AND grantee IN ('checksops','authenticated')
  `));
  note('s23', `23 no MHR table UPDATE grants=${mhrUpdate}`, mhrUpdate === 0);

  const passed = Object.values(scenarios).every((row) => row.pass === true);
  return ok({
    passed,
    notes,
    scenarios,
    billing_fingerprint: billingFp,
    actor: { owner: owner.user_id, agent_a: agentA.user_id, agent_b: agentB.user_id, tenant: tenant.id },
    freedom_untouched: freedomAfter,
    fact_before: factBefore.rows[0],
    paid_after: paidAfter.rows[0],
  });
}

export async function handleEvent(event = {}, env = process.env, deps = {}) {
  const refused = refuseEvent(event, env);
  if (refused) return refused;
  const embedded = readEmbeddedSql(deps.files || undefined);
  if (!embedded.ok) return embedded;
  const action = String(event.action || 'inspect');
  if (action !== 'inspect') consumeOneUse(event.one_use_id);

  const client = deps.client || await adminClient(env);
  const close = !deps.client;
  try {
    const before = await snapshotCatalog(client);
    if (action === 'inspect') {
      return ok({
        action,
        sql47_sha256: embedded.details.sql47.hash,
        sql48_sha256: embedded.details.sql48.hash,
        sql49_sha256: embedded.details.sql49.hash,
        live_definition_sha256: before.live_definition_sha256,
        snapshot: before.snapshot,
        sql47_already_present: before.snapshot.owned_functions.includes('earn_mortgage_agent_compensation'),
      });
    }
    if (action === 'apply') {
      if (event.expected_live_definition_sha256
        && event.expected_live_definition_sha256 !== before.live_definition_sha256) {
        return fail('SOURCE_COMPOSITION_REQUIRED', 'live catalog drifted after preflight', {
          expected_live_definition_sha256: event.expected_live_definition_sha256,
          live_definition_sha256: before.live_definition_sha256,
        });
      }
      if (!before.snapshot.owned_functions.includes('earn_mortgage_agent_compensation')) {
        return fail('SOURCE_COMPOSITION_REQUIRED', 'SQL 47 objects missing; will not apply 47');
      }
      if (before.snapshot.mhr_table_update.length) {
        return fail('SQL_COLLISION', 'refusing apply while MHR has table-level UPDATE grants');
      }
      await client.query(embedded.details.sql48.text);
      await client.query(embedded.details.sql49.text);
      const after = await snapshotCatalog(client);
      const drift = ['accrue_mortgage_ops_billing', 'aws_is_mortgage_ops_agent', 'earn_mortgage_agent_compensation']
        .filter((key) => before.snapshot.protected_hashes[key] !== after.snapshot.protected_hashes[key]);
      if (drift.length) {
        return fail('SQL_COLLISION', 'SQL 48/49 changed a protected definition', { drift });
      }
      return ok({
        action,
        applied: true,
        sql48_sha256: embedded.details.sql48.hash,
        sql49_sha256: embedded.details.sql49.hash,
        before_hash: before.live_definition_sha256,
        after_hash: after.live_definition_sha256,
        snapshot: after.snapshot,
      });
    }
    if (action === 'verify') {
      const missing = [
        !before.snapshot.owned_functions.includes('return_mortgage_handling_request_to_queue') && 'return_fn',
        !before.snapshot.owned_functions.includes('adjust_mortgage_agent_compensation') && 'adjust_fn',
        !before.snapshot.request_audit_present && 'request_audit',
        !before.snapshot.adjustment_reason_present && 'adjustment_reason',
        before.snapshot.mortgage_ops_per_check.length === 0 && 'cbe_unique',
      ].filter(Boolean);
      return ok({
        action,
        present: missing.length === 0,
        missing,
        snapshot: before.snapshot,
        live_definition_sha256: before.live_definition_sha256,
      });
    }
    return await runDemo(client);
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
