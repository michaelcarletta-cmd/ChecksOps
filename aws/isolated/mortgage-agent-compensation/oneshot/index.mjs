/**
 * Dedicated staging-only Mortgage Agent compensation SQL 47 oneshot.
 *
 * Does not update checksops-staging-guarded-sql-executor.
 * Does not target production. Does not accept caller SQL.
 * Inspect / apply / verify / demo only the embedded SQL 47 file.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL47_SHA256,
} from './constants.mjs';

export { FUNCTION_NAME, FORBIDDEN_FUNCTIONS, PINNED_SQL47_SHA256 };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.join(ROOT, 'sql', '47_mortgage_agent_compensation.sql');
const FREEDOM_ACCIDENTAL = '5b20db20-13e1-4919-9528-06388d8661d2';
const SYNTHETIC_A = '7a7ec1ce-de9a-4601-875c-4a67db635fd2';
const SYNTHETIC_B = '71ea6822-df95-4aa9-a04c-4a00a5f6d043';
const DEMO = Object.freeze({
  req1: 'a47cad99-0000-4000-8000-000000000021',
  req2: 'a47cad99-0000-4000-8000-000000000022',
  reqCancel: 'a47cad99-0000-4000-8000-000000000023',
  check1: 'a47cad99-0000-4000-8000-000000000011',
  check2: 'a47cad99-0000-4000-8000-000000000012',
  claim: 'a47cad99-0000-4000-8000-0000000000c1',
});
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
  if (/\bmoov\b|\bstripe\b|\bach\b|\bwallet\b/i.test(executable)) {
    return fail('UNRELATED_MUTATION', 'SQL 47 must not reference money rails');
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
  if (!arn || !/checksops_admin/i.test(arn)) {
    throw new Error('ADMIN_SECRET_ARN must be the staging checksops_admin secret');
  }
  if (/production/i.test(arn)) {
    throw new Error('production admin secret is forbidden');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host && parsed.host !== 'localhost'
    ? parsed.host
    : env.RDS_HOST;
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

async function functionDef(client, name, args = []) {
  const { rows } = await client.query(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = $1
      AND p.pronargs = $2
    LIMIT 1
  `, [name, args.length]);
  return rows[0]?.def || null;
}

export async function snapshotCatalog(client) {
  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY 1
  `, [OWNED_TABLES]);
  const functions = await client.query(`
    SELECT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY($1::text[])
    ORDER BY 1
  `, [OWNED_FUNCTIONS]);
  const mhrTableUpdate = await client.query(`
    SELECT grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'mortgage_handling_requests'
      AND privilege_type = 'UPDATE'
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY 1
  `);
  const mhrColumnUpdate = await client.query(`
    SELECT grantee, column_name
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'mortgage_handling_requests'
      AND privilege_type = 'UPDATE'
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY 1, 2
  `);
  const triggers = await client.query(`
    SELECT tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'mortgage_handling_requests'
      AND NOT t.tgisinternal
    ORDER BY 1
  `);
  const cbeCols = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'check_billing_events'
    ORDER BY 1
  `);
  const protectedDefs = {
    aws_is_mortgage_ops_agent: await functionDef(client, 'aws_is_mortgage_ops_agent', ['uuid']),
    claim_ledger_link_or_create: await functionDef(client, 'claim_ledger_link_or_create'),
    user_can_move_tenant_checks: await functionDef(client, 'user_can_move_tenant_checks', ['uuid', 'uuid']),
    admin_override_check_status: await functionDef(client, 'admin_override_check_status'),
    accrue_mortgage_ops_billing: await functionDef(client, 'accrue_mortgage_ops_billing'),
  };
  const protectedHashes = Object.fromEntries(
    Object.entries(protectedDefs).map(([k, v]) => [k, v ? sha256(v) : null]),
  );
  const exclusions = await client.query(`
    SELECT id, status, assigned_employee_id, accepted_at, completed_at, cancelled_at
    FROM public.mortgage_handling_requests
    WHERE id = ANY($1::uuid[])
  `, [[FREEDOM_ACCIDENTAL, SYNTHETIC_A, SYNTHETIC_B]]).catch(() => ({ rows: [] }));
  const snapshot = {
    owned_tables: tables.rows.map((r) => r.table_name),
    owned_functions: functions.rows.map((r) => r.proname),
    mhr_table_update: mhrTableUpdate.rows,
    mhr_column_update: mhrColumnUpdate.rows,
    mhr_triggers: triggers.rows.map((r) => r.tgname),
    cbe_columns: cbeCols.rows.map((r) => r.column_name),
    protected_hashes: protectedHashes,
    excluded_requests: exclusions.rows,
  };
  return {
    snapshot,
    live_definition_sha256: sha256(JSON.stringify(snapshot)),
  };
}

function collisionReport(before) {
  const ownedPresent = before.snapshot.owned_tables.length + before.snapshot.owned_functions.length;
  return {
    sql_39_touched: false,
    sql_44_objects: Boolean(before.snapshot.protected_hashes.claim_ledger_link_or_create),
    pr601_objects: Boolean(before.snapshot.protected_hashes.user_can_move_tenant_checks),
    mhr_table_update_count: before.snapshot.mhr_table_update.length,
    mhr_column_update_count: before.snapshot.mhr_column_update.length,
    owned_objects_already_present: ownedPresent > 0,
    billing_trigger_present: before.snapshot.mhr_triggers.includes('tr_accrue_mortgage_ops_billing'),
  };
}

async function applySql47(client, text) {
  await client.query(text);
}

async function runDemo(client) {
  const notes = [];
  const note = (line) => notes.push(line);
  const scalar = async (sql, params = []) => {
    const { rows } = await client.query(sql, params);
    const first = rows[0] || {};
    return first[Object.keys(first)[0]];
  };

  const owner = (await client.query(`
    SELECT ur.user_id
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role = 'admin'
       OR p.email IN ('checksopsadmin@gmail.com', 'michaelcarletta@gmail.com')
    ORDER BY CASE WHEN p.email = 'checksopsadmin@gmail.com' THEN 0 ELSE 1 END
    LIMIT 1
  `)).rows[0];
  const agent = (await client.query(`
    SELECT ur.user_id, p.email
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role = 'mortgage_agent'
    ORDER BY p.email
    LIMIT 1
  `)).rows[0];
  const otherAgent = (await client.query(`
    SELECT ur.user_id
    FROM public.user_roles ur
    WHERE ur.role = 'mortgage_agent'
      AND ur.user_id <> $1
    LIMIT 1
  `, [agent?.user_id])).rows[0];
  const tenant = (await client.query(`
    SELECT id, name, mortgage_ops_initial_rate_cents, mortgage_ops_additional_rate_cents
    FROM public.tenants
    WHERE COALESCE(is_test_account, false) = true
       OR slug ILIKE '%test%'
       OR name ILIKE '%test%'
    ORDER BY created_at DESC NULLS LAST
    LIMIT 1
  `)).rows[0] || (await client.query(`
    SELECT id, name, mortgage_ops_initial_rate_cents, mortgage_ops_additional_rate_cents
    FROM public.tenants
    WHERE id <> '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a'
    ORDER BY created_at DESC NULLS LAST
    LIMIT 1
  `)).rows[0];

  if (!owner?.user_id || !agent?.user_id || !tenant?.id) {
    return fail('INVALID_MANIFEST', 'staging demo requires an admin, a mortgage_agent, and a non-Freedom-or-test tenant', {
      owner: owner || null,
      agent: agent || null,
      tenant: tenant || null,
    });
  }

  await client.query(`
    INSERT INTO public.mortgage_agent_accounts (application_user_id, status)
    VALUES ($1, 'active')
    ON CONFLICT (application_user_id) DO NOTHING
  `, [agent.user_id]);

  await client.query(`
    DELETE FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id = ANY($1::uuid[])
  `, [[DEMO.req1, DEMO.req2, DEMO.reqCancel]]);
  await client.query(`
    DELETE FROM public.mortgage_handling_requests
    WHERE id = ANY($1::uuid[])
  `, [[DEMO.req1, DEMO.req2, DEMO.reqCancel]]);
  await client.query(`
    DELETE FROM public.check_billing_events
    WHERE mortgage_request_id = ANY($1::uuid[])
       OR check_intake_item_id = ANY($2::uuid[])
  `, [[DEMO.req1, DEMO.req2, DEMO.reqCancel], [DEMO.check1, DEMO.check2]]).catch(() => null);

  const insertReq = async (id, checkId, loan) => {
    await client.query(`
      INSERT INTO public.mortgage_handling_requests
        (id, tenant_id, check_intake_item_id, claim_id, mortgage_company, loan_number, status)
      VALUES ($1, $2, $3, $4, 'MACOMP STAGING DEMO', $5, 'requested')
    `, [id, tenant.id, checkId, DEMO.claim, loan]);
  };

  const insertDemoRequests = async (withChecks) => {
    await insertReq(DEMO.req1, withChecks ? DEMO.check1 : null, 'MACOMP-1');
    await insertReq(DEMO.req2, withChecks ? DEMO.check2 : null, 'MACOMP-2');
    await insertReq(DEMO.reqCancel, null, 'MACOMP-X');
  };
  try {
    await insertDemoRequests(true);
  } catch (error) {
    await client.query(`
      DELETE FROM public.mortgage_handling_requests
      WHERE id = ANY($1::uuid[])
    `, [[DEMO.req1, DEMO.req2, DEMO.reqCancel]]);
    await insertDemoRequests(false);
    note(`mhr_inserted_without_checks:${error.message.slice(0, 120)}`);
  }

  const insertBilling = async (reqId, checkId, type, cents) => {
    await client.query(`
      INSERT INTO public.check_billing_events
        (tenant_id, check_intake_item_id, claim_id, mortgage_request_id, event_type, unit_price_cents)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [tenant.id, checkId, DEMO.claim, reqId, type, cents]);
  };

  const accept = async (reqId) => {
    await client.query(`
      UPDATE public.mortgage_handling_requests
         SET assigned_employee_id = $2,
             status = 'in_progress',
             accepted_at = COALESCE(accepted_at, now()),
             updated_at = now()
       WHERE id = $1
         AND assigned_employee_id IS NULL
         AND status = 'requested'
    `, [reqId, agent.user_id]);
  };
  const complete = async (reqId) => {
    await client.query(`
      UPDATE public.mortgage_handling_requests
         SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1
    `, [reqId]);
  };

  try {
    await insertBilling(DEMO.req1, DEMO.check1, 'mortgage_ops_initial', 1000);
  } catch (error) {
    note(`billing_insert_initial:${error.message.slice(0, 160)}`);
  }
  await accept(DEMO.req1);
  const afterAccept1 = Number(await scalar(
    `SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE mortgage_request_id = $1`,
    [DEMO.req1],
  ));
  const tenant1 = Number(await scalar(`
    SELECT count(*) FROM public.check_billing_events
    WHERE mortgage_request_id = $1 AND event_type = 'mortgage_ops_initial'
  `, [DEMO.req1]).catch(() => 0));
  note(`1 accept initial: tenant_events=${tenant1} payables=${afterAccept1}`);

  await complete(DEMO.req1);
  const pay1 = await client.query(`
    SELECT amount_cents, classification, status
    FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id = $1
  `, [DEMO.req1]);
  note(`2 complete: ${JSON.stringify(pay1.rows)}`);

  await complete(DEMO.req1);
  const dup = Number(await scalar(
    `SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE mortgage_request_id = $1`,
    [DEMO.req1],
  ));
  note(`3 duplicate complete: payables=${dup}`);

  try {
    await insertBilling(DEMO.req2, DEMO.check2, 'mortgage_ops_additional_check', 500);
  } catch (error) {
    note(`billing_insert_additional:${error.message.slice(0, 160)}`);
  }
  await accept(DEMO.req2);
  const afterAccept2 = Number(await scalar(
    `SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE mortgage_request_id = $1`,
    [DEMO.req2],
  ));
  const tenant2 = Number(await scalar(`
    SELECT count(*) FROM public.check_billing_events
    WHERE mortgage_request_id = $1 AND event_type = 'mortgage_ops_additional_check'
  `, [DEMO.req2]).catch(() => 0));
  note(`4 additional accept: tenant_events=${tenant2} payables=${afterAccept2}`);

  await complete(DEMO.req2);
  const pay2 = await client.query(`
    SELECT amount_cents, classification, status
    FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id = $1
  `, [DEMO.req2]);
  note(`5 complete additional: ${JSON.stringify(pay2.rows)}`);

  const monthly = await client.query(`
    SELECT
      count(*)::int AS files_worked,
      coalesce(sum(amount_cents),0)::int AS gross_owed
    FROM public.mortgage_agent_compensation_entries
    WHERE agent_user_id = $1
      AND mortgage_request_id IN ($2, $3)
      AND status NOT IN ('voided', 'excluded')
  `, [agent.user_id, DEMO.req1, DEMO.req2]);
  note(`6 monthly: ${JSON.stringify(monthly.rows[0])}`);

  await client.query(`
    SELECT set_config('request.app_user_id', $1, true),
           set_config('request.is_platform_owner', 'true', true)
  `, [owner.user_id]);
  const approved = await scalar(`
    SELECT public.approve_mortgage_agent_compensation(
      ARRAY(SELECT id FROM public.mortgage_agent_compensation_entries
            WHERE mortgage_request_id IN ($1, $2)),
      'macomp staging demo approve'
    )
  `, [DEMO.req1, DEMO.req2]);
  const afterApprove = await client.query(`
    SELECT status, amount_cents FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id IN ($1, $2) ORDER BY classification
  `, [DEMO.req1, DEMO.req2]);
  note(`7 approve count=${approved} rows=${JSON.stringify(afterApprove.rows)}`);

  const paid = await scalar(`
    SELECT public.mark_mortgage_agent_compensation_paid(
      ARRAY(SELECT id FROM public.mortgage_agent_compensation_entries
            WHERE mortgage_request_id IN ($1, $2)),
      CURRENT_DATE, 'MACOMP-STAGING-15', 'bookkeeping only'
    )
  `, [DEMO.req1, DEMO.req2]);
  const afterPaid = await client.query(`
    SELECT status, amount_cents, payment_reference
    FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id IN ($1, $2)
  `, [DEMO.req1, DEMO.req2]);
  note(`8 mark paid count=${paid} rows=${JSON.stringify(afterPaid.rows)}`);

  const drill = Number(await scalar(`
    SELECT count(*) FROM public.mortgage_agent_compensation_entries
    WHERE agent_user_id = $1 AND mortgage_request_id IN ($2, $3)
  `, [agent.user_id, DEMO.req1, DEMO.req2]));
  note(`9 drilldown files=${drill}`);

  await client.query(`SELECT set_config('request.app_user_id', $1, true), set_config('request.is_platform_owner', 'false', true)`, [agent.user_id]);
  const agentAdmin = await scalar(`SELECT public.aws_can_admin_mortgage_agent_compensation()`);
  let agentDenied = false;
  try {
    await scalar(`SELECT public.approve_mortgage_agent_compensation(ARRAY[]::uuid[], 'nope')`);
  } catch {
    agentDenied = true;
  }
  note(`10 agent admin=${agentAdmin} denied=${agentDenied}`);

  let stealDenied = false;
  if (otherAgent?.user_id) {
    try {
      await client.query(`
        UPDATE public.mortgage_agent_compensation_entries
           SET agent_user_id = $2
         WHERE mortgage_request_id = $1
      `, [DEMO.req1, otherAgent.user_id]);
    } catch {
      stealDenied = true;
    }
  } else {
    try {
      await client.query(`
        UPDATE public.mortgage_agent_compensation_entries
           SET amount_cents = 1
         WHERE mortgage_request_id = $1
      `, [DEMO.req1]);
    } catch {
      stealDenied = true;
    }
  }
  const ownerStill = await scalar(`
    SELECT agent_user_id FROM public.mortgage_agent_compensation_entries WHERE mortgage_request_id = $1
  `, [DEMO.req1]);
  note(`11 steal_denied=${stealDenied} owner=${ownerStill}`);

  await client.query(`
    UPDATE public.mortgage_handling_requests
       SET assigned_employee_id = $2, status = 'in_progress', accepted_at = now()
     WHERE id = $1
  `, [DEMO.reqCancel, agent.user_id]);
  await client.query(`
    UPDATE public.mortgage_handling_requests
       SET status = 'cancelled', cancelled_at = now()
     WHERE id = $1
  `, [DEMO.reqCancel]);
  const cancelPay = Number(await scalar(`
    SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE mortgage_request_id = $1
  `, [DEMO.reqCancel]));
  note(`12 cancel payables=${cancelPay}`);

  const freedom = await client.query(`
    SELECT id, status, assigned_employee_id, completed_at
    FROM public.mortgage_handling_requests WHERE id = $1
  `, [FREEDOM_ACCIDENTAL]);
  const freedomPay = Number(await scalar(`
    SELECT count(*) FROM public.mortgage_agent_compensation_entries WHERE mortgage_request_id = $1
  `, [FREEDOM_ACCIDENTAL]));

  const passed = afterAccept1 === 0
    && pay1.rows.length === 1
    && Number(pay1.rows[0].amount_cents) === 1000
    && dup === 1
    && afterAccept2 === 0
    && pay2.rows.length === 1
    && Number(pay2.rows[0].amount_cents) === 500
    && Number(monthly.rows[0].files_worked) === 2
    && Number(monthly.rows[0].gross_owed) === 1500
    && Number(approved) === 2
    && Number(paid) === 2
    && afterPaid.rows.every((r) => r.status === 'paid')
    && drill === 2
    && agentAdmin === false
    && agentDenied
    && stealDenied
    && String(ownerStill) === String(agent.user_id)
    && cancelPay === 0
    && freedomPay === 0;

  return ok({
    passed,
    notes,
    actor: { owner: owner.user_id, agent: agent.user_id, tenant: tenant.id },
    freedom_untouched: freedom.rows[0] || null,
    freedom_payables: freedomPay,
    monthly: monthly.rows[0],
    entries: afterPaid.rows,
  });
}

export async function handleEvent(event = {}, env = process.env, deps = {}) {
  const refused = refuseEvent(event, env);
  if (refused) return refused;
  const embedded = readEmbeddedSql(deps.sqlFile || SQL_FILE);
  if (!embedded.ok) return embedded;
  const action = String(event.action || 'inspect');
  if (action !== 'inspect') consumeOneUse(event.one_use_id);

  const client = deps.client || await adminClient(env);
  const close = !deps.client;
  try {
    const before = await snapshotCatalog(client);
    const collisions = collisionReport(before);
    if (action === 'inspect') {
      return ok({
        action,
        sql47_sha256: embedded.details.hash,
        live_definition_sha256: before.live_definition_sha256,
        collisions,
        snapshot: before.snapshot,
      });
    }
    if (action === 'apply') {
      if (event.expected_live_definition_sha256
        && event.expected_live_definition_sha256 !== before.live_definition_sha256) {
        return fail('DEPLOYMENT_COLLISION', 'live catalog drifted after preflight', {
          expected_live_definition_sha256: event.expected_live_definition_sha256,
          live_definition_sha256: before.live_definition_sha256,
        });
      }
      if (collisions.mhr_table_update_count !== 0) {
        return fail('SQL_COLLISION', 'refusing apply while MHR has table-level UPDATE grants', collisions);
      }
      await applySql47(client, embedded.details.text);
      const after = await snapshotCatalog(client);
      const protectedDrift = Object.keys(before.snapshot.protected_hashes).filter((key) => (
        before.snapshot.protected_hashes[key] !== after.snapshot.protected_hashes[key]
      ));
      if (protectedDrift.length) {
        return fail('SQL_COLLISION', 'SQL 47 apply changed a protected definition', { protectedDrift });
      }
      if (after.snapshot.mhr_table_update.length !== 0) {
        return fail('SQL_COLLISION', 'SQL 47 apply introduced MHR table UPDATE grants');
      }
      return ok({
        action,
        applied: true,
        sql47_sha256: embedded.details.hash,
        before_hash: before.live_definition_sha256,
        after_hash: after.live_definition_sha256,
        owned_tables: after.snapshot.owned_tables,
        owned_functions: after.snapshot.owned_functions,
        protected_hashes: after.snapshot.protected_hashes,
        excluded_requests: after.snapshot.excluded_requests,
      });
    }
    if (action === 'verify') {
      const missingTables = OWNED_TABLES.filter((name) => !before.snapshot.owned_tables.includes(name));
      const missingFns = OWNED_FUNCTIONS.filter((name) => !before.snapshot.owned_functions.includes(name));
      return ok({
        action,
        present: missingTables.length === 0 && missingFns.length === 0,
        missingTables,
        missingFns,
        collisions,
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
