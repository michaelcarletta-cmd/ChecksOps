/**
 * SQL 88 (aws/workflows/sql/88_claim_id_assign_case_tenant_scope.sql): the trigger
 * function public.tg_claim_id_assign_case() links only a case of the row's own tenant for
 * a claim that belongs to that tenant, with EXECUTE left to its owner. Staging VPC
 * executor support (it reuses the SQL 84-87 engine), the reviewed-text check, and on a
 * real PostgreSQL 16 catalog built from the real Supabase migrations (20260826125804,
 * 20260826125833), with and without SQL 87:
 *   - inspect is read-only and prints no PII, ids or owner names; its cross_tenant_links
 *     counts are 0 on a clean fixture and exact on a seeded one; apply lands once on the
 *     code-derived post-state;
 *   - the six triggers keep linking same-tenant rows with no auth.uid(), on INSERT and on
 *     UPDATE OF claim_id; a foreign claim or case links nothing and copies nothing; anon,
 *     authenticated, service_role and checksops get 42501 calling it directly;
 *   - behavioural mutants of the file (and the original body) are caught;
 *   - an unsafe owner, a non-SECURITY DEFINER case function, another caller, an extra
 *     grant, another signature or a missing prerequisite fail closed; SQL 87 still applies
 *     and re-runs on top.
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
  AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE as PIN,
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
  CLAIM_A,
  CLAIM_B,
  CLAIM_ORGLESS,
  CLAIM_ORGLESS_B,
  TENANT_A,
  TENANT_B,
  TENANT_B_PII,
  assertNoSeededPii,
  caseMigration,
  caseRolesSql,
} from './helpers/check-case-sql-pg.mjs';
import {
  CLAIM_ID_TABLES,
  CLEAR_ROWS_SQL,
  SEEDED_CROSS_TENANT_COUNTS,
  SEEDED_CROSS_TENANT_TOTAL,
  claimIdSchemaSql,
  seedCrossTenantLinksSql,
  sql87Text,
} from './helpers/claim-id-assign-case-sql-pg.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-16T12:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const KEY = 'sql88';
const CHOICE = 'sql88-claim-id-assign-case-tenant-scope';
const FN = 'public.tg_claim_id_assign_case()';
const HELPER = 'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)';
const INTENDED = '15fbe8f5f4598ee65b24599fa7396e4e03e75daa163f5cedcc8227aa560b1d2e';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const API_ROLES = ['authenticated', 'anon', 'service_role', 'checksops'];
const ZERO_COUNTS = Object.freeze(Object.fromEntries(Object.keys(SEEDED_CROSS_TENANT_COUNTS).map((key) => [key, 0])));

const { module: executorModule } = await importGuardedSqlExecutor();
const {
  createHandler, parseMortgageSql, mortgageReviewedFunctiondefs, mortgageSqlIsReviewed, MORTGAGE_OUTSIDE_SHA256, CROSS_TENANT_LINK_COUNTS,
} = executorModule;

const FILE = path.join(ROOT, PIN.filename);
const TEXT = fs.readFileSync(FILE, 'utf8');
const DEFS = mortgageReviewedFunctiondefs(KEY, TEXT);
// PG tests use a copy of the pin carrying the pre-state they inspected.
const recordedPin = (expected) => Object.freeze({ ...PIN, expected_live_definition_sha256: expected });

function claimEvent(overrides = {}) {
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
const inspectEvent = (overrides = {}) => claimEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL, ...overrides });

function handlerFor(connect, extra = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql88-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile88: FILE, ...extra });
}
const neverConnect = async () => { throw new Error('should-not-connect'); };
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK TO)\b/i;

test('the pin matches the SQL file and its commit; no staging pre-state yet; the post-state is code-derived; registered everywhere', () => {
  assert.equal(PIN.source_sha256, '57216e00aa0faba83a663d33531896b1782a5a56636d924b79ff06b1923cb316');
  assert.equal(sha(fs.readFileSync(FILE)), PIN.source_sha256);
  assert.equal(PIN.migration_id, '88_claim_id_assign_case_tenant_scope');
  assert.equal(PIN.migration, KEY);
  assert.equal(PIN.commit, '6e903be3bfefbad9ac7f28fc024ebc0875e38c06');
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
  if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), PIN.source_sha256);
  assert.equal(PIN.expected_live_definition_sha256, '57ba25f2ea69adb1a6de030cb42034d4dd1e1c0741a48a96e79afe6d90aae387', 'read-live run 88');
  assert.notEqual(PIN.expected_live_definition_sha256, PIN.intended_replacement_sha256);
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
  // A read-live package evaluates; an apply package needs a recorded pre-state the handler checks.
  assert.equal(evaluateSqlExecutorAuthorization(inspectEvent(), { now: Date.parse(NOW) }).ok, true);
  assert.equal(evaluateSqlExecutorAuthorization(claimEvent({ pin: recordedPin('a'.repeat(64)) }), { now: Date.parse(NOW) }).ok, true);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  const migrationInput = workflow.slice(workflow.indexOf('      migration:'), workflow.indexOf('      approved_commit:'));
  const options = [...migrationInput.matchAll(/^\s+- ([a-z0-9-]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(options, Object.keys(MIGRATIONS));
  assert.ok(options.includes(CHOICE));
  assert.match(workflow, /node --test aws\/tests\/sql88-claim-id-assign-case-executor\.test\.mjs/);
  // The fingerprint is catalog only: the cross-tenant counts are never part of it.
  assert.doesNotMatch(mortgageStateText(KEY, mortgageAppliedStates(KEY)), /cross|count/i);
});

test('the file: same signature and return type, SECURITY DEFINER, search_path=public, revokes before the owner grant, 55000 guards before the body, no BEGIN/COMMIT, no table or data change', () => {
  const parsed = parseMortgageSql(KEY, TEXT);
  const outside = parsed.outside;
  assert.match(TEXT, /CREATE OR REPLACE FUNCTION public\.tg_claim_id_assign_case\(\)\nRETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public\nAS \$\$/);
  // The original declaration, as Supabase migration 20260826125804 has it.
  assert.match(caseMigration(), /CREATE OR REPLACE FUNCTION public\.tg_claim_id_assign_case\(\)\nRETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public/);
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im);
  assert.doesNotMatch(outside, /\b(ALTER TABLE|CREATE TABLE|DROP|TRUNCATE|INSERT INTO|UPDATE public|DELETE FROM|CREATE TRIGGER|CREATE POLICY|ALTER POLICY)\b/i);
  const create = code.indexOf('CREATE OR REPLACE FUNCTION public.tg_claim_id_assign_case(');
  const lastRaise = code.lastIndexOf('RAISE EXCEPTION');
  assert.ok(lastRaise > 0 && lastRaise < create, 'no guard after the CREATE OR REPLACE');
  assert.equal(code.slice(0, create).includes('REVOKE'), false, 'no ACL change before the new body');
  const tail = code.slice(code.indexOf('$$;', code.indexOf('AS $$', create) + 5) + 3);
  assert.doesNotMatch(tail, /RAISE|IF |CREATE|ALTER|DROP/);
  const revokePublic = tail.indexOf('REVOKE ALL ON FUNCTION public.tg_claim_id_assign_case() FROM PUBLIC;');
  const grant = tail.indexOf("EXECUTE format('GRANT EXECUTE ON FUNCTION public.tg_claim_id_assign_case() TO %I', v_owner);");
  assert.ok(revokePublic > 0 && grant > revokePublic);
  assert.equal((code.match(/GRANT EXECUTE/g) || []).length, 1, 'one grant, to the owner');
  assert.match(tail, /ARRAY\['anon', 'authenticated', 'service_role', 'checksops'\] LOOP/);
  assert.match(code, /'sql88_prerequisite_missing:[^']*'[\s\S]*?USING ERRCODE = '55000'/);
  assert.equal((code.match(/RAISE EXCEPTION 'claim_case_owner_unsafe:/g) || []).length, 4);
  assert.equal((code.match(/RAISE EXCEPTION 'claim_case_callers_unsafe:/g) || []).length, 1);
  assert.equal((code.match(/USING ERRCODE = '55000'/g) || []).length, 6);
  // The body never raises, reads no auth.uid(), and does not call the SQL 87 helper (whose
  // case_callers_unsafe guard scans every function body for its name).
  const body = parsed.bodies[0];
  assert.doesNotMatch(body, /RAISE|auth\.uid\(\)|resolve_check_case|INSERT|UPDATE|DELETE/);
  assert.match(body, /AND \(NOT v_has_tenant OR cc\.tenant_id = v_tenant\)/);
  assert.match(body, /WHERE ci\.claim_id = c\.id AND ci\.tenant_id = cc\.tenant_id\)\)\)/);
  // Only NEW.case_id is assigned: no other column, no other table.
  assert.deepEqual([...body.matchAll(/NEW\.([a-z_]+)\s*(:=|INTO)/g)].map((m) => m[1]), []);
  assert.deepEqual([...body.matchAll(/INTO (NEW\.[a-z_]+)/g)].map((m) => m[1]), ['NEW.case_id']);
});

test('the reviewed-text check refuses a wider grant, a missing revoke, a dropped tenant or claim rule, a weaker guard, extra statements and a changed body', () => {
  const cases = [
    ['security invoker', 'LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public\nAS $$', 'LANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path = public\nAS $$'],
    ['search_path widened', 'SECURITY DEFINER\nSET search_path = public\nAS $$', 'SECURITY DEFINER\nSET search_path = public, pg_temp\nAS $$'],
    ['no revoke from PUBLIC', 'REVOKE ALL ON FUNCTION public.tg_claim_id_assign_case() FROM PUBLIC;\n', ''],
    ['authenticated kept', "ARRAY['anon', 'authenticated', 'service_role', 'checksops'] LOOP", "ARRAY['anon', 'service_role', 'checksops'] LOOP"],
    ['grant to authenticated', "TO %I', v_owner);", "TO %I', v_owner);\n  GRANT EXECUTE ON FUNCTION public.tg_claim_id_assign_case() TO authenticated;"],
    ['tenant rule dropped', 'AND (NOT v_has_tenant OR cc.tenant_id = v_tenant)', 'AND true'],
    ['claim rule dropped', '       AND (c.org_id = cc.tenant_id\n', '       AND (true\n'],
    ['org-less rule widened', 'WHERE ci.claim_id = c.id AND ci.tenant_id = cc.tenant_id)))', 'WHERE ci.claim_id = c.id)))'],
    ['owner guard a notice', "    RAISE EXCEPTION 'claim_case_owner_unsafe: tg_claim_id_assign_case owner %", "    RAISE NOTICE 'claim_case_owner_unsafe: tg_claim_id_assign_case owner %"],
    ['secdef guard dropped', '  IF v_fn_secdef IS NOT TRUE OR v_helper_secdef IS NOT TRUE', '  IF false AND v_helper_secdef IS NOT TRUE'],
    ['helper owner not compared', '  IF v_fn_owner IS DISTINCT FROM v_helper_owner\n     OR', '  IF false\n     OR'],
    ['API role in owner allowed', "    IF pg_has_role((SELECT oid FROM pg_roles WHERE rolname = v_role), v_fn_owner, 'MEMBER') THEN", '    IF false THEN'],
    ['callers guard dropped', '  IF v_callers IS NOT NULL THEN', '  IF false THEN'],
    ['callers guard ignores dependents', "       AND d.classid <> 'pg_trigger'::regclass", "       AND false"],
    ['prerequisite check dropped', "  IF v_missing IS NOT NULL THEN\n    RAISE EXCEPTION 'sql88_prerequisite_missing", "  IF false THEN\n    RAISE EXCEPTION 'sql88_prerequisite_missing"],
    ['raise in the body', "    IF v_has_tenant AND v_tenant IS NULL THEN\n      RETURN NEW;", "    IF v_has_tenant AND v_tenant IS NULL THEN\n      RAISE EXCEPTION 'no tenant';"],
    ['table change', 'COMMENT ON FUNCTION public.tg_claim_id_assign_case', 'ALTER TABLE public.check_cases DISABLE ROW LEVEL SECURITY;\nCOMMENT ON FUNCTION public.tg_claim_id_assign_case'],
    ['transaction control', 'DO $$\nDECLARE\n  v_missing text[];', 'BEGIN;\nDO $$\nDECLARE\n  v_missing text[];'],
  ];
  for (const [label, from, to] of cases) {
    const text = TEXT.replace(from, to);
    assert.notEqual(text, TEXT, label);
    assert.equal(mortgageSqlIsReviewed(KEY, text), false, label);
  }
  assert.equal(mortgageSqlIsReviewed(KEY, `${TEXT}\nDO $$ BEGIN END $$;\n`), false, 'trailing DO');
  assert.equal(mortgageSqlIsReviewed(KEY, caseMigration()), false, 'the original migration');
  assert.equal(mortgageSqlIsReviewed('sql87', TEXT), false);
  assert.equal(mortgageSqlIsReviewed(KEY, sql87Text()), false);
  assert.equal(mortgageSqlIsReviewed(KEY, TEXT.replace('-- Idempotent: safe to run more than once.', '-- (reworded)')), true, 'comments alone do not matter');
});

test('apply refuses before connecting: a pin with no pre-state, the read-live sentinel, a wrong hash, a forged pin, a tampered file', async () => {
  const unrecorded = recordedPin(null);
  const pending = await handlerFor(neverConnect, { sql88Pin: unrecorded })(claimEvent({ pin: unrecorded, expected_live_definition_sha256: 'b'.repeat(64) }));
  assert.equal(pending.code, CODES.SQL_COLLISION);
  assert.match(pending.message, /no reviewed pre-apply live definition hash/);
  const recorded = recordedPin('a'.repeat(64));
  const extra = { sql88Pin: recorded };
  for (const expected of [READ_LIVE_EXPECTED_SENTINEL, 'b'.repeat(64)]) {
    const result = await handlerFor(neverConnect, extra)(claimEvent({ pin: recorded, expected_live_definition_sha256: expected }));
    assert.equal(result.code, CODES.SQL_COLLISION);
    assert.match(result.message, /bound to the exact allowlisted pin/);
  }
  assert.equal((await handlerFor(neverConnect, extra)(claimEvent({ pin: recorded, intended_replacement_sha256: 'c'.repeat(64) }))).ok, false);
  for (const forged of [
    { ...recorded, intended_replacement_sha256: 'c'.repeat(64) },
    { ...recorded, function_identities: [...recorded.function_identities, HELPER] },
    { ...recorded, commit: 'f'.repeat(40) },
  ]) {
    const result = await handlerFor(neverConnect, { sql88Pin: forged })(claimEvent({ pin: recorded }));
    assert.equal(result.code, CODES.SQL_COLLISION);
    assert.match(result.message, /committed allowlist entry/);
  }
  assert.equal((await handlerFor(neverConnect, extra)(claimEvent({ pin: recorded, action: 'drop' }))).ok, false);
  const tampered = path.join(os.tmpdir(), `sql88-tampered-${process.pid}.sql`);
  fs.writeFileSync(tampered, `${TEXT}GRANT EXECUTE ON FUNCTION ${FN} TO authenticated;\n`);
  try {
    const result = await handlerFor(neverConnect, { ...extra, sqlFile88: tampered })(claimEvent({ pin: recorded }));
    assert.equal(result.code, CODES.SQL_COLLISION);
  } finally {
    fs.rmSync(tampered, { force: true });
  }
});

test('nothing calls the trigger function directly: it is only a trigger, and it never called the SQL 87 helper', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  for (const file of [...walk(path.join(ROOT, 'aws/functions')), ...walk(path.join(ROOT, 'src'))].filter((f) => /\.(mjs|js|ts|tsx)$/.test(f))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /tg_claim_id_assign_case/, file);
  }
  const original = caseMigration();
  const start = original.indexOf('CREATE OR REPLACE FUNCTION public.tg_claim_id_assign_case()');
  const originalBody = original.slice(start, original.indexOf('$$;', original.indexOf('AS $$', start) + 5));
  assert.doesNotMatch(originalBody, /resolve_check_case/);
  assert.equal((original.match(/EXECUTE FUNCTION public\.tg_claim_id_assign_case\(\)/g) || []).length, 6);
  // The six report entries are exactly the migration's triggers.
  const triggers = [...original.matchAll(/CREATE TRIGGER (\w+)\n\s+BEFORE INSERT OR UPDATE OF claim_id ON public\.(\w+)\n\s+FOR EACH ROW EXECUTE FUNCTION public\.tg_claim_id_assign_case\(\);/g)].map((m) => m[2]).sort();
  assert.deepEqual(triggers, CLAIM_ID_TABLES.map(({ table }) => table).sort());
  // The count categories: the five SQL 87-era link kinds plus one per trigger table.
  assert.deepEqual(CROSS_TENANT_LINK_COUNTS.map((row) => row.key), Object.keys(SEEDED_CROSS_TENANT_COUNTS));
  for (const row of CROSS_TENANT_LINK_COUNTS) {
    assert.match(row.sql, /^SELECT count\(\*\)::int AS n\n/, row.key);
    assert.doesNotMatch(row.sql, /\b(INSERT|UPDATE|DELETE|array_agg|string_agg|json)\b/i, row.key);
  }
});

// --- PostgreSQL 16 ---------------------------------------------------------------

const OWNER = 'claim_case_login';
const CLAIM_BX = '00000000-0000-4000-8000-00000000c0b2';

async function claimFixture(pg, prefix, port, { withSql87 = false } = {}) {
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
      await owner.query(claimIdSchemaSql({ withSql87 }));
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

async function crossTenantCounts(owner) {
  const out = {};
  for (const row of CROSS_TENANT_LINK_COUNTS) out[row.key] = (await owner.query(row.sql)).rows[0].n;
  return out;
}

/**
 * Runs the six triggers as checksops with no request.app_user_id (as partner ingestion
 * does) on a clean slate and reports what they linked. Every finding is true for SQL 88.
 */
async function claimScenarios(owner, api) {
  await owner.query(CLEAR_ROWS_SQL);
  assert.equal((await api.query("SELECT current_setting('request.app_user_id', true) AS v")).rows[0].v ?? null, null);
  // Cases: A's for claim A and B's for claim B (made by the check intake trigger); B's
  // freedom_crm case for an org-less claim only A's checks reference (the old helper could
  // make it); B's case for its own org-less claim.
  const caseA = (await api.query('INSERT INTO public.check_intake_items (tenant_id, claim_id) VALUES ($1, $2) RETURNING case_id', [TENANT_A, CLAIM_A])).rows[0].case_id;
  const caseB = (await api.query('INSERT INTO public.check_intake_items (tenant_id, claim_id) VALUES ($1, $2) RETURNING case_id', [TENANT_B, CLAIM_B])).rows[0].case_id;
  const local = (await owner.query("INSERT INTO public.check_cases (tenant_id, external_system, claim_number) VALUES ($1, 'checksops', 'A-LOCAL') RETURNING id", [TENANT_A])).rows[0].id;
  const orglessB = (await owner.query("INSERT INTO public.check_cases (tenant_id, external_system, external_claim_id) VALUES ($1, 'freedom_crm', $2) RETURNING id", [TENANT_B, CLAIM_ORGLESS])).rows[0].id;
  await owner.query('INSERT INTO public.check_intake_items (tenant_id, claim_id, case_id) VALUES ($1, $2, $3)', [TENANT_A, CLAIM_ORGLESS, local]);
  const ownOrglessB = (await owner.query("INSERT INTO public.check_cases (tenant_id, external_system, external_claim_id) VALUES ($1, 'freedom_crm', $2) RETURNING id", [TENANT_B, CLAIM_ORGLESS_B])).rows[0].id;
  await owner.query('INSERT INTO public.check_intake_items (tenant_id, claim_id, case_id) VALUES ($1, $2, $3)', [TENANT_B, CLAIM_ORGLESS_B, ownOrglessB]);
  // A's freedom_crm case for a claim of B's org (the original helper made such cases).
  await owner.query("INSERT INTO public.claims (id, org_id, claim_number, policyholder_name) VALUES ($1, $2, 'CLM-BX', 'Bea Foreign') ON CONFLICT (id) DO NOTHING", [CLAIM_BX, TENANT_B]);
  const aCaseForB = (await owner.query("INSERT INTO public.check_cases (tenant_id, external_system, external_claim_id) VALUES ($1, 'freedom_crm', $2) RETURNING id", [TENANT_A, CLAIM_BX])).rows[0].id;
  const casesBefore = (await owner.query('SELECT count(*)::int AS n FROM public.check_cases')).rows[0].n;

  const insert = async (table, values) => {
    const cols = Object.keys(values);
    return (await api.query(
      `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(values),
    )).rows[0];
  };
  const f = {
    case_fixture_ok: Boolean(caseA && caseB && caseA !== caseB),
    ledger_own_links: true,
    ledger_foreign_claim_unlinked: true,
    ledger_other_tenant_links_its_own: true,
    ledger_orgless_own_links: true,
    tenantless_own_links: true,
    tenantless_foreign_case_unlinked: true,
    tenantless_orgless_own_links: true,
    foreign_claim_in_own_case_unlinked: Boolean(aCaseForB),
    update_claim_id_links: true,
    update_foreign_claim_unlinked: true,
    preset_case_kept: true,
    only_case_id_set: true,
  };
  for (const { table, tenant } of CLAIM_ID_TABLES) {
    const row = (claim, t = TENANT_A, extra = {}) => insert(table, { ...(tenant ? { tenant_id: t } : {}), claim_id: claim, note: `n-${table}`, ...extra });
    if (tenant) {
      f.ledger_own_links &&= (await row(CLAIM_A)).case_id === caseA;
      f.ledger_foreign_claim_unlinked &&= (await row(CLAIM_B)).case_id === null;
      f.ledger_other_tenant_links_its_own &&= (await row(CLAIM_B, TENANT_B)).case_id === caseB;
      // B's org-less claim, referenced by a B check: B's row links, A's does not.
      f.ledger_orgless_own_links &&= (await row(CLAIM_ORGLESS_B, TENANT_B)).case_id === ownOrglessB
        && (await row(CLAIM_ORGLESS_B, TENANT_A)).case_id === null;
      // B's case for an org-less claim only A's checks reference: neither A's nor B's row links.
      f.tenantless_foreign_case_unlinked &&= (await row(CLAIM_ORGLESS, TENANT_A)).case_id === null
        && (await row(CLAIM_ORGLESS, TENANT_B)).case_id === null;
      // A's own case, but the claim is B's: A's row links nothing.
      f.foreign_claim_in_own_case_unlinked &&= (await row(CLAIM_BX, TENANT_A)).case_id === null;
    } else {
      f.tenantless_own_links &&= (await row(CLAIM_A)).case_id === caseA && (await row(CLAIM_B)).case_id === caseB;
      f.tenantless_foreign_case_unlinked &&= (await row(CLAIM_ORGLESS)).case_id === null;
      f.tenantless_orgless_own_links &&= (await row(CLAIM_ORGLESS_B)).case_id === ownOrglessB;
      f.foreign_claim_in_own_case_unlinked &&= (await row(CLAIM_BX)).case_id === null;
    }
    // UPDATE OF claim_id on a row with no case.
    const bare = await row(null);
    const upd = (await api.query(`UPDATE public.${table} SET claim_id = $2 WHERE id = $1 RETURNING case_id`, [bare.id, CLAIM_A])).rows[0];
    f.update_claim_id_links &&= bare.case_id === null && upd.case_id === caseA;
    const bare2 = await row(null);
    const updForeign = (await api.query(`UPDATE public.${table} SET claim_id = $2 WHERE id = $1 RETURNING case_id`, [bare2.id, tenant ? CLAIM_B : CLAIM_ORGLESS])).rows[0];
    f.update_foreign_claim_unlinked &&= updForeign.case_id === null;
    // A case set by the writer is left alone (the trigger would otherwise pick caseA).
    f.preset_case_kept &&= (await row(CLAIM_A, TENANT_A, { case_id: local })).case_id === local;
    // Nothing but case_id changes: the row's other columns are as written.
    const check = await row(CLAIM_A);
    f.only_case_id_set &&= check.note === `n-${table}` && check.claim_id === CLAIM_A && (!tenant || check.tenant_id === TENANT_A);
  }
  // A table with a nullable tenant_id: a row without a tenant links nothing.
  await owner.query(`CREATE TABLE public.sql88_probe (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, claim_id uuid, case_id uuid);
    GRANT SELECT, INSERT ON public.sql88_probe TO checksops;
    CREATE TRIGGER sql88_probe_assign BEFORE INSERT ON public.sql88_probe FOR EACH ROW EXECUTE FUNCTION public.tg_claim_id_assign_case();`);
  f.null_tenant_unlinked = (await insert('sql88_probe', { tenant_id: null, claim_id: CLAIM_A })).case_id === null
    && (await insert('sql88_probe', { tenant_id: TENANT_A, claim_id: CLAIM_A })).case_id === caseA;
  await owner.query('DROP TABLE public.sql88_probe');

  // The trigger creates no case and copies no claim data into any case.
  f.no_case_created = (await owner.query('SELECT count(*)::int AS n FROM public.check_cases')).rows[0].n === casesBefore;
  const aCases = (await owner.query('SELECT * FROM public.check_cases WHERE tenant_id = $1', [TENANT_A])).rows;
  f.no_tenant_b_data_in_tenant_a = aCases.every((row) => !TENANT_B_PII.some((pii) => JSON.stringify(row).includes(pii)));
  // Across the six tables: no row linked to a case of another tenant or for a claim outside it.
  const counts = await crossTenantCounts(owner);
  f.no_cross_tenant_links = CLAIM_ID_TABLES.every(({ table }) => counts[`${table}_case`] === 0);

  // EXECUTE: only the owner; calling it directly as an API role is 42501.
  const priv = (await owner.query(`SELECT r, has_function_privilege(r, $1, 'EXECUTE') AS can
    FROM unnest(ARRAY['authenticated', 'anon', 'service_role', 'checksops', current_user::text]) r`, [FN])).rows;
  f.api_roles_cannot_execute = priv.filter((row) => row.r !== OWNER).every((row) => row.can === false);
  f.owner_can_execute = priv.find((row) => row.r === OWNER)?.can === true;
  return f;
}

const BUG_FINDINGS = ['ledger_foreign_claim_unlinked', 'tenantless_foreign_case_unlinked', 'foreign_claim_in_own_case_unlinked', 'update_foreign_claim_unlinked', 'no_cross_tenant_links'];

async function directCallRefused(admin, api) {
  for (const role of ['authenticated', 'anon', 'service_role']) {
    await admin.query(`SET ROLE ${role}`);
    await assert.rejects(admin.query('SELECT public.tg_claim_id_assign_case()'), (error) => error.code === '42501', role);
    await admin.query('RESET ROLE');
  }
  await assert.rejects(api.query('SELECT public.tg_claim_id_assign_case()'), (error) => error.code === '42501', 'checksops');
}

for (const withSql87 of [false, true]) {
  const label = withSql87 ? 'after SQL 87' : 'without SQL 87';
  test(`PostgreSQL 16 (${label}): inspect is read-only, counts only and prints no PII or ids; SQL 88 lands once on the code-derived hash; the triggers keep working and stay in their tenant`, { timeout: 240000 }, async (t) => {
    const pg = await loadPg(t);
    if (!pg) return;
    const { server, admin, connectAs } = await claimFixture(pg, `pg-sql88-exec-${withSql87 ? 'b' : 'a'}-`, withSql87 ? 59300 : 59200, { withSql87 });
    try {
      const seen = [];
      const connect = async () => {
        const client = await connectAs(OWNER);
        const query = client.query.bind(client);
        client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
        return client;
      };
      const owner = await connectAs(OWNER);
      const api = await connectAs('checksops');
      try {
        // The original body leaks across tenants (the bug), as partner ingestion runs it.
        const bug = await claimScenarios(owner, api);
        for (const name of BUG_FINDINGS) assert.equal(bug[name], false, `${name} under the original body`);
        assert.equal(bug.ledger_own_links, true);
        await owner.query(CLEAR_ROWS_SQL);

        const before = await handlerFor(connect)(inspectEvent());
        assert.equal(before.ok, true, JSON.stringify(before));
        const receipt = before.details.receipt;
        assert.equal(seen[0], 'BEGIN READ ONLY');
        assert.equal(seen.at(-1), 'ROLLBACK');
        assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
        const report = receipt.mortgage_inspect;
        assert.deepEqual(receipt.precondition_failures, [], JSON.stringify(report));
        assert.equal(receipt.pin_executable, true);
        // The fixture's catalog is not staging's recorded pre-state.
        assert.notEqual(receipt.live_definition_sha256, PIN.expected_live_definition_sha256);
        assert.equal(receipt.apply_preconditions_met, false);
        assert.equal(receipt.sql47_prerequisites_present, true);
        assert.notEqual(receipt.live_definition_sha256, INTENDED);
        // Clean fixture: every count is 0, shown at the top of the receipt and in the report.
        const clean = { readable: true, total: 0, categories: ZERO_COUNTS, unreadable_categories: [] };
        assert.deepEqual(receipt.cross_tenant_links, clean);
        assert.deepEqual(report.cross_tenant_links, clean);
        assert.equal(report.functions.tg_claim_id_assign_case.state, 'case_original');
        assert.equal(report.functions.tg_claim_id_assign_case.definition_sha256, MORTGAGE_KNOWN_DEFINITION_SHA256[FN].case_original);
        assert.equal(report.functions.tg_claim_id_assign_case.body_matches_migration, false);
        assert.deepEqual(report.functions.tg_claim_id_assign_case.acl_entries, [], '20260826125833 revoked PUBLIC');
        assert.equal(report.functions.resolve_check_case.state, withSql87 ? 'tenant_scoped' : 'case_original');
        for (const name of ['resolve_check_case', 'tg_check_intake_assign_case', 'tg_loss_draft_assign_case']) {
          assert.equal(report.functions[name].security_definer, true, name);
        }
        assert.deepEqual(report.case_owner, {
          trigger_function_present: true,
          case_functions_present: true,
          same_owner: true,
          all_security_definer: true,
          owner_is_api_role: false,
          owner_rolsuper: false,
          api_role_member_of_owner: false,
          api_roles_member_of_owner: [],
          api_roles_present: ['anon', 'authenticated', 'checksops', 'service_role'],
          case_owner_safe: true,
        });
        assert.deepEqual(report.other_callers, {
          function_count: 0, functions: [], view_or_rule_count: 0, views_or_rules: [], policy_count: 0, policies: [],
          dependent_function_count: 0, dependent_functions: [], other_dependent_count: 0, other_dependents: [], trigger_count: 6, total: 0,
        });
        assert.deepEqual(Object.keys(report.claim_triggers), ['assign_case_on_ledger_events', 'assign_case_on_ledger_tokens', 'assign_case_on_ledger_uploads', 'assign_case_on_mortgage_releases', 'assign_case_on_mortgage_draws', 'assign_case_on_signature_requests']);
        assert.ok(Object.values(report.claim_triggers).every((row) => row.present && row.enabled && row.calls_function), JSON.stringify(report.claim_triggers));
        assert.deepEqual(report.missing_columns, {});
        assertNoSeededPii(assert, before, 'executor result');
        assert.doesNotMatch(JSON.stringify(report), UUID_RE);
        assert.equal(JSON.stringify(report).includes(OWNER), false);
        const summary = readLiveSummary({ ok: true, details: before }, { migration: CHOICE, pin: PIN });
        assert.equal(summary.ok, true, JSON.stringify(summary));
        assert.deepEqual(summary.details.cross_tenant_links, clean);
        const expectedSummary = JSON.parse(JSON.stringify(report));
        expectedSummary.functions.resolve_check_case.arguments = 'unrecognized';
        assert.deepEqual(summary.details.mortgage_inspect, expectedSummary);

        // Seeded fixture: the counts are exact; still no ids; the fingerprint is unchanged.
        await owner.query(seedCrossTenantLinksSql());
        assert.deepEqual(await crossTenantCounts(owner), SEEDED_CROSS_TENANT_COUNTS);
        const seeded = (await handlerFor(connect)(inspectEvent())).details.receipt;
        assert.deepEqual(seeded.cross_tenant_links, { readable: true, total: SEEDED_CROSS_TENANT_TOTAL, categories: SEEDED_CROSS_TENANT_COUNTS, unreadable_categories: [] });
        assert.equal(seeded.live_definition_sha256, receipt.live_definition_sha256, 'counts are not part of the fingerprint');
        assert.deepEqual(seeded.precondition_failures, [], 'counts never block');
        assert.doesNotMatch(JSON.stringify(seeded), UUID_RE);
        const seededSummary = readLiveSummary({ ok: true, details: { ok: true, details: { receipt: seeded } } }, { migration: CHOICE, pin: PIN });
        assert.equal(seededSummary.details.cross_tenant_links.total, SEEDED_CROSS_TENANT_TOTAL);
        assert.doesNotMatch(JSON.stringify(seededSummary), UUID_RE);

        // Apply with the recorded pre-state, over the seeded rows: they are not touched.
        const recorded = recordedPin(receipt.live_definition_sha256);
        const handler = handlerFor(connect, { sql88Pin: recorded });
        assert.equal((await handler(inspectEvent({ pin: recorded }))).details.receipt.apply_preconditions_met, true);
        const event = claimEvent({ pin: recorded });
        const applied = await handler(event);
        assert.equal(applied.ok, true, JSON.stringify(applied));
        assert.equal(applied.details.receipt.before_hash, receipt.live_definition_sha256);
        assert.equal(applied.details.receipt.after_hash, INTENDED);
        assert.deepEqual(await crossTenantCounts(owner), SEEDED_CROSS_TENANT_COUNTS, 'no data change');
        const after = (await handler(inspectEvent({ pin: recorded }))).details.receipt;
        assert.equal(after.live_definition_sha256, INTENDED);
        assert.equal(after.already_applied, true);
        assert.equal(after.apply_preconditions_met, false);
        assert.equal(after.mortgage_inspect.functions.tg_claim_id_assign_case.state, 'intended');
        assert.equal(after.mortgage_inspect.functions.tg_claim_id_assign_case.matches_migration, true);
        assert.equal(after.mortgage_inspect.functions.tg_claim_id_assign_case.body_matches_migration, true);
        assert.deepEqual(after.mortgage_inspect.functions.tg_claim_id_assign_case.acl_entries, []);
        await admin.query("SELECT set_config('search_path', 'pg_catalog', false)");
        const row = (await admin.query(`SELECT encode(sha256(convert_to(pg_get_functiondef($1::regprocedure), 'UTF8')), 'hex') AS def_sha,
          pg_get_userbyid(proowner) AS owner, proacl::text AS acl, prosecdef, proconfig::text AS config,
          pg_get_function_result(oid) AS result, provolatile::text AS volatility
          FROM pg_proc WHERE oid = $1::regprocedure`, [FN])).rows[0];
        assert.deepEqual(row, {
          def_sha: MORTGAGE_DEFINITION_SHA256[FN],
          owner: OWNER,
          acl: `{${OWNER}=X/${OWNER}}`,
          prosecdef: true,
          config: '{search_path=public}',
          result: 'trigger',
          volatility: 'v',
        });
        await admin.query("SELECT set_config('search_path', '\"$user\", public', false)");
        assert.equal((await handler(event)).code, CODES.SQL_COLLISION, 'replay');
        const reapply = await handler(claimEvent({ pin: recorded }));
        assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
        assert.match(reapply.message, /already in place/);

        const fixed = await claimScenarios(owner, api);
        for (const [name, value] of Object.entries(fixed)) assert.equal(value, true, `${name}: ${JSON.stringify(fixed)}`);
        await directCallRefused(admin, api);
        // Running the file again is a no-op (idempotent) and still lands on the same state.
        await owner.query(TEXT);
        assert.equal((await handler(inspectEvent({ pin: recorded }))).details.receipt.live_definition_sha256, INTENDED);
        // SQL 87 applies (or re-applies) on top: SQL 88's body does not trip its callers guard.
        await owner.query(sql87Text());
        await owner.query(sql87Text());
        assert.equal((await handler(inspectEvent({ pin: recorded }))).details.receipt.live_definition_sha256, INTENDED);
        const again = await claimScenarios(owner, api);
        assert.deepEqual(Object.entries(again).filter(([, value]) => value !== true), []);
      } finally {
        await api.end();
        await owner.end();
      }
    } finally {
      await admin.end();
      server.stop();
    }
  });
}

test('PostgreSQL 16: behavioural mutants of SQL 88 are caught by the trigger scenarios', { timeout: 240000 }, async (t) => {
  const pg = await loadPg(t);
  if (!pg) return;
  const { server, admin, connectAs } = await claimFixture(pg, 'pg-sql88-mut-', 59400);
  const owner = await connectAs(OWNER);
  const api = await connectAs('checksops');
  // Every API role holds EXECUTE before each run, so a weaker revoke shows.
  const reset = `GRANT EXECUTE ON FUNCTION ${FN} TO PUBLIC, anon, authenticated, service_role, checksops`;
  try {
    const mutants = [
      ['tenant rule dropped', 'AND (NOT v_has_tenant OR cc.tenant_id = v_tenant)', 'AND true', ['ledger_foreign_claim_unlinked', 'no_cross_tenant_links']],
      ['claim rule dropped', '       AND (c.org_id = cc.tenant_id\n', '       AND (true\n', ['tenantless_foreign_case_unlinked', 'foreign_claim_in_own_case_unlinked', 'no_cross_tenant_links']],
      ['org-less rule ignores the tenant', 'WHERE ci.claim_id = c.id AND ci.tenant_id = cc.tenant_id)))', 'WHERE ci.claim_id = c.id)))', ['tenantless_foreign_case_unlinked']],
      ['org rule ignores the tenant', '       AND (c.org_id = cc.tenant_id\n', '       AND (c.org_id IS NOT NULL\n', ['foreign_claim_in_own_case_unlinked']],
      ['tenant read from the wrong key', "v_row ? 'tenant_id'", "v_row ? 'org_id'", ['ledger_foreign_claim_unlinked']],
      ['authenticated keeps EXECUTE', "ARRAY['anon', 'authenticated', 'service_role', 'checksops'] LOOP", "ARRAY['anon', 'service_role', 'checksops'] LOOP", ['api_roles_cannot_execute']],
      ['PUBLIC keeps EXECUTE', 'REVOKE ALL ON FUNCTION public.tg_claim_id_assign_case() FROM PUBLIC;\n', '', ['api_roles_cannot_execute']],
    ];
    for (const [label, from, to, expected] of mutants) {
      const text = TEXT.replace(from, to);
      assert.notEqual(text, TEXT, label);
      assert.equal(mortgageSqlIsReviewed(KEY, text), false, `${label} is not the reviewed text`);
      await owner.query(reset);
      await owner.query(text);
      const findings = await claimScenarios(owner, api);
      const failed = Object.entries(findings).filter(([, value]) => value !== true).map(([name]) => name);
      for (const name of expected) assert.ok(failed.includes(name), `${label}: expected ${name} to fail, failed ${JSON.stringify(failed)}`);
    }
    // The original body is caught too.
    const original = caseMigration();
    const start = original.indexOf('CREATE OR REPLACE FUNCTION public.tg_claim_id_assign_case()');
    await owner.query(original.slice(start, original.indexOf('$$;', original.indexOf('AS $$', start) + 5) + 3));
    const bug = await claimScenarios(owner, api);
    for (const name of BUG_FINDINGS) assert.equal(bug[name], false, name);
    await owner.query(reset);
    await owner.query(TEXT);
    const fixed = await claimScenarios(owner, api);
    assert.deepEqual(Object.entries(fixed).filter(([, value]) => value !== true), []);
  } finally {
    await api.end();
    await owner.end();
    await admin.end();
    server.stop();
  }
});

test('PostgreSQL 16: an owner that differs from the case helper or triggers, a non-SECURITY DEFINER case function, an API role in the owner, another caller, an extra grant, another signature and a missing prerequisite fail closed; triggers on other tables are allowed; drift and collateral changes roll back', { timeout: 240000 }, async (t) => {
  const pg = await loadPg(t);
  if (!pg) return;
  const { server, admin, connectAs } = await claimFixture(pg, 'pg-sql88-clash-', 59500, { withSql87: true });
  try {
    const connect = () => connectAs(OWNER);
    const owner = await connectAs(OWNER);
    const inspect = async (pin = PIN) => (await handlerFor(connect, { sql88Pin: pin })(inspectEvent({ pin }))).details.receipt;
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
      assert.doesNotMatch(JSON.stringify(receipt.mortgage_inspect), UUID_RE, `${label}: no ids`);
      const recorded = recordedPin(receipt.live_definition_sha256);
      const refused = await handlerFor(connect, { sql88Pin: recorded })(claimEvent({ pin: recorded }));
      assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(refused)}`);
      if (file) await fileRefuses(file, admin);
      await as.query(restore);
      assert.deepEqual((await inspect()).precondition_failures, [], `${label} restored`);
    };
    assert.deepEqual((await inspect()).precondition_failures, []);

    await refusedThenRestored('the trigger function is not SECURITY DEFINER',
      `ALTER FUNCTION ${FN} SECURITY INVOKER`, `ALTER FUNCTION ${FN} SECURITY DEFINER`,
      ['case_owner_safe'], { file: /claim_case_owner_unsafe: .*must all be SECURITY DEFINER/ });
    await refusedThenRestored('the case helper is not SECURITY DEFINER',
      `ALTER FUNCTION ${HELPER} SECURITY INVOKER`, `ALTER FUNCTION ${HELPER} SECURITY DEFINER`,
      ['case_owner_safe'], { file: /claim_case_owner_unsafe: .*must all be SECURITY DEFINER/ });
    // The SQL 87 helper is owner-EXECUTE only: a different owner would split the case objects.
    await refusedThenRestored('the case helper with another owner',
      `CREATE ROLE migrator NOLOGIN; ALTER FUNCTION ${HELPER} OWNER TO migrator`,
      `ALTER FUNCTION ${HELPER} OWNER TO ${OWNER}; DROP ROLE migrator`,
      ['case_owner_safe'], { as: admin, file: /claim_case_owner_unsafe: tg_claim_id_assign_case \(owner claim_case_login\), resolve_check_case \(owner migrator\)/ });
    await refusedThenRestored('the trigger function with another owner',
      `CREATE ROLE migrator NOLOGIN; ALTER FUNCTION ${FN} OWNER TO migrator`,
      `ALTER FUNCTION ${FN} OWNER TO ${OWNER}; DROP ROLE migrator`,
      ['case_owner_safe', 'owner_is_login:tg_claim_id_assign_case'], { as: admin, file: /claim_case_owner_unsafe: tg_claim_id_assign_case \(owner migrator\)/ });
    await refusedThenRestored('checksops a member of the owner',
      `GRANT ${OWNER} TO checksops`, `REVOKE ${OWNER} FROM checksops`,
      ['case_owner_safe'], { as: admin, file: /claim_case_owner_unsafe: the API role checksops is a member of tg_claim_id_assign_case owner/,
        report: (r) => assert.deepEqual(r.case_owner.api_roles_member_of_owner, ['checksops']) });
    await refusedThenRestored('service_role a member of the owner without INHERIT',
      `GRANT ${OWNER} TO service_role WITH INHERIT FALSE`, `REVOKE ${OWNER} FROM service_role`,
      ['case_owner_safe'], { as: admin, file: /the API role service_role is a member/ });
    const all = [FN, HELPER, 'public.tg_check_intake_assign_case()', 'public.tg_loss_draft_assign_case()'];
    await refusedThenRestored('the owner is an API role',
      all.map((fn) => `ALTER FUNCTION ${fn} OWNER TO authenticated;`).join(' '),
      all.map((fn) => `ALTER FUNCTION ${fn} OWNER TO ${OWNER};`).join(' '),
      ['case_owner_safe'], { as: admin, file: /claim_case_owner_unsafe: tg_claim_id_assign_case owner authenticated is the API role authenticated/ });
    // Other callers refuse (names only in the report); a trigger on another table is allowed.
    await refusedThenRestored('a function that names it',
      `CREATE FUNCTION public.claim_case_probe() RETURNS text LANGUAGE sql AS $f$ SELECT 'tg_claim_id_assign_case'::text $f$`,
      'DROP FUNCTION public.claim_case_probe()',
      ['other_callers_present'], { file: /claim_case_callers_unsafe: .*function (public\.)?claim_case_probe\(\)/,
        report: (r) => assert.deepEqual([r.other_callers.functions, r.other_callers.total], [['public.claim_case_probe()'], 1]) });
    await refusedThenRestored('a SQL-standard function body that depends on it',
      `CREATE FUNCTION public.claim_case_atomic() RETURNS regprocedure LANGUAGE sql BEGIN ATOMIC SELECT 'public.tg_claim_id_assign_case()'::regprocedure; END`,
      'DROP FUNCTION public.claim_case_atomic()',
      ['other_callers_present'], { file: /claim_case_callers_unsafe: .*dependent pg_proc/,
        report: (r) => assert.deepEqual(r.other_callers.dependent_functions, ['public.claim_case_atomic()']) });
    await refusedThenRestored('a view that depends on it',
      `CREATE VIEW public.claim_case_view AS SELECT 'public.tg_claim_id_assign_case()'::regprocedure AS f`,
      'DROP VIEW public.claim_case_view',
      ['other_callers_present'], { file: /claim_case_callers_unsafe: .*dependent pg_rewrite/,
        report: (r) => assert.deepEqual(r.other_callers.views_or_rules, ['public.claim_case_view rule _RETURN']) });
    await owner.query(`CREATE TABLE public.extra_claim_rows (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, case_id uuid);
      CREATE TRIGGER extra_assign BEFORE INSERT ON public.extra_claim_rows FOR EACH ROW EXECUTE FUNCTION ${FN}`);
    const extraTrigger = await inspect();
    assert.deepEqual(extraTrigger.precondition_failures, []);
    assert.equal(extraTrigger.mortgage_inspect.other_callers.trigger_count, 7);
    await owner.query('DROP TABLE public.extra_claim_rows');
    await refusedThenRestored('an EXECUTE grant the file does not revoke',
      `CREATE ROLE reporting NOLOGIN; GRANT EXECUTE ON FUNCTION ${FN} TO reporting`,
      `REVOKE EXECUTE ON FUNCTION ${FN} FROM reporting; DROP ROLE reporting`,
      ['acl_replaceable:tg_claim_id_assign_case'], { as: admin });
    await refusedThenRestored('another signature of tg_claim_id_assign_case',
      'CREATE FUNCTION public.tg_claim_id_assign_case(x int) RETURNS int LANGUAGE sql AS $$ SELECT x $$',
      'DROP FUNCTION public.tg_claim_id_assign_case(int)',
      ['no_other_signature:tg_claim_id_assign_case']);
    // The anon, authenticated, service_role, checksops and PUBLIC grants are all replaceable.
    await owner.query(`GRANT EXECUTE ON FUNCTION ${FN} TO checksops, anon, authenticated, service_role, PUBLIC`);
    assert.deepEqual((await inspect()).precondition_failures, []);

    // A missing prerequisite: 55000 sql88_prerequisite_missing (and the inspect refuses).
    await owner.query('ALTER TABLE public.mortgage_releases RENAME TO mortgage_releases_x');
    const missing = await inspect();
    assert.ok(missing.precondition_failures.includes('sql47_prerequisites_present'), JSON.stringify(missing.precondition_failures));
    assert.equal(missing.cross_tenant_links.categories.mortgage_releases_case, null);
    assert.equal(missing.cross_tenant_links.readable, false);
    assert.deepEqual(missing.cross_tenant_links.unreadable_categories, ['mortgage_releases_case:table_missing']);
    await fileRefuses(/sql88_prerequisite_missing: .*missing public\.mortgage_releases/);
    await owner.query('ALTER TABLE public.mortgage_releases_x RENAME TO mortgage_releases');

    // Drift between the recorded inspect and the apply: DEPLOYMENT_COLLISION, nothing changed.
    const recorded = recordedPin((await inspect()).live_definition_sha256);
    await owner.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM service_role`);
    const collision = await handlerFor(connect, { sql88Pin: recorded })(claimEvent({ pin: recorded }));
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
      ['ALTER TABLE public.signature_requests ADD COLUMN note2 text;', ['columns_sha256']],
      ['DROP TRIGGER assign_case_on_ledger_events ON public.homeowner_ledger_events;', ['triggers_sha256']],
      [`ALTER FUNCTION ${HELPER} SECURITY INVOKER;`, null],
    ]) {
      const result = await handlerFor(wrap(extra), { sql88Pin: recorded })(claimEvent({ pin: recorded }));
      assert.equal(result.code, CODES.UNRELATED_MUTATION, `${extra}: ${JSON.stringify(result)}`);
      if (changed) assert.deepEqual(result.details.unrelated_changed, changed, extra);
      else assert.ok(result.details.failed.includes('case_owner_safe'), JSON.stringify(result.details));
    }
    assert.equal((await inspect()).live_definition_sha256, recorded.expected_live_definition_sha256, 'every refused apply rolled back');

    // Roles that do not exist are skipped (a database without Supabase's service_role).
    await admin.query(`REVOKE ALL ON FUNCTION ${FN} FROM service_role; REVOKE ALL ON FUNCTION ${HELPER} FROM service_role;
      REVOKE ALL ON ${CLAIM_ID_TABLES.map(({ table }) => `public.${table}`).join(', ')} FROM service_role;
      REVOKE USAGE ON SCHEMA public FROM service_role; DROP ROLE service_role`);
    const noServiceRole = await inspect();
    assert.deepEqual(noServiceRole.precondition_failures, []);
    assert.deepEqual(noServiceRole.mortgage_inspect.case_owner.api_roles_present, ['anon', 'authenticated', 'checksops']);
    const ready = recordedPin(noServiceRole.live_definition_sha256);
    const applied = await handlerFor(connect, { sql88Pin: ready })(claimEvent({ pin: ready }));
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, INTENDED, 'the post-state does not depend on which API roles exist');
    await owner.end();
  } finally {
    await admin.end();
    server.stop();
  }
});
