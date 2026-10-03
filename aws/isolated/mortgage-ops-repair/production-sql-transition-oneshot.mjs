/**
 * Dedicated production Mortgage Ops SQL transition oneshot.
 * Step A: revoke leftover checksops table-level UPDATE on
 * public.mortgage_handling_requests, then grant the authorized 17 columns.
 * Step B: apply pinned 39_mortgage_ops_agent_accept_complete.sql only.
 *
 * Embeds both statements. Refuses caller SQL. Does not deploy the staging
 * SQL executor. Does not modify checksops_admin, authenticated table DML,
 * or check_billing_events DELETE.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { fail, ok } from './lib/errors.mjs';
import {
  mortgageOpsAlreadyExact,
  snapshotMortgageOpsState,
  sql39TextIsNarrow,
} from './mortgage-ops-sql39.mjs';
import { AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE } from './lib/sql-executor-auth.mjs';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SQL_FILE = path.join(ROOT, 'sql', '39_mortgage_ops_agent_accept_complete.sql');
const PINNED = AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.source_sha256;
const INVESTIGATION_BEFORE_HASH = '9b428140630157a29f7f96f1f368d8eeb264aceaa764c0a214b5a3aa58538ee0';
const HASH_601_MOVE = '010a450154c4d0d97c4d5b4ab82858c83ab57a3044c9937d40dec86a6c7a749d';
const HASH_601_OVERRIDE = '74a234df30847cecab759c72d75fb7ced55ef6e0a0e3d7f86d78e51310ab84e5';
const HISTORICAL_USING = "(aws_is_cross_tenant_reader() OR aws_can_write_tenant(tenant_id) OR (has_role(auth.uid(), 'mortgage_agent'::app_role) AND (((status = 'requested'::text) AND (assigned_employee_id IS NULL)) OR (assigned_employee_id = auth.uid()))))";
const HISTORICAL_CHECK = "(aws_is_cross_tenant_reader() OR (has_role(auth.uid(), 'mortgage_agent'::app_role) AND (((status = 'requested'::text) AND (assigned_employee_id IS NULL)) OR (assigned_employee_id = auth.uid()))) OR (aws_can_write_tenant(tenant_id) AND (status = 'requested'::text) AND (assigned_employee_id IS NULL)))";
const INTENDED_17 = Object.freeze([
  'assigned_employee_id',
  'accepted_at',
  'completed_at',
  'cancelled_at',
  'status',
  'updated_at',
  'work_notes',
  'mortgage_company',
  'mortgage_servicer',
  'loan_number',
  'note',
  'property_address',
  'claim_number',
  'insurance_company',
  'homeowner_name',
  'homeowner_email',
  'homeowner_phone',
]);
const STEP_A_SQL = `REVOKE UPDATE ON TABLE public.mortgage_handling_requests FROM checksops;
GRANT UPDATE (
  assigned_employee_id,
  accepted_at,
  completed_at,
  cancelled_at,
  status,
  updated_at,
  work_notes,
  mortgage_company,
  mortgage_servicer,
  loan_number,
  note,
  property_address,
  claim_number,
  insurance_company,
  homeowner_name,
  homeowner_email,
  homeowner_phone
) ON TABLE public.mortgage_handling_requests TO checksops;`;
const consumed = new Set();

function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function readEmbeddedSql(sqlFile, expectedHash) {
  const text = fs.readFileSync(sqlFile, 'utf8');
  const hash = sha256(text);
  if (hash !== expectedHash || hash !== PINNED) {
    return fail('UNRELATED_MUTATION', 'embedded SQL 39 hash mismatch', { hash, expectedHash, pinned: PINNED });
  }
  return ok({ text, hash });
}

function consumeOneUse(id) {
  if (!id) throw new Error('one_use_id required');
  if (consumed.has(id)) throw new Error(`one_use_replay:${id}`);
  consumed.add(id);
}

function tableUpdateRoles(snapshot, tableName = 'mortgage_handling_requests') {
  return (snapshot.table_grants || []).filter((row) => (
    row.table_name === tableName
    && row.privilege_type === 'UPDATE'
    && (row.grantee === 'authenticated' || row.grantee === 'checksops')
  ));
}

function grantsFor(snapshot, tableName, grantee) {
  return (snapshot.table_grants || [])
    .filter((row) => row.table_name === tableName && row.grantee === grantee)
    .map((row) => row.privilege_type)
    .sort();
}

function columnUpdateFor(snapshot, grantee) {
  return [...new Set(
    (snapshot.column_update_grants || [])
      .filter((row) => row.grantee === grantee)
      .map((row) => row.column_name),
  )].sort();
}

function policyByName(snapshot, name) {
  return (snapshot.policies || []).find((row) => row.policy_name === name) || null;
}

function summarize(snapshot, hash) {
  const historical = policyByName(snapshot, 'aws_update_mortgage_handling_requests');
  return {
    hash,
    login_role_mhr_table_update: tableUpdateRoles(snapshot),
    checksops_mhr_table: grantsFor(snapshot, 'mortgage_handling_requests', 'checksops'),
    authenticated_mhr_table: grantsFor(snapshot, 'mortgage_handling_requests', 'authenticated'),
    checksops_admin_mhr_table: grantsFor(snapshot, 'mortgage_handling_requests', 'checksops_admin'),
    checksops_mhr_column_update: columnUpdateFor(snapshot, 'checksops'),
    authenticated_mhr_column_update: columnUpdateFor(snapshot, 'authenticated'),
    checksops_cbe: grantsFor(snapshot, 'check_billing_events', 'checksops'),
    authenticated_cbe: grantsFor(snapshot, 'check_billing_events', 'authenticated'),
    historical_policy: historical && {
      using_expr: historical.using_expr,
      with_check: historical.with_check,
    },
    sql39_policies: (snapshot.policies || [])
      .map((row) => row.policy_name)
      .filter((name) => [
        'aws_select_mortgage_ops_agent_queue',
        'aws_update_mortgage_ops_accept_complete',
        'aws_insert_mortgage_ops_usage_events',
      ].includes(name))
      .sort(),
    has_agent_fn: Boolean(snapshot.aws_is_mortgage_ops_agent),
    force_rls: snapshot.force_rls,
    membership_601: {
      user_can_move_tenant_checks_sha256: snapshot.user_can_move_tenant_checks_sha256,
      admin_override_check_status_sha256: snapshot.admin_override_check_status_sha256,
    },
  };
}

function diagnoseBefore(snapshot, hash) {
  const stops = [];
  if (hash !== INVESTIGATION_BEFORE_HASH) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'production SQL catalog hash moved since the accepted investigation',
      expected: INVESTIGATION_BEFORE_HASH,
      live: hash,
    });
  }
  const tableUpdate = tableUpdateRoles(snapshot);
  if (tableUpdate.length !== 1
    || tableUpdate[0].grantee !== 'checksops'
    || tableUpdate[0].table_name !== 'mortgage_handling_requests') {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'checksops table-level UPDATE on mortgage_handling_requests is no longer exactly as diagnosed',
      live: tableUpdate,
    });
  }
  const historical = policyByName(snapshot, 'aws_update_mortgage_handling_requests');
  if (!historical
    || historical.using_expr !== HISTORICAL_USING
    || historical.with_check !== HISTORICAL_CHECK) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'historical aws_update_mortgage_handling_requests policy has changed',
      live: historical,
    });
  }
  const unexpectedSql39 = (snapshot.policies || [])
    .map((row) => row.policy_name)
    .filter((name) => [
      'aws_select_mortgage_ops_agent_queue',
      'aws_update_mortgage_ops_accept_complete',
      'aws_insert_mortgage_ops_usage_events',
    ].includes(name));
  if (unexpectedSql39.length || snapshot.aws_is_mortgage_ops_agent) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'SQL 39 policies unexpectedly exist',
      live: unexpectedSql39,
      has_agent_fn: Boolean(snapshot.aws_is_mortgage_ops_agent),
    });
  }
  if (snapshot.user_can_move_tenant_checks_sha256 !== HASH_601_MOVE
    || snapshot.admin_override_check_status_sha256 !== HASH_601_OVERRIDE) {
    stops.push({
      code: 'SQL_COLLISION',
      message: '#601 function fingerprints have moved',
      live: {
        user_can_move_tenant_checks_sha256: snapshot.user_can_move_tenant_checks_sha256,
        admin_override_check_status_sha256: snapshot.admin_override_check_status_sha256,
      },
    });
  }
  const forceOn = (snapshot.force_rls || []).some((row) => row.force_rls);
  if (forceOn) {
    stops.push({ code: 'UNRELATED_MUTATION', message: 'FORCE RLS is unexpectedly true' });
  }
  const authenticatedMhr = grantsFor(snapshot, 'mortgage_handling_requests', 'authenticated');
  if (authenticatedMhr.length) {
    stops.push({
      code: 'SQL_COLLISION',
      message: 'authenticated unexpectedly holds MHR table DML',
      live: authenticatedMhr,
    });
  }
  return stops;
}

function stepAOk(before, after) {
  const errors = [];
  if (tableUpdateRoles(after).length) {
    errors.push('checksops still has table-level UPDATE after Step A');
  }
  const cols = columnUpdateFor(after, 'checksops');
  if (JSON.stringify(cols) !== JSON.stringify([...INTENDED_17].sort())) {
    errors.push({ message: 'checksops column UPDATE is not exactly the intended 17', live: cols });
  }
  const keep = ['DELETE', 'INSERT', 'SELECT'];
  const beforeKeep = grantsFor(before, 'mortgage_handling_requests', 'checksops').filter((p) => keep.includes(p));
  const afterKeep = grantsFor(after, 'mortgage_handling_requests', 'checksops').filter((p) => keep.includes(p));
  if (JSON.stringify(beforeKeep) !== JSON.stringify(afterKeep) || JSON.stringify(afterKeep) !== JSON.stringify(keep)) {
    errors.push({ message: 'checksops SELECT/INSERT/DELETE changed', before: beforeKeep, after: afterKeep });
  }
  if (grantsFor(after, 'mortgage_handling_requests', 'authenticated').length) {
    errors.push('authenticated received MHR table DML during Step A');
  }
  if (JSON.stringify(grantsFor(before, 'mortgage_handling_requests', 'checksops_admin'))
    !== JSON.stringify(grantsFor(after, 'mortgage_handling_requests', 'checksops_admin'))) {
    errors.push('checksops_admin MHR table grants changed');
  }
  if (JSON.stringify(grantsFor(before, 'check_billing_events', 'checksops'))
    !== JSON.stringify(grantsFor(after, 'check_billing_events', 'checksops'))) {
    errors.push('check_billing_events checksops grants changed during Step A');
  }
  if (JSON.stringify(before.force_rls) !== JSON.stringify(after.force_rls)) {
    errors.push('FORCE RLS changed during Step A');
  }
  if (before.user_can_move_tenant_checks_sha256 !== after.user_can_move_tenant_checks_sha256
    || before.admin_override_check_status_sha256 !== after.admin_override_check_status_sha256) {
    errors.push('#601 changed during Step A');
  }
  const historical = policyByName(after, 'aws_update_mortgage_handling_requests');
  if (!historical) errors.push('historical policy disappeared during Step A');
  return errors;
}

function stepBOk(beforeA, afterB, intendedFn) {
  const errors = [];
  if (tableUpdateRoles(afterB).length) {
    errors.push('login-role table-level UPDATE remains after SQL 39');
  }
  if (policyByName(afterB, 'aws_update_mortgage_handling_requests')) {
    errors.push('historical aws_update_mortgage_handling_requests still present');
  }
  if (!mortgageOpsAlreadyExact(afterB, intendedFn)) {
    errors.push('SQL 39 overlay is not the intended narrow after-state');
  }
  const cols = columnUpdateFor(afterB, 'checksops');
  if (JSON.stringify(cols) !== JSON.stringify([...INTENDED_17].sort())) {
    errors.push({ message: 'checksops column UPDATE is not exactly the intended 17 after SQL 39', live: cols });
  }
  const authCols = columnUpdateFor(afterB, 'authenticated');
  const wantedAuth = ['accepted_at', 'assigned_employee_id', 'completed_at'];
  if (JSON.stringify(authCols) !== JSON.stringify(wantedAuth)) {
    errors.push({ message: 'authenticated received unexpected MHR column UPDATE', live: authCols });
  }
  if (grantsFor(afterB, 'mortgage_handling_requests', 'authenticated').length) {
    errors.push('authenticated received broad MHR table DML');
  }
  if (JSON.stringify(beforeA.force_rls) !== JSON.stringify(afterB.force_rls)) {
    errors.push('FORCE RLS changed');
  }
  if (beforeA.user_can_move_tenant_checks_sha256 !== afterB.user_can_move_tenant_checks_sha256
    || beforeA.admin_override_check_status_sha256 !== afterB.admin_override_check_status_sha256) {
    errors.push('#601 function definitions changed');
  }
  if (JSON.stringify(grantsFor(beforeA, 'check_billing_events', 'checksops'))
    !== JSON.stringify(grantsFor(afterB, 'check_billing_events', 'checksops'))) {
    errors.push('check_billing_events checksops grants changed');
  }
  if (JSON.stringify(grantsFor(beforeA, 'mortgage_handling_requests', 'checksops_admin'))
    !== JSON.stringify(grantsFor(afterB, 'mortgage_handling_requests', 'checksops_admin'))) {
    errors.push('checksops_admin MHR grants changed');
  }
  const beforeFin = (beforeA.table_grants || []).filter((row) => ![
    'mortgage_handling_requests',
    'check_billing_events',
  ].includes(row.table_name));
  const afterFin = (afterB.table_grants || []).filter((row) => ![
    'mortgage_handling_requests',
    'check_billing_events',
  ].includes(row.table_name));
  if (JSON.stringify(beforeFin) !== JSON.stringify(afterFin)) {
    errors.push('unrelated financial grants changed');
  }
  return errors;
}

async function connect() {
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
    query_timeout: 120000,
  });
  await client.connect();
  return client;
}

function extractPinnedFunctionSql(sqlText, name) {
  const re = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?(?:\\$function\\$[\\s\\S]*?\\$function\\$|\\$\\$[\\s\\S]*?\\$\\$);`,
    'i',
  );
  const match = String(sqlText || '').match(re);
  return match ? match[0] : null;
}

export const handler = async (event = {}) => {
  if (event.sql || event.statement || event.query || event.extra_sql || event.step_a_sql || event.step_b_sql) {
    return { ok: false, mutated: false, error: 'refuses_caller_sql' };
  }
  const action = event.action || 'inspect';
  if (!['inspect', 'apply'].includes(action)) {
    return { ok: false, mutated: false, error: `refuses_action:${action}` };
  }
  if (event.filename && event.filename !== AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.filename) {
    return { ok: false, mutated: false, error: 'refuses_unrelated_filename' };
  }
  if (event.source_sha256 && event.source_sha256 !== PINNED) {
    return { ok: false, mutated: false, error: 'refuses_unpinned_sql39' };
  }

  const embedded = readEmbeddedSql(SQL_FILE, PINNED);
  if (!embedded.ok) return embedded;
  const narrow = sql39TextIsNarrow(embedded.details.text);
  if (!narrow.ok) return narrow;
  const intendedFn = extractPinnedFunctionSql(embedded.details.text, 'aws_is_mortgage_ops_agent');

  let client;
  try {
    client = await connect();
    const beforeLookup = await snapshotMortgageOpsState(client);
    if (!beforeLookup.ok) return beforeLookup;
    const before = beforeLookup.details.snapshot;
    const beforeHash = beforeLookup.details.hash;
    const beforeSummary = summarize(before, beforeHash);
    const stops = diagnoseBefore(before, beforeHash);

    if (event.expected_live_definition_sha256
      && event.expected_live_definition_sha256 !== beforeHash) {
      return fail('SQL_COLLISION', 'live Mortgage Ops snapshot differs from caller expected baseline', {
        expected_live_definition_sha256: event.expected_live_definition_sha256,
        live_definition_sha256: beforeHash,
        mutated: false,
        before: beforeSummary,
      });
    }

    if (action === 'inspect') {
      return ok({
        inspect_only: true,
        mutated: false,
        path: 'dedicated-production-sql-transition-ad99',
        before: beforeSummary,
        prewrite_stops: stops,
        snapshot: before,
      });
    }

    if (stops.length) {
      return fail('SQL_COLLISION', 'pre-write TOCTOU failed; no mutation', {
        mutated: false,
        step_a_applied: false,
        step_b_applied: false,
        prewrite_stops: stops,
        before: beforeSummary,
      });
    }

    await client.query('BEGIN');
    await client.query(STEP_A_SQL);
    const midLookup = await snapshotMortgageOpsState(client);
    if (!midLookup.ok) {
      await client.query('ROLLBACK');
      return midLookup;
    }
    const mid = midLookup.details.snapshot;
    const midHash = midLookup.details.hash;
    const aErrors = stepAOk(before, mid);
    if (aErrors.length) {
      await client.query('ROLLBACK');
      return fail('UNRELATED_MUTATION', 'Step A did not produce the intended privilege narrowing; rolled back', {
        mutated: false,
        step_a_applied: false,
        step_b_applied: false,
        step_a_errors: aErrors,
        before: beforeSummary,
        after_step_a_rolled_back: summarize(mid, midHash),
      });
    }

    await client.query(embedded.details.text);
    const afterLookup = await snapshotMortgageOpsState(client);
    if (!afterLookup.ok) {
      await client.query('ROLLBACK');
      return afterLookup;
    }
    const after = afterLookup.details.snapshot;
    const afterHash = afterLookup.details.hash;
    const bErrors = stepBOk(before, after, intendedFn);
    if (bErrors.length) {
      await client.query('ROLLBACK');
      return fail('SQL_COLLISION', 'Step A succeeded in-transaction but Step B could not be safely applied; rolled back to pre-write state', {
        mutated: false,
        step_a_applied: false,
        step_b_applied: false,
        step_a_in_transaction_ok: true,
        step_b_errors: bErrors,
        before: beforeSummary,
        after_step_a_in_transaction: summarize(mid, midHash),
        after_step_b_rolled_back: summarize(after, afterHash),
      });
    }

    await client.query('COMMIT');
    consumeOneUse(event.one_use_id);
    return ok({
      mutated: true,
      step_a_applied: true,
      step_b_applied: true,
      path: 'dedicated-production-sql-transition-ad99',
      pinned_sql39: PINNED,
      step_a_sql_sha256: sha256(STEP_A_SQL),
      receipt: {
        workstream: event.workstream_id || 'mortgage-ops-repair-ad99',
        commit: event.commit || AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.commit,
        sql_file: AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.filename,
        one_use_id: event.one_use_id,
        before_hash: beforeHash,
        after_step_a_hash: midHash,
        after_hash: afterHash,
        result: 'applied',
        executor_identity: {
          function: 'checksops-prod-mops-sql-transition-ad99',
          not_staging_executor: true,
        },
      },
      before: beforeSummary,
      after_step_a: summarize(mid, midHash),
      after: summarize(after, afterHash),
      snapshot_after: after,
    });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return fail('UNRELATED_MUTATION', String(error?.message || error).slice(0, 400), { mutated: false });
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
