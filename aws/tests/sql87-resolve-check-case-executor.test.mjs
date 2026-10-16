/**
 * SQL 87 (aws/workflows/sql/87_resolve_check_case_tenant_scope.sql): public.resolve_check_case
 * becomes a tenant-scoped internal helper of the two SECURITY DEFINER case trigger
 * functions, with EXECUTE left to its owner. Staging VPC executor support (it reuses the
 * SQL 84-86 engine), the reviewed-text check, and on a real PostgreSQL 16 catalog built
 * from the real Supabase migrations (20260826125804, 20260826125833):
 *   - inspect is read-only and prints no PII, ids or owner names; apply lands once on the
 *     code-derived post-state;
 *   - the trigger callers keep working with no auth.uid() (ingest-shared-check style),
 *     for loss drafts and for UPDATE OF claim_id; a foreign claim or case links nothing
 *     and copies no claim data; anon, authenticated, service_role and checksops can no
 *     longer EXECUTE it;
 *   - behavioural mutants of the file (and the original body) are caught;
 *   - the live server route (workflow-rpc.mjs, accepted 37cab8d6) is unchanged and still
 *     works on the same database: owner, admin, manager and operator act; viewer,
 *     partner, another tenant and a non-member are refused;
 *   - an unsafe owner, a non-SECURITY DEFINER trigger function, an extra grant, another
 *     signature or a missing prerequisite fail closed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE as PIN,
  AUTHORIZED_STAGING_SQL,
  MORTGAGE_DEFINITION_SHA256,
  MORTGAGE_KNOWN_DEFINITION_SHA256,
  MORTGAGE_MIGRATIONS,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
  mortgageAppliedStates,
  mortgageStateText,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL, readLiveSummary } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import {
  CASE_GRANTS_SHA256,
  CASE_MIGRATION_SHA256,
  CLAIM_A,
  CLAIM_B,
  CLAIM_ORGLESS,
  CLAIM_ORGLESS_B,
  FREEDOM_ONLY,
  TENANT_A,
  TENANT_B,
  TENANT_B_PII,
  assertNoSeededPii,
  caseGrants,
  caseMigration,
  caseRolesSql,
  caseSchemaSql,
} from './helpers/check-case-sql-pg.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-16T12:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const KEY = 'sql87';
const CHOICE = 'sql87-resolve-check-case-tenant-scope';
const FN = 'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)';
const INTENDED = '794dcd33b4cd61d8fc607f8e4f84df0daaf8a655afad2c7794ecf084c3a52a30';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler, parseMortgageSql, mortgageReviewedFunctiondefs, mortgageSqlIsReviewed, MORTGAGE_OUTSIDE_SHA256 } = executorModule;

const FILE = path.join(ROOT, PIN.filename);
const TEXT = fs.readFileSync(FILE, 'utf8');
const DEFS = mortgageReviewedFunctiondefs(KEY, TEXT);
const SPEC = MORTGAGE_MIGRATIONS[KEY];
// The committed pin has no recorded pre-state; PG tests use a copy carrying the inspected one.
const recordedPin = (expected) => Object.freeze({ ...PIN, expected_live_definition_sha256: expected });

function caseEvent(overrides = {}) {
  const pin = overrides.pin || PIN;
  const oneUse = overrides.one_use_id || `${KEY}-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${CHOICE}`,
    branch: 'main',
    commit: pin.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256 || READ_LIVE_EXPECTED_SENTINEL,
    one_use_id: oneUse,
    expiry: '2026-10-16T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.one_use_id = oneUse;
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (overrides = {}) => caseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL, ...overrides });

function handlerFor(connect, extra = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql87-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile87: FILE, ...extra });
}
const neverConnect = async () => { throw new Error('should-not-connect'); };
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK TO)\b/i;

test('the pin matches the SQL file and its commit; no pre-state is recorded; the post-state is code-derived; registered everywhere', () => {
  assert.equal(PIN.source_sha256, 'f046c76cc731c08020171ec7e846818089df1bd66a7a07a42237f14fb8c4c22a');
  assert.equal(sha(fs.readFileSync(FILE)), PIN.source_sha256);
  assert.equal(PIN.migration_id, '87_resolve_check_case_tenant_scope');
  assert.equal(PIN.migration, KEY);
  assert.equal(PIN.commit, 'af84133e4e2cd6f3c2f2d8b63c59555d80646c22');
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
  if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), PIN.source_sha256);
  assert.equal(PIN.expected_live_definition_sha256, null, 'no staging read-live recorded yet');
  assert.equal(PIN.intended_replacement_sha256, INTENDED);
  assert.equal(sha(mortgageStateText(KEY, mortgageAppliedStates(KEY))), INTENDED);
  assert.deepEqual([...PIN.function_identities], [FN]);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(MIGRATIONS[CHOICE], PIN);
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === PIN.filename && to === `sql/${path.basename(PIN.filename)}`));
  assert.equal(sha(parseMortgageSql(KEY, TEXT).outside), MORTGAGE_OUTSIDE_SHA256[KEY]);
  assert.equal(mortgageSqlIsReviewed(KEY, TEXT), true);
  assert.equal(sha(DEFS[FN]), MORTGAGE_DEFINITION_SHA256[FN]);
  assert.equal(sha(caseMigration()), CASE_MIGRATION_SHA256);
  assert.equal(sha(caseGrants()), CASE_GRANTS_SHA256);
  // A read-live package evaluates; an apply package needs a recorded pre-state the handler checks.
  assert.equal(evaluateSqlExecutorAuthorization(inspectEvent(), { now: Date.parse(NOW) }).ok, true);
  assert.equal(evaluateSqlExecutorAuthorization(caseEvent({ pin: recordedPin('a'.repeat(64)) }), { now: Date.parse(NOW) }).ok, true);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  const migrationInput = workflow.slice(workflow.indexOf('      migration:'), workflow.indexOf('      approved_commit:'));
  const options = [...migrationInput.matchAll(/^\s+- ([a-z0-9-]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(options, Object.keys(MIGRATIONS));
  assert.ok(options.includes(CHOICE));
  assert.match(workflow, /node --test aws\/tests\/sql87-resolve-check-case-executor\.test\.mjs/);
});

test('the file: same signature and return type, SECURITY DEFINER, search_path=public, REVOKE ALL FROM PUBLIC before the owner grant, 55000 guards, no BEGIN/COMMIT, no table or data change', () => {
  const body = parseMortgageSql(KEY, TEXT);
  const outside = body.outside;
  assert.match(TEXT, /CREATE OR REPLACE FUNCTION public\.resolve_check_case\(\n  _tenant_id uuid,\n  _claim_id uuid DEFAULT NULL,\n  _external_claim_id uuid DEFAULT NULL,\n  _claim_number text DEFAULT NULL,\n  _insured_name text DEFAULT NULL,\n  _property_address text DEFAULT NULL,\n  _carrier_name text DEFAULT NULL\n\) RETURNS uuid\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public\nAS \$\$/);
  // The original signature, as Supabase migration 20260826125804 declares it.
  assert.match(caseMigration(), /CREATE OR REPLACE FUNCTION public\.resolve_check_case\(\n  _tenant_id uuid,\n  _claim_id uuid DEFAULT NULL,\n  _external_claim_id uuid DEFAULT NULL,\n  _claim_number text DEFAULT NULL,\n  _insured_name text DEFAULT NULL,\n  _property_address text DEFAULT NULL,\n  _carrier_name text DEFAULT NULL\n\) RETURNS uuid\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public/);
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im);
  assert.doesNotMatch(outside, /\b(ALTER TABLE|CREATE TABLE|DROP|TRUNCATE|INSERT INTO|UPDATE public|DELETE FROM|CREATE TRIGGER|CREATE POLICY|ALTER POLICY)\b/i);
  const revokePublic = code.indexOf('REVOKE ALL ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;');
  const grant = code.indexOf("EXECUTE format('GRANT EXECUTE ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) TO %I', v_owner);");
  assert.ok(revokePublic > 0 && grant > revokePublic);
  assert.equal((code.match(/GRANT EXECUTE/g) || []).length, 1, 'one grant, to the owner');
  assert.match(code, /'sql87_prerequisite_missing:[^']*'[\s\S]*?USING ERRCODE = '55000'/);
  assert.equal((code.match(/RAISE EXCEPTION 'case_owner_unsafe:/g) || []).length, 4);
  assert.equal((code.match(/RAISE EXCEPTION 'case_callers_unsafe:/g) || []).length, 1);
  assert.equal((code.match(/USING ERRCODE = '55000'/g) || []).length, 6);
  // Every guard runs before the CREATE OR REPLACE; after it only the ACL changes (L3).
  const create = code.indexOf('CREATE OR REPLACE FUNCTION public.resolve_check_case(');
  const lastRaise = code.lastIndexOf('RAISE EXCEPTION');
  assert.ok(lastRaise > 0 && lastRaise < create, 'no guard after the CREATE OR REPLACE');
  const tail = code.slice(code.indexOf('$$;', code.indexOf('AS $$', create) + 5) + 3);
  assert.doesNotMatch(tail, /RAISE|IF |CREATE|ALTER|DROP/);
  assert.match(tail, /REVOKE ALL ON FUNCTION public\.resolve_check_case[^;]*FROM PUBLIC;/);
  assert.equal(code.slice(0, create).includes('REVOKE'), false, 'no ACL change before the new body');
  // The function body: both freedom_crm lookups are tenant-filtered; the claim is read only for _claim_id.
  const fnBody = body.bodies[0];
  assert.equal((fnBody.match(/WHERE tenant_id = _tenant_id\n {7}AND external_system = 'freedom_crm'\n {7}AND external_claim_id = v_ext/g) || []).length, 2);
  assert.equal((fnBody.match(/SELECT \* INTO v_claim FROM public\.claims WHERE id = _claim_id;/g) || []).length, 1);
  assert.doesNotMatch(fnBody, /auth\.uid\(\)|RAISE/);
});

test('the reviewed-text check refuses a wider grant, a missing revoke, an unscoped lookup, a weaker claim rule, a weaker guard, extra statements and a changed body', () => {
  const cases = [
    ['security invoker', 'LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public\nAS $$', 'LANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path = public\nAS $$'],
    ['search_path widened', 'SECURITY DEFINER\nSET search_path = public\nAS $$', 'SECURITY DEFINER\nSET search_path = public, pg_temp\nAS $$'],
    ['no revoke from PUBLIC', 'REVOKE ALL ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;\n', ''],
    ['authenticated kept', "ARRAY['anon', 'authenticated', 'service_role', 'checksops'] LOOP", "ARRAY['anon', 'service_role', 'checksops'] LOOP"],
    ['grant to authenticated', "TO %I', v_owner);", "TO %I', v_owner);\n  GRANT EXECUTE ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) TO authenticated;"],
    ['first lookup unscoped', "  IF v_ext IS NOT NULL THEN\n    SELECT id INTO v_case_id FROM public.check_cases\n     WHERE tenant_id = _tenant_id\n       AND external_system", "  IF v_ext IS NOT NULL THEN\n    SELECT id INTO v_case_id FROM public.check_cases\n     WHERE true\n       AND external_system"],
    ['conflict re-lookup unscoped', "    -- tenant's case, whose id is never returned.\n    SELECT id INTO v_case_id FROM public.check_cases\n     WHERE tenant_id = _tenant_id", "    -- tenant's case, whose id is never returned.\n    SELECT id INTO v_case_id FROM public.check_cases\n     WHERE true"],
    ['claim rule dropped', '      v_ext := NULL;\n', '      NULL;\n'],
    ['org-less rule widened', 'WHERE ci.claim_id = c.id AND ci.tenant_id = _tenant_id)))', 'WHERE ci.claim_id = c.id)))'],
    ['claim read for an external id', 'SELECT * INTO v_claim FROM public.claims WHERE id = _claim_id;', 'SELECT * INTO v_claim FROM public.claims WHERE id = v_ext;'],
    ['secdef guard dropped', "  IF v_intake_secdef IS NOT TRUE OR v_draft_secdef IS NOT TRUE THEN", "  IF false THEN"],
    ['owner guard a notice', "    RAISE EXCEPTION 'case_owner_unsafe: resolve_check_case owner %", "    RAISE NOTICE 'case_owner_unsafe: resolve_check_case owner %"],
    ['API role in owner allowed', "    IF pg_has_role((SELECT oid FROM pg_roles WHERE rolname = v_role), v_fn_owner, 'MEMBER') THEN", "    IF false THEN"],
    ['callers guard dropped', '  IF v_callers IS NOT NULL THEN', '  IF false THEN'],
    ['callers guard ignores dependents', "       AND d.refobjid = 'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)'::regprocedure", '       AND false'],
    ['guard moved after the body', "  IF v_intake_secdef IS NOT TRUE OR v_draft_secdef IS NOT TRUE THEN", "  IF v_intake_secdef IS NOT TRUE AND false THEN"],
    ['prerequisite check dropped', "  IF v_missing IS NOT NULL THEN\n    RAISE EXCEPTION 'sql87_prerequisite_missing", "  IF false THEN\n    RAISE EXCEPTION 'sql87_prerequisite_missing"],
    ['caller check added', "  IF _tenant_id IS NULL THEN\n    RETURN NULL;\n  END IF;\n", "  IF _tenant_id IS NULL OR auth.uid() IS NULL THEN\n    RETURN NULL;\n  END IF;\n"],
    ['table change', 'COMMENT ON FUNCTION public.resolve_check_case', 'ALTER TABLE public.check_cases DISABLE ROW LEVEL SECURITY;\nCOMMENT ON FUNCTION public.resolve_check_case'],
    ['transaction control', 'DO $$\nDECLARE\n  v_missing text[];', 'BEGIN;\nDO $$\nDECLARE\n  v_missing text[];'],
  ];
  for (const [label, from, to] of cases) {
    const text = TEXT.replace(from, to);
    assert.notEqual(text, TEXT, label);
    assert.equal(mortgageSqlIsReviewed(KEY, text), false, label);
  }
  assert.equal(mortgageSqlIsReviewed(KEY, `${TEXT}\nDO $$ BEGIN END $$;\n`), false, 'trailing DO');
  assert.equal(mortgageSqlIsReviewed(KEY, caseMigration()), false, 'the original migration');
  assert.equal(mortgageSqlIsReviewed('sql86', TEXT), false);
  assert.equal(mortgageSqlIsReviewed(KEY, TEXT.replace('-- Idempotent: safe to run more than once.', '-- (reworded)')), true, 'comments alone do not matter');
});

test('apply refuses before connecting: the committed pin (no pre-state), the read-live sentinel, a wrong hash, a forged pin, a tampered file', async () => {
  const pending = await handlerFor(neverConnect)(caseEvent({ expected_live_definition_sha256: 'b'.repeat(64) }));
  assert.equal(pending.code, CODES.SQL_COLLISION);
  assert.match(pending.message, /no reviewed pre-apply live definition hash/);
  const recorded = recordedPin('a'.repeat(64));
  const extra = { sql87Pin: recorded };
  for (const expected of [READ_LIVE_EXPECTED_SENTINEL, 'b'.repeat(64)]) {
    const result = await handlerFor(neverConnect, extra)(caseEvent({ pin: recorded, expected_live_definition_sha256: expected }));
    assert.equal(result.code, CODES.SQL_COLLISION);
    assert.match(result.message, /bound to the exact allowlisted pin/);
  }
  assert.equal((await handlerFor(neverConnect, extra)(caseEvent({ pin: recorded, intended_replacement_sha256: 'c'.repeat(64) }))).ok, false);
  for (const forged of [
    { ...recorded, intended_replacement_sha256: 'c'.repeat(64) },
    { ...recorded, function_identities: [...recorded.function_identities, 'public.tg_check_intake_assign_case()'] },
    { ...recorded, commit: 'f'.repeat(40) },
  ]) {
    const result = await handlerFor(neverConnect, { sql87Pin: forged })(caseEvent({ pin: recorded }));
    assert.equal(result.code, CODES.SQL_COLLISION);
    assert.match(result.message, /committed allowlist entry/);
  }
  assert.equal((await handlerFor(neverConnect, extra)(caseEvent({ pin: recorded, action: 'drop' }))).ok, false);
  const tampered = path.join(os.tmpdir(), `sql87-tampered-${process.pid}.sql`);
  fs.writeFileSync(tampered, `${TEXT}GRANT EXECUTE ON FUNCTION ${FN} TO authenticated;\n`);
  try {
    const result = await handlerFor(neverConnect, { ...extra, sqlFile87: tampered })(caseEvent({ pin: recorded }));
    assert.equal(result.code, CODES.SQL_COLLISION);
  } finally {
    fs.rmSync(tampered, { force: true });
  }
});

test('the AWS API never calls the SQL function: the SPA rpc goes to the workflow-rpc route, which is unchanged (37cab8d6)', () => {
  const rpc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs'), 'utf8');
  assert.equal(sha(rpc), '37cab8d6aac8ee1d9af70481b29dcda1e108904b68a2bc8e525d444e60ddf907');
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-api-overlay-plan.json'), 'utf8'));
  assert.ok(JSON.stringify(plan).includes('37cab8d6aac8ee1d9af70481b29dcda1e108904b68a2bc8e525d444e60ddf907'));
  assert.match(rpc, /export const SAFE_WRITE_RPCS = new Set\(\[[^\]]*'resolve_check_case'/);
  assert.match(rpc, /case 'resolve_check_case':\n\s+return executeResolveCheckCase\(/);
  const data = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  const readRpcs = data.slice(data.indexOf('const READ_RPCS = new Set(['), data.indexOf(']);', data.indexOf('const READ_RPCS = new Set([')));
  assert.ok(readRpcs.length > 0);
  assert.doesNotMatch(readRpcs, /resolve_check_case/, 'not reachable through the generic read RPC path');
  assert.match(data, /SAFE_WRITE_RPCS\.has\(earlyName\)\) \{\n\s+return handleSafeWriteRpc\(/);
  // No Lambda SQL calls the function directly.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  for (const file of walk(path.join(ROOT, 'aws/functions')).filter((f) => f.endsWith('.mjs'))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /resolve_check_case\s*\(/, file);
  }
  // The SPA's call is the adapter's /data/rpc POST.
  assert.match(fs.readFileSync(path.join(ROOT, 'src/lib/checkCases.ts'), 'utf8'), /supabase\.rpc\("resolve_check_case"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/integrations/aws/client.ts'), 'utf8'), /apiFetch\("\/data\/rpc", \{\n\s+method: "POST",\n\s+body: JSON\.stringify\(\{ name, args \}\)/);
});

// --- PostgreSQL 16 ---------------------------------------------------------------

const OWNER = 'case_exec_login';

async function caseFixture(pg, prefix, port, { grantsMigration = true } = {}) {
  const server = startPg(prefix, port);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await admin.query(caseRolesSql(OWNER));
    const owner = await connectAs(OWNER);
    try {
      await owner.query(caseSchemaSql({ withGrantsMigration: grantsMigration }));
    } finally {
      await owner.end();
    }
  } catch (error) {
    await admin.end().catch(() => {});
    server.stop();
    throw error;
  }
  return { server, admin, connectAs };
}

async function loadPg(t) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return null;
  }
  try {
    return (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return null;
  }
}

const FREEDOM_B_ONLY = '00000000-0000-4000-8000-00000000f0b1';
const UNKNOWN_CLAIM = '00000000-0000-4000-8000-00000000dead';

/**
 * Runs the trigger callers as checksops with no request.app_user_id (as
 * ingest-shared-check does) on a clean slate and reports what they linked. Every
 * finding is true for SQL 87.
 */
async function caseScenarios(owner, api) {
  await owner.query('DELETE FROM public.loss_draft_tracking; DELETE FROM public.check_intake_items; DELETE FROM public.check_cases;');
  assert.equal((await api.query("SELECT current_setting('request.app_user_id', true) AS v")).rows[0].v ?? null, null);
  const check = async (values) => {
    const cols = Object.keys(values);
    const row = (await api.query(
      `INSERT INTO public.check_intake_items (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, case_id`,
      Object.values(values),
    )).rows[0];
    return row;
  };
  const caseRow = async (id) => (id ? (await owner.query('SELECT * FROM public.check_cases WHERE id = $1', [id])).rows[0] : null);
  const noBPii = (row) => !TENANT_B_PII.some((pii) => JSON.stringify(row || {}).includes(pii));
  const f = {};

  const ingest1 = await check({ tenant_id: TENANT_A, freedom_claim_id: FREEDOM_ONLY, detected_claim_number: 'DET-1', payee_line: 'Payee One' });
  const ingestCase = await caseRow(ingest1.case_id);
  f.ingest_links_without_auth_uid = ingestCase?.tenant_id === TENANT_A && ingestCase.external_claim_id === FREEDOM_ONLY && ingestCase.external_system === 'freedom_crm';
  const ingest2 = await check({ tenant_id: TENANT_A, freedom_claim_id: FREEDOM_ONLY, detected_claim_number: 'DET-1' });
  f.ingest_reuses_case = ingest2.case_id != null && ingest2.case_id === ingest1.case_id;

  const own = await check({ tenant_id: TENANT_A, claim_id: CLAIM_A });
  const ownCase = await caseRow(own.case_id);
  f.own_claim_links_with_data = ownCase?.tenant_id === TENANT_A && ownCase.external_claim_id === CLAIM_A && ownCase.insured_name === 'Alma Own' && ownCase.loan_number === 'LOAN-OWN-1';

  // Before tenant B has a case for its claim (the original body copied B's data here).
  const foreign = await check({ tenant_id: TENANT_A, claim_id: CLAIM_B, detected_claim_number: 'DET-F' });
  const foreignCase = await caseRow(foreign.case_id);
  f.foreign_claim_copies_nothing = foreignCase?.tenant_id === TENANT_A && foreignCase.external_claim_id === null
    && foreignCase.external_system === 'checksops' && foreignCase.claim_number === 'DET-F' && noBPii(foreignCase);

  const bCheck = await check({ tenant_id: TENANT_B, claim_id: CLAIM_B });
  const bCase = await caseRow(bCheck.case_id);
  f.other_tenant_links_its_own = bCase?.tenant_id === TENANT_B && bCase.insured_name === 'Bea Foreign';

  const foreignNoNumber = await check({ tenant_id: TENANT_A, claim_id: CLAIM_B });
  f.foreign_claim_without_number_unlinked = foreignNoNumber.case_id === null;
  const foreignExt = await check({ tenant_id: TENANT_A, freedom_claim_id: CLAIM_B });
  f.foreign_external_id_unlinked = foreignExt.case_id === null;

  const unknown = await check({ tenant_id: TENANT_A, claim_id: UNKNOWN_CLAIM, detected_claim_number: 'DET-U' });
  const unknownCase = await caseRow(unknown.case_id);
  f.unknown_claim_id_not_linked = unknownCase?.tenant_id === TENANT_A && unknownCase.external_claim_id === null;

  const bFreedom = await check({ tenant_id: TENANT_B, freedom_claim_id: FREEDOM_B_ONLY, detected_claim_number: 'B-1' });
  const conflict = await check({ tenant_id: TENANT_A, freedom_claim_id: FREEDOM_B_ONLY });
  f.conflict_never_returns_other_tenant_case = bFreedom.case_id != null && conflict.case_id === null;

  // Org-less: counts as A's only once one of A's checks references it.
  const bOrgless1 = await check({ tenant_id: TENANT_B, claim_id: CLAIM_ORGLESS_B, detected_claim_number: 'B-O' });
  const bOrgless2 = await check({ tenant_id: TENANT_B, claim_id: CLAIM_ORGLESS_B });
  f.orgless_links_once_referenced = (await caseRow(bOrgless1.case_id))?.external_claim_id === null
    && (await caseRow(bOrgless2.case_id))?.external_claim_id === CLAIM_ORGLESS_B;
  const aOnB = await check({ tenant_id: TENANT_A, claim_id: CLAIM_ORGLESS_B, detected_claim_number: 'A-OB' });
  const aOnBCase = await caseRow(aOnB.case_id);
  f.orgless_of_other_tenant_copies_nothing = aOnBCase?.tenant_id === TENANT_A && aOnBCase.external_claim_id === null && noBPii(aOnBCase);
  await check({ tenant_id: TENANT_A, claim_id: CLAIM_ORGLESS, detected_claim_number: 'A-O' });
  const aOrgless = await check({ tenant_id: TENANT_A, claim_id: CLAIM_ORGLESS });
  f.own_orgless_links_once_referenced = (await caseRow(aOrgless.case_id))?.insured_name === 'Orla Orgless';

  // Loss drafts and UPDATE OF claim_id (admin_set_check_claim).
  const bare = await check({ tenant_id: TENANT_A });
  const draft = (await api.query('INSERT INTO public.loss_draft_tracking (check_intake_item_id, claim_id) VALUES ($1, $2) RETURNING case_id', [bare.id, CLAIM_A])).rows[0];
  f.loss_draft_links = bare.case_id === null && draft.case_id === own.case_id;
  const bare2 = await check({ tenant_id: TENANT_A });
  const foreignDraft = (await api.query('INSERT INTO public.loss_draft_tracking (check_intake_item_id, claim_id) VALUES ($1, $2) RETURNING case_id', [bare2.id, CLAIM_B])).rows[0];
  f.loss_draft_foreign_claim_unlinked = foreignDraft.case_id === null;
  const bare3 = await check({ tenant_id: TENANT_A });
  const updated = (await api.query('UPDATE public.check_intake_items SET claim_id = $2 WHERE id = $1 RETURNING case_id', [bare3.id, CLAIM_A])).rows[0];
  f.update_claim_id_links = updated.case_id === own.case_id;

  // Across everything: a check's case is always in its own tenant; no B data in an A case.
  const crossLinks = (await owner.query(`SELECT count(*)::int AS n FROM public.check_intake_items ci JOIN public.check_cases cc ON cc.id = ci.case_id WHERE cc.tenant_id IS DISTINCT FROM ci.tenant_id`)).rows[0].n;
  const draftCross = (await owner.query(`SELECT count(*)::int AS n FROM public.loss_draft_tracking l JOIN public.check_intake_items ci ON ci.id = l.check_intake_item_id
    JOIN public.check_cases cc ON cc.id = l.case_id WHERE cc.tenant_id IS DISTINCT FROM ci.tenant_id`)).rows[0].n;
  f.no_cross_tenant_links = crossLinks === 0 && draftCross === 0;
  const aCases = (await owner.query('SELECT * FROM public.check_cases WHERE tenant_id = $1', [TENANT_A])).rows;
  f.no_tenant_b_data_in_tenant_a = aCases.every(noBPii);

  // EXECUTE: only the owner.
  const priv = (await owner.query(`SELECT r, has_function_privilege(r, $1, 'EXECUTE') AS can
    FROM unnest(ARRAY['authenticated', 'anon', 'service_role', 'checksops', current_user::text]) r`, [FN])).rows;
  f.api_roles_cannot_execute = priv.filter((row) => row.r !== OWNER).every((row) => row.can === false);
  f.owner_can_execute = priv.find((row) => row.r === OWNER)?.can === true;
  return f;
}

test('PostgreSQL 16: inspect is read-only and prints no PII or ids; SQL 87 lands once on the code-derived hash; the trigger callers keep working and stay in their tenant', { timeout: 240000 }, async (t) => {
  const pg = await loadPg(t);
  if (!pg) return;
  const { server, admin, connectAs } = await caseFixture(pg, 'pg-sql87-exec-', 58300);
  try {
    const seen = [];
    const connect = async () => {
      const client = await connectAs(OWNER);
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const before = await handlerFor(connect)(inspectEvent());
    assert.equal(before.ok, true, JSON.stringify(before));
    const receipt = before.details.receipt;
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
    const report = receipt.mortgage_inspect;
    assert.deepEqual(receipt.precondition_failures, [], JSON.stringify(report));
    assert.equal(receipt.pin_executable, false);
    assert.equal(receipt.apply_preconditions_met, false, 'the committed pin has no pre-state');
    assert.equal(receipt.sql47_prerequisites_present, true);
    assert.notEqual(receipt.live_definition_sha256, INTENDED);
    assert.equal(report.functions.resolve_check_case.state, 'case_original');
    assert.equal(report.functions.resolve_check_case.definition_sha256, MORTGAGE_KNOWN_DEFINITION_SHA256[FN].case_original);
    assert.equal(report.functions.resolve_check_case.body_matches_migration, false);
    assert.deepEqual(report.functions.resolve_check_case.acl_entries, ['authenticated EXECUTE', 'service_role EXECUTE']);
    for (const name of ['tg_check_intake_assign_case', 'tg_loss_draft_assign_case']) {
      assert.equal(report.functions[name].state, 'case_original', name);
      assert.equal(report.functions[name].security_definer, true, name);
    }
    assert.deepEqual(report.case_owner, {
      helper_present: true,
      trigger_functions_present: true,
      same_owner: true,
      trigger_functions_security_definer: true,
      owner_is_api_role: false,
      owner_rolsuper: false,
      api_role_member_of_owner: false,
      api_roles_member_of_owner: [],
      api_roles_present: ['anon', 'authenticated', 'checksops', 'service_role'],
      case_owner_safe: true,
    });
    // The clean case: no other caller.
    assert.deepEqual(report.other_callers, {
      function_count: 0, functions: [], view_or_rule_count: 0, views_or_rules: [], policy_count: 0, policies: [],
      dependent_function_count: 0, dependent_functions: [], other_dependent_count: 0, other_dependents: [], total: 0,
    });
    assert.deepEqual(report.case_triggers, {
      assign_case_on_check_intake: { present: true, enabled: true, calls_function: true },
      assign_case_on_loss_draft: { present: true, enabled: true, calls_function: true },
    });
    assert.deepEqual(report.missing_columns, {});
    // No PII, no ids, no owner names in the staging report or the read-live summary.
    assertNoSeededPii(assert, before, 'executor result');
    assert.doesNotMatch(JSON.stringify(report), UUID_RE);
    assert.equal(JSON.stringify(report).includes(OWNER), false);
    const summary = readLiveSummary({ ok: true, details: before }, { migration: CHOICE, pin: PIN });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    // The read-live summary keeps the whole report except text over its 200-character cap
    // (the helper's seven-parameter argument list; precondition arguments_match covers it).
    const expectedSummary = JSON.parse(JSON.stringify(report));
    expectedSummary.functions.resolve_check_case.arguments = 'unrecognized';
    assert.deepEqual(summary.details.mortgage_inspect, expectedSummary);
    assertNoSeededPii(assert, summary, 'read-live summary');
    assert.doesNotMatch(JSON.stringify(summary), UUID_RE);

    // The original body leaks across tenants (the bug).
    const owner = await connectAs(OWNER);
    const api = await connectAs('checksops');
    try {
      const bug = await caseScenarios(owner, api);
      assert.equal(bug.foreign_claim_copies_nothing, false);
      assert.equal(bug.foreign_external_id_unlinked, false);
      assert.equal(bug.conflict_never_returns_other_tenant_case, false);
      assert.equal(bug.no_cross_tenant_links, false);
      assert.equal(bug.no_tenant_b_data_in_tenant_a, false);
      assert.equal(bug.api_roles_cannot_execute, false);

      const recorded = recordedPin(receipt.live_definition_sha256);
      // The scenarios changed rows only: the fingerprint is the same.
      await owner.query('DELETE FROM public.loss_draft_tracking; DELETE FROM public.check_intake_items; DELETE FROM public.check_cases;');
      const handler = handlerFor(connect, { sql87Pin: recorded });
      assert.equal((await handler(inspectEvent({ pin: recorded }))).details.receipt.apply_preconditions_met, true);
      const event = caseEvent({ pin: recorded });
      const applied = await handler(event);
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal(applied.details.receipt.before_hash, receipt.live_definition_sha256);
      assert.equal(applied.details.receipt.after_hash, INTENDED);
      const after = (await handler(inspectEvent({ pin: recorded }))).details.receipt;
      assert.equal(after.live_definition_sha256, INTENDED);
      assert.equal(after.already_applied, true);
      assert.equal(after.apply_preconditions_met, false);
      assert.equal(after.mortgage_inspect.functions.resolve_check_case.state, 'intended');
      assert.equal(after.mortgage_inspect.functions.resolve_check_case.matches_migration, true);
      assert.equal(after.mortgage_inspect.functions.resolve_check_case.body_matches_migration, true);
      assert.deepEqual(after.mortgage_inspect.functions.resolve_check_case.acl_entries, []);
      for (const name of ['tg_check_intake_assign_case', 'tg_loss_draft_assign_case']) {
        assert.equal(after.mortgage_inspect.functions[name].state, 'case_original', `${name} unchanged`);
      }
      await admin.query("SELECT set_config('search_path', 'pg_catalog', false)");
      const row = (await admin.query(`SELECT encode(sha256(convert_to(pg_get_functiondef($1::regprocedure), 'UTF8')), 'hex') AS def_sha,
        pg_get_userbyid(proowner) AS owner, proacl::text AS acl, prosecdef, proconfig::text AS config,
        pg_get_function_result(oid) AS result, pg_get_function_arguments(oid) AS args
        FROM pg_proc WHERE oid = $1::regprocedure`, [FN])).rows[0];
      assert.deepEqual(row, {
        def_sha: MORTGAGE_DEFINITION_SHA256[FN],
        owner: OWNER,
        acl: `{${OWNER}=X/${OWNER}}`,
        prosecdef: true,
        config: '{search_path=public}',
        result: 'uuid',
        args: SPEC.functions[0].arguments,
      });
      assert.equal((await handler(event)).code, CODES.SQL_COLLISION, 'replay');
      const reapply = await handler(caseEvent({ pin: recorded }));
      assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
      assert.match(reapply.message, /already in place/);

      const fixed = await caseScenarios(owner, api);
      for (const [name, value] of Object.entries(fixed)) assert.equal(value, true, `${name}: ${JSON.stringify(fixed)}`);
      // Calling it directly as an API role is refused (42501).
      for (const role of ['authenticated', 'anon', 'service_role']) {
        await admin.query(`SET ROLE ${role}`);
        await assert.rejects(admin.query(`SELECT public.resolve_check_case($1::uuid, $2::uuid)`, [TENANT_A, CLAIM_B]), (error) => error.code === '42501', role);
        await admin.query('RESET ROLE');
      }
      await assert.rejects(api.query('SELECT public.resolve_check_case($1::uuid)', [TENANT_A]), (error) => error.code === '42501');
      // Running the file again is a no-op (idempotent) and still lands on the same state.
      await owner.query(TEXT);
      assert.equal((await handler(inspectEvent({ pin: recorded }))).details.receipt.live_definition_sha256, INTENDED);
    } finally {
      await api.end();
      await owner.end();
    }
  } finally {
    await admin.end();
    server.stop();
  }
});

test('PostgreSQL 16: behavioural mutants of SQL 87 are caught by the trigger scenarios', { timeout: 240000 }, async (t) => {
  const pg = await loadPg(t);
  if (!pg) return;
  const { server, admin, connectAs } = await caseFixture(pg, 'pg-sql87-mut-', 58400);
  const owner = await connectAs(OWNER);
  const api = await connectAs('checksops');
  try {
    const mutants = [
      ['first freedom lookup unscoped', "  IF v_ext IS NOT NULL THEN\n    SELECT id INTO v_case_id FROM public.check_cases\n     WHERE tenant_id = _tenant_id\n", "  IF v_ext IS NOT NULL THEN\n    SELECT id INTO v_case_id FROM public.check_cases\n     WHERE true\n", ['conflict_never_returns_other_tenant_case', 'no_cross_tenant_links']],
      ['conflict re-lookup unscoped', "    -- tenant's case, whose id is never returned.\n    SELECT id INTO v_case_id FROM public.check_cases\n     WHERE tenant_id = _tenant_id\n", "    -- tenant's case, whose id is never returned.\n    SELECT id INTO v_case_id FROM public.check_cases\n     WHERE true\n", ['conflict_never_returns_other_tenant_case', 'no_cross_tenant_links']],
      ['claim rule dropped', '      v_ext := NULL;\n', '      NULL;\n', ['foreign_claim_copies_nothing']],
      ['claim data copied before the rule', '      v_ext := NULL;\n', '      v_ext := NULL;\n      SELECT * INTO v_claim FROM public.claims WHERE id = _claim_id;\n', ['foreign_claim_copies_nothing', 'no_tenant_b_data_in_tenant_a']],
      ['missing _claim_id row allowed', '       OR (NOT v_claim_found AND _claim_id IS NOT NULL) THEN', '       THEN', ['unknown_claim_id_not_linked']],
      ['org-less rule ignores the tenant', 'WHERE ci.claim_id = c.id AND ci.tenant_id = _tenant_id)))', 'WHERE ci.claim_id = c.id)))', ['orgless_of_other_tenant_copies_nothing']],
      ['authenticated keeps EXECUTE', "ARRAY['anon', 'authenticated', 'service_role', 'checksops'] LOOP", "ARRAY['anon', 'service_role', 'checksops'] LOOP", ['api_roles_cannot_execute']],
      ['PUBLIC keeps EXECUTE', 'REVOKE ALL ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;\n', 'GRANT EXECUTE ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) TO PUBLIC;\n', ['api_roles_cannot_execute']],
    ];
    for (const [label, from, to, expected] of mutants) {
      const text = TEXT.replace(from, to);
      assert.notEqual(text, TEXT, label);
      assert.equal(mortgageSqlIsReviewed(KEY, text), false, `${label} is not the reviewed text`);
      // Back to the original grants, then the mutant.
      await owner.query(caseGrants());
      await owner.query(text);
      const findings = await caseScenarios(owner, api);
      const failed = Object.entries(findings).filter(([, value]) => value !== true).map(([name]) => name);
      for (const name of expected) assert.ok(failed.includes(name), `${label}: expected ${name} to fail, failed ${JSON.stringify(failed)}`);
    }
    await owner.query(caseGrants());
    await owner.query(TEXT);
    const fixed = await caseScenarios(owner, api);
    assert.deepEqual(Object.entries(fixed).filter(([, value]) => value !== true), []);
  } finally {
    await api.end();
    await owner.end();
    await admin.end();
    server.stop();
  }
});

test('PostgreSQL 16: the live server route (workflow-rpc.mjs 37cab8d6) is unchanged by SQL 87: acting roles resolve, viewer, partner, another tenant and a non-member are refused', { timeout: 240000 }, async (t) => {
  const pg = await loadPg(t);
  if (!pg) return;
  const { executeSafeWriteRpc } = await import('../functions/api/workflow-rpc.mjs');
  const { server, admin, connectAs } = await caseFixture(pg, 'pg-sql87-route-', 58500);
  const owner = await connectAs(OWNER);
  try {
    await owner.query(TEXT);
    // The route runs as checksops (not the function owner); this policy stands in for the
    // AWS check_cases policies, which the route's own tenant check precedes.
    await owner.query('CREATE POLICY sql87_test_route ON public.check_cases TO checksops USING (true) WITH CHECK (true)');
    const users = {};
    const roles = ['owner', 'admin', 'manager', 'operator', 'viewer', 'partner', 'Operator'];
    for (const [index, role] of roles.entries()) {
      users[role] = `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`;
      await owner.query('INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_A, users[role], role]);
    }
    users.b_operator = '00000000-0000-4000-8000-0000000002b1';
    await owner.query('INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [TENANT_B, users.b_operator, 'operator']);
    users.nobody = '00000000-0000-4000-8000-0000000003ff';
    const api = await connectAs('checksops');
    try {
      await assert.rejects(api.query('SELECT public.resolve_check_case($1::uuid)', [TENANT_A]), (error) => error.code === '42501');
      const call = (user, args) => executeSafeWriteRpc({ client: api, mapping: { application_user_id: user }, name: 'resolve_check_case', args });
      let ownCase = null;
      for (const role of ['owner', 'admin', 'manager', 'operator', 'Operator']) {
        const result = await call(users[role], { _tenant_id: TENANT_A, _claim_id: CLAIM_A });
        assert.match(String(result.data), UUID_RE, `${role}: ${JSON.stringify(result)}`);
        ownCase ||= result.data;
        assert.equal(result.data, ownCase, `${role} resolves the same case`);
      }
      const row = (await owner.query('SELECT tenant_id, insured_name FROM public.check_cases WHERE id = $1', [ownCase])).rows[0];
      assert.deepEqual(row, { tenant_id: TENANT_A, insured_name: 'Alma Own' });
      for (const role of ['viewer', 'partner']) {
        assert.equal((await call(users[role], { _tenant_id: TENANT_A, _claim_id: CLAIM_A })).error, 'not_authorized', role);
      }
      assert.equal((await call(users.nobody, { _tenant_id: TENANT_A, _claim_id: CLAIM_A })).error, 'not_authorized', 'non-member');
      assert.equal((await call(users.b_operator, { _tenant_id: TENANT_A, _claim_id: CLAIM_A })).error, 'not_authorized', 'another tenant');
      assert.equal((await call(users.operator, { _tenant_id: TENANT_B, _claim_id: CLAIM_B })).error, 'not_authorized', "another tenant's check case");
      assert.equal((await call(users.operator, { _tenant_id: TENANT_A, _claim_id: CLAIM_B })).error, 'claim_not_in_tenant', "another tenant's claim");
      assert.equal((await call(users.operator, { _tenant_id: TENANT_A, _external_claim_id: CLAIM_B })).error, 'claim_not_in_tenant', "another tenant's claim as an external id");
      const numbered = await call(users.manager, { _tenant_id: TENANT_A, _claim_number: 'RPC-1', _insured_name: 'Rpc Name' });
      assert.match(String(numbered.data), UUID_RE);
      // The trigger path on the same database keeps working after the route's writes.
      const linked = (await api.query('INSERT INTO public.check_intake_items (tenant_id, claim_id) VALUES ($1, $2) RETURNING case_id', [TENANT_A, CLAIM_A])).rows[0];
      assert.equal(linked.case_id, ownCase);
    } finally {
      await api.end();
    }
  } finally {
    await owner.end();
    await admin.end();
    server.stop();
  }
});

test('PostgreSQL 16: an unsafe owner, a non-SECURITY DEFINER trigger function, an extra grant, another signature and a missing prerequisite fail closed; roles that do not exist are skipped; drift and collateral changes roll back', { timeout: 240000 }, async (t) => {
  const pg = await loadPg(t);
  if (!pg) return;
  const { server, admin, connectAs } = await caseFixture(pg, 'pg-sql87-clash-', 58600);
  try {
    const connect = () => connectAs(OWNER);
    const owner = await connectAs(OWNER);
    const inspect = async (pin = PIN) => (await handlerFor(connect, { sql87Pin: pin })(inspectEvent({ pin }))).details.receipt;
    const fileRefuses = async (pattern, as = owner) => {
      await as.query('BEGIN');
      try {
        await assert.rejects(as.query(TEXT), (error) => error.code === '55000' && pattern.test(error.message), String(pattern));
      } finally {
        await as.query('ROLLBACK');
      }
    };
    const refusedThenRestored = async (label, breakIt, restore, failures, { as = owner, file = null, report = null } = {}) => {
      await as.query(breakIt);
      const receipt = await inspect();
      for (const failure of failures) assert.ok(receipt.precondition_failures.includes(failure), `${label}: ${JSON.stringify(receipt.precondition_failures)}`);
      if (report) report(receipt.mortgage_inspect);
      assert.doesNotMatch(JSON.stringify(receipt.mortgage_inspect), /[0-9a-f]{8}-[0-9a-f]{4}-/i, `${label}: no ids`);
      const recorded = recordedPin(receipt.live_definition_sha256);
      const refused = await handlerFor(connect, { sql87Pin: recorded })(caseEvent({ pin: recorded }));
      assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(refused)}`);
      if (file) await fileRefuses(file, admin);
      await as.query(restore);
      assert.deepEqual((await inspect()).precondition_failures, [], `${label} restored`);
    };
    assert.deepEqual((await inspect()).precondition_failures, []);

    await refusedThenRestored('a case trigger function that is not SECURITY DEFINER',
      'ALTER FUNCTION public.tg_loss_draft_assign_case() SECURITY INVOKER',
      'ALTER FUNCTION public.tg_loss_draft_assign_case() SECURITY DEFINER',
      ['case_owner_safe'], { file: /case_owner_unsafe: tg_check_intake_assign_case and tg_loss_draft_assign_case must be SECURITY DEFINER/ });
    await refusedThenRestored('a trigger function with another owner',
      'CREATE ROLE migrator NOLOGIN; ALTER FUNCTION public.tg_check_intake_assign_case() OWNER TO migrator',
      `ALTER FUNCTION public.tg_check_intake_assign_case() OWNER TO ${OWNER}; DROP ROLE migrator`,
      ['case_owner_safe'], { as: admin, file: /case_owner_unsafe: resolve_check_case \(owner/ });
    // L2: an API role that is a member of the owner (inheriting, or SET ROLE only) keeps its EXECUTE.
    await refusedThenRestored('checksops a member of the owner',
      `GRANT ${OWNER} TO checksops`, `REVOKE ${OWNER} FROM checksops`,
      ['case_owner_safe'], { as: admin, file: /case_owner_unsafe: the API role checksops is a member of resolve_check_case owner/,
        report: (r) => assert.deepEqual(r.case_owner.api_roles_member_of_owner, ['checksops']) });
    await refusedThenRestored('authenticated a member of the owner without INHERIT',
      `GRANT ${OWNER} TO authenticated WITH INHERIT FALSE`, `REVOKE ${OWNER} FROM authenticated`,
      ['case_owner_safe'], { as: admin, file: /the API role authenticated is a member/ });
    await refusedThenRestored('the owner is an API role',
      `ALTER FUNCTION ${FN} OWNER TO service_role; ALTER FUNCTION public.tg_check_intake_assign_case() OWNER TO service_role; ALTER FUNCTION public.tg_loss_draft_assign_case() OWNER TO service_role`,
      `ALTER FUNCTION ${FN} OWNER TO ${OWNER}; ALTER FUNCTION public.tg_check_intake_assign_case() OWNER TO ${OWNER}; ALTER FUNCTION public.tg_loss_draft_assign_case() OWNER TO ${OWNER}`,
      ['case_owner_safe'], { as: admin, file: /case_owner_unsafe: resolve_check_case owner service_role is the API role service_role/ });
    // The owner being a member of API roles is not refused (a CREATEROLE owner is a member,
    // with ADMIN, of every role it created); the file still revokes their EXECUTE.
    await admin.query(`GRANT checksops TO ${OWNER} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE; GRANT service_role TO ${OWNER}`);
    assert.deepEqual((await inspect()).precondition_failures, []);
    await admin.query('BEGIN');
    await admin.query(TEXT);
    const inTx = (await admin.query(`SELECT r, has_function_privilege(r, $1, 'EXECUTE') AS can FROM unnest(ARRAY['checksops', 'service_role', $2]) r`, [FN, OWNER])).rows;
    await admin.query('ROLLBACK');
    assert.deepEqual(inTx.map((row) => [row.r, row.can]), [['checksops', false], ['service_role', false], [OWNER, true]]);
    await admin.query(`REVOKE checksops FROM ${OWNER}; REVOKE service_role FROM ${OWNER}`);
    // M1: other callers of the helper refuse (names only in the report).
    await refusedThenRestored('a function owned by another role that calls it',
      `CREATE ROLE reporter NOLOGIN;
       CREATE FUNCTION public.case_report(t uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$ BEGIN RETURN public.resolve_check_case(t); END $f$;
       ALTER FUNCTION public.case_report(uuid) OWNER TO reporter`,
      'DROP FUNCTION public.case_report(uuid); DROP ROLE reporter',
      ['other_callers_present'], { as: admin, file: /case_callers_unsafe: .*function (public\.)?case_report\(uuid\)/,
        report: (r) => assert.deepEqual([r.other_callers.functions, r.other_callers.total], [['public.case_report(uuid)'], 1]) });
    await refusedThenRestored('a view that calls it',
      'CREATE VIEW public.case_probe AS SELECT public.resolve_check_case(NULL::uuid) AS id',
      'DROP VIEW public.case_probe',
      ['other_callers_present'], { file: /case_callers_unsafe: .*dependent pg_rewrite/,
        report: (r) => assert.deepEqual([r.other_callers.views_or_rules, r.other_callers.total], [['public.case_probe rule _RETURN'], 1]) });
    await refusedThenRestored('a policy that calls it',
      'CREATE POLICY case_probe_policy ON public.claims USING (public.resolve_check_case(org_id) IS NULL)',
      'DROP POLICY case_probe_policy ON public.claims',
      ['other_callers_present'], { file: /case_callers_unsafe: .*dependent pg_policy/,
        report: (r) => assert.deepEqual(r.other_callers.policies, ['public.claims policy case_probe_policy']) });
    await refusedThenRestored('a SQL-standard function body that calls it',
      'CREATE FUNCTION public.case_atomic(t uuid) RETURNS uuid LANGUAGE sql BEGIN ATOMIC SELECT public.resolve_check_case(t); END',
      'DROP FUNCTION public.case_atomic(uuid)',
      ['other_callers_present'], { file: /case_callers_unsafe: .*dependent pg_proc/,
        report: (r) => assert.deepEqual(r.other_callers.dependent_functions, ['public.case_atomic(uuid)']) });
    await refusedThenRestored('an EXECUTE grant the file does not revoke',
      `CREATE ROLE reporting NOLOGIN; GRANT EXECUTE ON FUNCTION ${FN} TO reporting`,
      `REVOKE EXECUTE ON FUNCTION ${FN} FROM reporting; DROP ROLE reporting`,
      ['acl_replaceable:resolve_check_case'], { as: admin });
    await refusedThenRestored('another signature of resolve_check_case',
      'CREATE FUNCTION public.resolve_check_case(_tenant_id uuid, _x int) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$',
      'DROP FUNCTION public.resolve_check_case(uuid, int)',
      ['no_other_signature:resolve_check_case']);
    // The anon, authenticated, service_role and checksops grants are all replaceable.
    await owner.query(`GRANT EXECUTE ON FUNCTION ${FN} TO checksops, anon, PUBLIC`);
    assert.deepEqual((await inspect()).precondition_failures, []);
    await owner.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM checksops`);
    await owner.query(caseGrants());

    // A missing prerequisite: 55000 sql87_prerequisite_missing (and the inspect refuses).
    await owner.query('ALTER TABLE public.loss_draft_tracking RENAME TO loss_draft_tracking_x');
    const missing = await inspect();
    assert.ok(missing.precondition_failures.includes('sql47_prerequisites_present'), JSON.stringify(missing.precondition_failures));
    await fileRefuses(/sql87_prerequisite_missing: .*missing public\.loss_draft_tracking/);
    await owner.query('ALTER TABLE public.loss_draft_tracking_x RENAME TO loss_draft_tracking');

    // Drift between the recorded inspect and the apply: DEPLOYMENT_COLLISION, nothing changed.
    const recorded = recordedPin((await inspect()).live_definition_sha256);
    await owner.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM service_role`);
    const collision = await handlerFor(connect, { sql87Pin: recorded })(caseEvent({ pin: recorded }));
    assert.equal(collision.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(collision));
    assert.match(collision.message, /not the pinned pre-apply state/);
    await owner.query(`GRANT EXECUTE ON FUNCTION ${FN} TO service_role`);

    // A file that also changes something unrelated rolls back.
    const wrap = (extra) => async () => {
      const client = await connectAs(OWNER);
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql) === TEXT ? query(`${sql}\n${extra}`, params) : query(sql, params));
      return client;
    };
    for (const [extra, changed] of [
      ['ALTER TABLE public.check_cases DISABLE ROW LEVEL SECURITY;', ['relations_sha256']],
      ['ALTER TABLE public.check_cases ADD COLUMN note text;', ['columns_sha256']],
      ['ALTER FUNCTION public.tg_check_intake_assign_case() SECURITY INVOKER;', null],
      ['DROP TRIGGER assign_case_on_loss_draft ON public.loss_draft_tracking;', ['triggers_sha256']],
    ]) {
      const result = await handlerFor(wrap(extra), { sql87Pin: recorded })(caseEvent({ pin: recorded }));
      assert.equal(result.code, CODES.UNRELATED_MUTATION, `${extra}: ${JSON.stringify(result)}`);
      if (changed) assert.deepEqual(result.details.unrelated_changed, changed, extra);
      else assert.ok(result.details.failed.includes('case_owner_safe') || result.details.unrelated_changed.includes('functions_sha256'), JSON.stringify(result.details));
    }
    assert.equal((await inspect()).live_definition_sha256, recorded.expected_live_definition_sha256, 'every refused apply rolled back');

    // Roles that do not exist are skipped (a database without Supabase's service_role).
    await admin.query(`REVOKE ALL ON FUNCTION ${FN} FROM service_role; REVOKE USAGE ON SCHEMA public FROM service_role; DROP ROLE service_role`);
    const noServiceRole = await inspect();
    assert.deepEqual(noServiceRole.precondition_failures, []);
    assert.deepEqual(noServiceRole.mortgage_inspect.case_owner.api_roles_present, ['anon', 'authenticated', 'checksops']);
    const ready = recordedPin(noServiceRole.live_definition_sha256);
    const applied = await handlerFor(connect, { sql87Pin: ready })(caseEvent({ pin: ready }));
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, INTENDED, 'the post-state does not depend on which API roles exist');
    await owner.end();
  } finally {
    await admin.end();
    server.stop();
  }
});
