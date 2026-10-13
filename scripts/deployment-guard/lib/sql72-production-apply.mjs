/**
 * Production apply of SQL 72 (tenant-member payment write policies).
 *
 * Mirrors the staging guarded executor's SQL 72 handler: the five aws_member_*
 * policies must be absent before and present and well-formed after, the helper
 * functions must exist and be executable by authenticated, and every other
 * policy on the three payment tables must be byte-identical, all inside one
 * transaction that rolls back on any mismatch.
 * Runs only on a host with private reachability into the production VPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { resolveLedgerDatabaseUrl } from './ledger-production-apply.mjs';
import { evaluateProductionGate } from './production.mjs';
import { hashSqlDefinition } from './sql-apply.mjs';
import {
  MEMBER_PAYMENT_POLICIES,
  MEMBER_PAYMENT_REQUIRED_FUNCTIONS,
  memberPaymentPolicyStateText,
} from './sql-executor-auth.mjs';
import { createProductionDatabaseConnect } from './sql53-production-apply.mjs';
import { repoRootFrom } from './paths.mjs';

export const SQL72_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql72-production-apply.json';
export const SQL72_PRODUCTION_COMPONENT = 'production-sql';
export const SQL72_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';

const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const PAYMENT_POLICIES_SQL = `
SELECT tablename, policyname, cmd, roles::text AS roles, permissive, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = ANY($1::text[])
ORDER BY tablename, policyname
`.trim();
const REQUIRED_FUNCTIONS_SQL = `
SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
`.trim();
const CLAUSE_MARKERS = ['aws_is_authenticated()', 'aws_financial_execution_active()', 'aws_user_tenant_ids()'];
const FORBIDDEN_MARKERS = ['aws_is_cross_tenant_reader', 'has_role', 'aws_can_access_tenant', 'aws_can_write_tenant'];

// The exact statements SQL 72 may contain, in file order: DROP then CREATE per policy.
const FILE_ORDER = [
  'aws_member_insert_payment_transfers',
  'aws_member_update_payment_transfers',
  'aws_member_insert_payment_wallets',
  'aws_member_update_payment_wallets',
  'aws_member_insert_payment_event_log',
];
const MEMBER_CONDITION = 'public.aws_is_authenticated() AND COALESCE(public.aws_financial_execution_active(), false) AND tenant_id IN (SELECT public.aws_user_tenant_ids())';
const normalize = (text) => String(text).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

export function sql72ExpectedStatements() {
  return FILE_ORDER.flatMap((name) => {
    const pinned = MEMBER_PAYMENT_POLICIES.find((row) => row.name === name);
    const clauses = pinned.cmd === 'UPDATE'
      ? `USING (${MEMBER_CONDITION}) WITH CHECK (${MEMBER_CONDITION})`
      : `WITH CHECK (${MEMBER_CONDITION})`;
    return [
      `DROP POLICY IF EXISTS ${name} ON public.${pinned.table}`,
      normalize(`CREATE POLICY ${name} ON public.${pinned.table} FOR ${pinned.cmd} TO authenticated ${clauses}`),
    ];
  });
}

export function sql72StatementsAllowed(text) {
  const body = String(text || '').split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  const statements = body.split(';').map(normalize).filter(Boolean);
  const expected = sql72ExpectedStatements();
  return statements.length === expected.length && statements.every((statement, index) => statement === expected[index]);
}

const wellFormed = (row, pinned) => {
  if (row.cmd !== pinned.cmd || row.roles !== '{authenticated}' || row.permissive !== 'PERMISSIVE') return false;
  if (pinned.cmd === 'INSERT' && row.qual) return false;
  const clauses = pinned.cmd === 'UPDATE' ? [row.qual, row.with_check] : [row.with_check];
  // Every clause is a pure AND of the three conditions: an OR could loosen it.
  return clauses.every((clause) => typeof clause === 'string'
    && !/\bOR\b/i.test(clause)
    && CLAUSE_MARKERS.every((marker) => clause.includes(marker))
    && FORBIDDEN_MARKERS.every((marker) => !clause.includes(marker)));
};

export function loadSql72ProductionPin(root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, SQL72_PRODUCTION_PIN_REL), 'utf8'));
}

/** Pinned source bytes, read from the repo and checked against the pin. */
export function readPinnedSql72(root, pin) {
  const file = path.join(root, pin.filename);
  if (!fs.existsSync(file)) return fail(CODES.STALE_PACKAGE, 'pinned SQL 72 file is missing');
  const text = fs.readFileSync(file, 'utf8');
  const sha = hashSqlDefinition(text);
  if (sha !== pin.source_sha256) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, 'SQL 72 bytes differ from the production pin', {
      source_sha256: sha,
      pinned_source_sha256: pin.source_sha256,
    });
  }
  if (!sql72StatementsAllowed(text)) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 72 is not exactly the pinned member payment policy statements');
  }
  return ok({ text, source_sha256: sha });
}

export async function readSql72State(client) {
  const tables = [...new Set(MEMBER_PAYMENT_POLICIES.map((row) => row.table))];
  const rows = (await client.query(PAYMENT_POLICIES_SQL, [tables]))?.rows || [];
  const isMember = (row) => MEMBER_PAYMENT_POLICIES.some((pinned) => pinned.name === row.policyname && pinned.table === row.tablename);
  const others = rows.filter((row) => !isMember(row));
  const states = MEMBER_PAYMENT_POLICIES.map((pinned) => {
    const row = rows.find((candidate) => candidate.policyname === pinned.name && candidate.tablename === pinned.table);
    if (!row) return 'absent';
    return wellFormed(row, pinned) ? 'present' : 'malformed';
  });
  const functions = ((await client.query(REQUIRED_FUNCTIONS_SQL, [[...MEMBER_PAYMENT_REQUIRED_FUNCTIONS]]))?.rows || [])
    .filter((row) => row.can_execute === true)
    .map((row) => row.proname);
  return ok({
    member_policy_states: Object.fromEntries(MEMBER_PAYMENT_POLICIES.map((row, index) => [row.name, states[index]])),
    other_policy_count: others.length,
    other_policies_sha256: hashSqlDefinition(JSON.stringify(others)),
    required_functions_present: MEMBER_PAYMENT_REQUIRED_FUNCTIONS.every((name) => functions.includes(name)),
    live_definition_sha256: hashSqlDefinition(memberPaymentPolicyStateText(states)),
  });
}

/** Manifest checks shared by preflight and apply: exact pin plus the production gate. */
export function evaluateSql72ProductionApply(input = {}, { root = repoRootFrom(import.meta.url), pin = loadSql72ProductionPin(root) } = {}) {
  const sql = readPinnedSql72(root, pin);
  if (!sql.ok) return sql;
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', SQL72_PRODUCTION_COMPONENT],
    ['deployment_type', SQL72_PRODUCTION_DEPLOYMENT_TYPE],
    ['filename', pin.filename],
    ['migration_id', pin.migration_id],
    ['source_sha256', pin.source_sha256],
    ['expected_live_definition_sha256', pin.expected_live_definition_sha256],
    // The live hash from the inspect; checked here so a typo never spends the receipt.
    ['live_definition_sha256', pin.expected_live_definition_sha256],
  ].filter(([key, value]) => input[key] !== value).map(([key]) => key);
  if (mismatched.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 72 production apply is bound to the exact production pin', { mismatched });
  }
  if (input.staging_acceptance?.reference !== pin.staging_acceptance?.reference) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'staging acceptance must be the reference recorded in the production pin', {
      expected: pin.staging_acceptance?.reference || null,
    });
  }
  const gate = evaluateProductionGate({ ...input, target_environment: 'production' });
  if (!gate.ok) return gate;
  return ok({
    sql72_production_apply_allowed: true,
    expected_live_definition_sha256: pin.expected_live_definition_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    staging_acceptance: gate.details.staging_acceptance,
  });
}

export const resolveSql72DatabaseUrl = resolveLedgerDatabaseUrl;

export async function inspectSql72Production({ connect, pin }) {
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    const state = await readSql72State(client);
    if (!state.ok) return state;
    return ok({
      read_only: true,
      ...state.details,
      already_applied: state.details.live_definition_sha256 === pin.intended_replacement_sha256,
      apply_preconditions_met: state.details.live_definition_sha256 === pin.expected_live_definition_sha256
        && state.details.required_functions_present === true,
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

function loadConsumed(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { consumed: [] };
  }
}

function consumeOneUse(file, oneUseId) {
  const current = loadConsumed(file);
  current.consumed = [...new Set([...(current.consumed || []), oneUseId])];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current)}\n`, { mode: 0o600 });
}

const consumedFileFor = (root, ctx) => ctx.consumedPath || path.join(root, '.deployment-guard', 'sql72-production-consumed.json');

/** Cheap checks that must pass before the single-use guard receipt is spent. */
export function precheckSql72ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql72ProductionPin(root);
  const evaluation = evaluateSql72ProductionApply(input, { root, pin });
  if (!evaluation.ok) return evaluation;
  if (pin.execute !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 72 production execute is not authorized by this pin');
  }
  if (input.authorization_phrase !== pin.authorization_phrase) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL 72 production apply requires the exact authorization phrase');
  }
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    return fail(CODES.INVALID_MANIFEST, 'SQL 72 production apply requires a single-use id');
  }
  if (loadConsumed(consumedFileFor(root, ctx)).consumed.includes(input.one_use_id)) {
    return fail(CODES.RECEIPT_REUSED, 'one_use_id has already been consumed; replay is forbidden', { one_use_id: input.one_use_id });
  }
  return evaluation;
}

export async function executeSql72ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql72ProductionPin(root);
  const evaluation = precheckSql72ProductionApply(input, { ...ctx, root, pin });
  if (!evaluation.ok) return evaluation;
  const consumedFile = consumedFileFor(root, ctx);
  const sql = readPinnedSql72(root, pin);
  if (!sql.ok) return sql;
  if (typeof ctx.connect !== 'function') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 72 production apply requires a database connection factory');
  }

  const client = await ctx.connect();
  let inTx = false;
  let committed = false;
  let commitSent = false;
  const rollback = async (result) => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      inTx = false;
    }
    return result;
  };
  try {
    await client.query('BEGIN');
    inTx = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['sql72_member_payment_writes']);

    const before = await readSql72State(client);
    if (!before.ok) return rollback(before);
    if (before.details.live_definition_sha256 === pin.intended_replacement_sha256) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'SQL 72 member payment policies are already present; refuse re-apply'));
    }
    if (before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== input.live_definition_sha256) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'member payment policies are not in the expected absent state', {
        member_policy_states: before.details.member_policy_states,
      }));
    }
    if (!before.details.required_functions_present) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'SQL 72 helper functions are missing or not executable by authenticated'));
    }

    await client.query(sql.details.text);

    const after = await readSql72State(client);
    if (!after.ok) return rollback(after);
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256
      || after.details.other_policies_sha256 !== before.details.other_policies_sha256
      || after.details.other_policy_count !== before.details.other_policy_count) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'SQL 72 changed more than the five member payment policies', {
        before: before.details.member_policy_states,
        after: after.details.member_policy_states,
      }));
    }

    commitSent = true;
    await client.query('COMMIT');
    inTx = false;
    committed = true;
    return ok({
      receipt: {
        workstream: input.workstream_id,
        commit: input.commit,
        sql_file: pin.filename,
        before_hash: before.details.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
        member_policy_states_after: after.details.member_policy_states,
        other_policy_count: after.details.other_policy_count,
        other_policies_sha256: after.details.other_policies_sha256,
        staging_acceptance: evaluation.details.staging_acceptance,
        result: 'applied',
      },
    });
  } catch (error) {
    if (commitSent) {
      // COMMIT may have landed before the error; a re-run is refused once the after-state is live.
      inTx = false;
      return fail(CODES.SQL_COLLISION, 'SQL 72 production COMMIT outcome is unknown; re-run --inspect before anything else', {
        message: String(error?.message || error).slice(0, 300),
      });
    }
    return rollback(fail(CODES.SQL_COLLISION, 'SQL 72 production apply failed and was rolled back', {
      message: String(error?.message || error).slice(0, 300),
    }));
  } finally {
    await client.end().catch(() => {});
    // Recorded after the transaction so a registry write error is never reported as a rollback.
    if (committed) {
      try {
        consumeOneUse(consumedFile, input.one_use_id);
      } catch (error) {
        process.stderr.write(`SQL 72 apply COMMITTED; one_use_id ${input.one_use_id} could not be recorded: ${String(error?.message || error).slice(0, 200)}\n`);
      }
    }
  }
}

export { createProductionDatabaseConnect };
