/**
 * Minimum guarded-path capability for already-reviewed Mortgage Ops SQL 39.
 * Does not replace #601, membership-only, SQL 44, or other live executor
 * handlers. Refuses arbitrary SQL, table-wide UPDATE, and FORCE RLS.
 */
import { CODES, fail, ok } from './lib/errors.mjs';
import { extractDollarQuotedBody, readFunctionDef } from './lib/function-def-lookup.mjs';
import { hashSqlDefinition } from './lib/sql-apply.mjs';
import { AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE } from './lib/sql-executor-auth.mjs';

export const MORTGAGE_OPS_FUNCTION_IDENTITY = 'public.aws_is_mortgage_ops_agent()';
export const MEMBERSHIP_MOVE_IDENTITY = 'public.user_can_move_tenant_checks(uuid,uuid)';
export const MEMBERSHIP_OVERRIDE_IDENTITY = 'public.admin_override_check_status(uuid,text,uuid)';

export const REQUIRED_SQL39_MARKERS = Object.freeze([
  'aws_is_mortgage_ops_agent',
  'aws_select_mortgage_ops_agent_queue',
  'aws_update_mortgage_ops_accept_complete',
  'aws_insert_mortgage_ops_usage_events',
  'DROP POLICY IF EXISTS aws_update_mortgage_handling_requests',
  'GRANT UPDATE (\n  assigned_employee_id,\n  accepted_at,\n  completed_at\n)',
  'GRANT INSERT ON TABLE public.check_billing_events',
]);

const FORBIDDEN_SQL39 = Object.freeze([
  { re: /GRANT\s+UPDATE\s+ON\s+TABLE/i, reason: 'table-level UPDATE grant is forbidden' },
  { re: /FORCE\s+ROW\s+LEVEL\s+SECURITY/i, reason: 'FORCE RLS change is forbidden' },
  { re: /ALTER\s+TABLE/i, reason: 'ALTER TABLE is forbidden on the SQL 39 path' },
  { re: /user_can_move_tenant_checks/i, reason: 'SQL 39 must not modify #601 helpers' },
  { re: /admin_override_check_status/i, reason: 'SQL 39 must not modify #601 helpers' },
  { re: /claim_ledger_link_or_create/i, reason: 'SQL 39 must not modify SQL 44' },
  { re: /GRANT\s+ALL\b/i, reason: 'GRANT ALL is forbidden' },
  { re: /\bmoov\b/i, reason: 'Moov references are forbidden' },
  { re: /\bstripe\b/i, reason: 'Stripe references are forbidden' },
  { re: /bill-mortgage-handling/i, reason: 'bill-mortgage-handling must stay fail-closed/uninvoked' },
]);

const FINANCIAL_TABLES = Object.freeze([
  'invoices',
  'invoice_line_items',
  'moov_accounts',
  'wallet_accounts',
  'ach_transfers',
  'payment_transfers',
  'provider_transfers',
]);

export function sql39TextIsNarrow(text) {
  const src = String(text || '');
  const missing = REQUIRED_SQL39_MARKERS.filter((marker) => !src.includes(marker));
  if (missing.length) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 39 is missing required narrow markers', { missing });
  }
  for (const row of FORBIDDEN_SQL39) {
    if (row.re.test(src)) {
      return fail(CODES.UNRELATED_MUTATION, row.reason);
    }
  }
  return ok({ narrow: true });
}

export function hashMortgageOpsLiveSnapshot(snapshot = {}) {
  return hashSqlDefinition(JSON.stringify(snapshot));
}

function sortRows(rows) {
  return [...(rows || [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function mortgageOpsAlreadyExact(snapshot = {}, intendedFnSql = '') {
  const policies = new Set((snapshot.policies || []).map((row) => row.policy_name));
  if (policies.has('aws_update_mortgage_handling_requests')) return false;
  if (!policies.has('aws_select_mortgage_ops_agent_queue')) return false;
  if (!policies.has('aws_update_mortgage_ops_accept_complete')) return false;
  if (!policies.has('aws_insert_mortgage_ops_usage_events')) return false;
  if (!snapshot.aws_is_mortgage_ops_agent) return false;
  const agent = String(snapshot.aws_is_mortgage_ops_agent);
  if (!agent.includes('aws_is_authenticated') || !agent.includes('mortgage_agent')) return false;
  if (intendedFnSql) {
    const liveBody = extractDollarQuotedBody(snapshot.aws_is_mortgage_ops_agent);
    const sourceBody = extractDollarQuotedBody(intendedFnSql);
    if (!liveBody || !sourceBody || liveBody !== sourceBody) return false;
  }
  const tableUpdate = (snapshot.table_grants || []).filter((row) => (
    row.table_name === 'mortgage_handling_requests' && row.privilege_type === 'UPDATE'
  ));
  if (tableUpdate.length) return false;
  const wanted = new Set(['assigned_employee_id', 'accepted_at', 'completed_at']);
  const granted = new Set(
    (snapshot.column_update_grants || [])
      .filter((row) => wanted.has(row.column_name) && (row.grantee === 'checksops' || row.grantee === 'authenticated'))
      .map((row) => `${row.grantee}:${row.column_name}`),
  );
  for (const col of wanted) {
    if (!granted.has(`checksops:${col}`) || !granted.has(`authenticated:${col}`)) return false;
  }
  const billingInsert = (snapshot.table_grants || []).some((row) => (
    row.table_name === 'check_billing_events'
    && row.privilege_type === 'INSERT'
    && (row.grantee === 'checksops' || row.grantee === 'authenticated')
  ));
  return billingInsert;
}

function extractPinnedFunctionSql(sqlText, name) {
  const re = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?(?:\\$function\\$[\\s\\S]*?\\$function\\$|\\$\\$[\\s\\S]*?\\$\\$);`,
    'i',
  );
  const match = String(sqlText || '').match(re);
  return match ? match[0] : null;
}

async function definitionOrNull(client, identity) {
  const lookup = await readFunctionDef(client, identity);
  if (!lookup.ok) return lookup;
  return ok({ definition: lookup.details.exists ? lookup.details.definition : null });
}

export async function snapshotMortgageOpsState(client) {
  const policies = await client.query(`
    /* mops-sql39-policies */
    SELECT c.relname AS table_name,
           p.polname AS policy_name,
           p.polcmd AS command,
           pg_get_expr(p.polqual, p.polrelid) AS using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('mortgage_handling_requests', 'check_billing_events')
    ORDER BY c.relname, p.polname
  `);
  const columnGrants = await client.query(`
    /* mops-sql39-column-grants */
    SELECT table_name, column_name, grantee, privilege_type
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'mortgage_handling_requests'
      AND privilege_type = 'UPDATE'
    ORDER BY column_name, grantee
  `);
  const tableGrants = await client.query(`
    /* mops-sql39-table-grants */
    SELECT table_name, grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'mortgage_handling_requests',
        'check_billing_events',
        'invoices',
        'invoice_line_items',
        'moov_accounts',
        'wallet_accounts',
        'ach_transfers',
        'payment_transfers',
        'provider_transfers'
      )
    ORDER BY table_name, grantee, privilege_type
  `);
  const forceRls = await client.query(`
    /* mops-sql39-force-rls */
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS force_rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('mortgage_handling_requests', 'check_billing_events')
    ORDER BY c.relname
  `);
  const agent = await definitionOrNull(client, MORTGAGE_OPS_FUNCTION_IDENTITY);
  if (!agent.ok) return agent;
  const move = await definitionOrNull(client, MEMBERSHIP_MOVE_IDENTITY);
  if (!move.ok) return move;
  const override = await definitionOrNull(client, MEMBERSHIP_OVERRIDE_IDENTITY);
  if (!override.ok) return override;

  const snapshot = {
    policies: sortRows(policies.rows),
    column_update_grants: sortRows(columnGrants.rows),
    table_grants: sortRows(tableGrants.rows),
    force_rls: sortRows(forceRls.rows),
    aws_is_mortgage_ops_agent: agent.details.definition,
    user_can_move_tenant_checks_sha256: move.details.definition
      ? hashSqlDefinition(move.details.definition)
      : null,
    admin_override_check_status_sha256: override.details.definition
      ? hashSqlDefinition(override.details.definition)
      : null,
  };
  return ok({
    snapshot,
    hash: hashMortgageOpsLiveSnapshot(snapshot),
  });
}

function financialGrantsUnchanged(before, after) {
  const beforeFin = sortRows((before.table_grants || []).filter((row) => FINANCIAL_TABLES.includes(row.table_name)));
  const afterFin = sortRows((after.table_grants || []).filter((row) => FINANCIAL_TABLES.includes(row.table_name)));
  return JSON.stringify(beforeFin) === JSON.stringify(afterFin);
}

function tableLevelUpdatePresent(snapshot) {
  return (snapshot.table_grants || []).some((row) => (
    row.table_name === 'mortgage_handling_requests' && row.privilege_type === 'UPDATE'
  ));
}

export async function handleMortgageOpsAcceptComplete({
  event,
  authorization,
  identity,
  connect,
  sqlFile,
  readEmbeddedSql,
  consumeOneUse,
}) {
  const embedded = readEmbeddedSql(
    sqlFile,
    AUTHORIZED_MORTGAGE_OPS_AGENT_ACCEPT_COMPLETE.source_sha256,
  );
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

    if (
      event.expected_live_definition_sha256
      && event.expected_live_definition_sha256 !== beforeHash
    ) {
      return fail(CODES.SQL_COLLISION, 'live Mortgage Ops policy/grant snapshot differs from the expected baseline', {
        expected_live_definition_sha256: event.expected_live_definition_sha256,
        live_definition_sha256: beforeHash,
      });
    }

    const exact = mortgageOpsAlreadyExact(before, intendedFn);

    if (event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize') {
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: beforeHash,
          after_hash: beforeHash,
          result: event.action,
          executor_identity: identity,
          exact,
          no_table_level_update: !tableLevelUpdatePresent(before),
          force_rls: before.force_rls,
          membership_601: {
            user_can_move_tenant_checks_sha256: before.user_can_move_tenant_checks_sha256,
            admin_override_check_status_sha256: before.admin_override_check_status_sha256,
          },
          snapshot: before,
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported Mortgage Ops executor action ${event.action}`);
    }

    if (exact) {
      consumeOneUse(event.one_use_id);
      return ok({
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: beforeHash,
          after_hash: beforeHash,
          result: 'idempotent',
          executor_identity: identity,
          no_table_level_update: true,
          force_rls_unchanged: true,
          membership_601_unchanged: true,
          membership_601: {
            user_can_move_tenant_checks_sha256: before.user_can_move_tenant_checks_sha256,
            admin_override_check_status_sha256: before.admin_override_check_status_sha256,
          },
        },
      });
    }

    await client.query(embedded.details.text);
    const afterLookup = await snapshotMortgageOpsState(client);
    if (!afterLookup.ok) return afterLookup;
    const after = afterLookup.details.snapshot;
    const afterHash = afterLookup.details.hash;

    if (tableLevelUpdatePresent(after)) {
      return fail(CODES.UNRELATED_MUTATION, 'apply introduced a table-level UPDATE grant on mortgage_handling_requests');
    }
    if (JSON.stringify(before.force_rls) !== JSON.stringify(after.force_rls)) {
      return fail(CODES.UNRELATED_MUTATION, 'FORCE RLS changed; STOP');
    }
    if (before.user_can_move_tenant_checks_sha256 !== after.user_can_move_tenant_checks_sha256
      || before.admin_override_check_status_sha256 !== after.admin_override_check_status_sha256) {
      return fail(CODES.SQL_COLLISION, '#601 function definitions changed; STOP');
    }
    if (!financialGrantsUnchanged(before, after)) {
      return fail(CODES.UNRELATED_MUTATION, 'financial table grants changed; STOP');
    }
    if (!mortgageOpsAlreadyExact(after, intendedFn)) {
      return fail(CODES.SQL_COLLISION, 'applied SQL 39 snapshot is not the intended narrow overlay');
    }

    consumeOneUse(event.one_use_id);
    return ok({
      receipt: {
        workstream: event.workstream_id,
        commit: event.commit,
        sql_file: event.filename,
        before_hash: beforeHash,
        after_hash: afterHash,
        result: 'applied',
        executor_identity: identity,
        no_table_level_update: true,
        force_rls_unchanged: true,
        membership_601_unchanged: true,
        before: {
          force_rls: before.force_rls,
          membership_601: {
            user_can_move_tenant_checks_sha256: before.user_can_move_tenant_checks_sha256,
            admin_override_check_status_sha256: before.admin_override_check_status_sha256,
          },
        },
        after: {
          force_rls: after.force_rls,
          membership_601: {
            user_can_move_tenant_checks_sha256: after.user_can_move_tenant_checks_sha256,
            admin_override_check_status_sha256: after.admin_override_check_status_sha256,
          },
          policies: after.policies.map((row) => row.policy_name),
          column_update_grants: after.column_update_grants,
        },
      },
    });
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}
