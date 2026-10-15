/**
 * Staging VPC executor support for SQL 80 (CREATE OR REPLACE of the SQL 38
 * SECURITY DEFINER function public.aws_save_checkalt_tenant_auto_deposit(uuid,
 * jsonb) so tenant owner/admin/manager/operator, not viewer, can save the
 * Auto-Deposit settings; its REVOKE/GRANT lines restate SQL 38's grants).
 *
 * Both hashes are code-derived: the pre-apply state is the function SQL 38
 * leaves, the intended state the one SQL 80 leaves (only the definition and
 * the comment differ). The PostgreSQL 16 test below re-derives both from the
 * real catalog with the real SQL 38 and SQL 80 files, then applies through the
 * handler.
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
  AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT as PIN,
  AUTHORIZED_STAGING_SQL,
  CHECKALT_AUTO_DEPOSIT_APPLIED_STATE,
  CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256,
  CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256,
  CHECKALT_AUTO_DEPOSIT_FUNCTION,
  CHECKALT_AUTO_DEPOSIT_PRE_STATE,
  CHECKALT_AUTO_DEPOSIT_SQL38_FILE,
  authorizationFingerprint,
  checkaltAutoDepositStateText,
  evaluateSqlExecutorAuthorization,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL, readLiveSummary } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { applyBaseSchema, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL_FILE = path.join(ROOT, PIN.filename);
const SQL38_FILE = path.join(ROOT, CHECKALT_AUTO_DEPOSIT_SQL38_FILE);
const NOW = '2026-10-15T19:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler, parseSql80, sql80ReviewedFunctiondef, SQL80_NORMALIZED_STATEMENTS } = executorModule;

const SQL38_TEXT = fs.readFileSync(SQL38_FILE, 'utf8');
const SQL80_TEXT = fs.readFileSync(SQL_FILE, 'utf8');
// pg_get_functiondef / obj_description on PostgreSQL 16 (checked against the real catalog below).
const DEF38 = sql80ReviewedFunctiondef(SQL38_TEXT);
const DEF80 = sql80ReviewedFunctiondef(SQL80_TEXT);
const COMMENT38 = parseSql80(SQL38_TEXT).comment;
const COMMENT80 = parseSql80(SQL80_TEXT).comment;

function sql80Event(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql80-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const event = {
    action: 'apply',
    workstream_id: 'staging-sql80-checkalt-member-auto-deposit',
    branch: 'main',
    commit: PIN.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [PIN.filename],
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    intended_replacement_sha256: PIN.intended_replacement_sha256,
    expected_live_definition_sha256: PIN.expected_live_definition_sha256,
    one_use_id: oneUse,
    expiry: '2026-10-15T20:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...overrides,
  };
  event.one_use_id = oneUse;
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}

function handlerFor(connect, extra = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(
    os.tmpdir(),
    `sql80-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile80: SQL_FILE, ...extra });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};

test('pin matches the SQL file and its commit; both hashes are the code-derived SQL 38 and SQL 80 states', () => {
  assert.equal(sha(fs.readFileSync(SQL_FILE)), PIN.source_sha256);
  assert.equal(PIN.source_sha256, '3ca77bf4d3bfe0d09645bec2d8bf86517f60a0804935fe6aff68a61f92747352');
  assert.equal(PIN.expected_live_definition_sha256, sha(checkaltAutoDepositStateText(CHECKALT_AUTO_DEPOSIT_PRE_STATE)));
  assert.equal(PIN.expected_live_definition_sha256, '3ef657f48750ee96813e7d718ffa10314a71f660560dbc20bc41687c79770847');
  assert.equal(PIN.intended_replacement_sha256, sha(checkaltAutoDepositStateText(CHECKALT_AUTO_DEPOSIT_APPLIED_STATE)));
  assert.equal(PIN.intended_replacement_sha256, '5ad9a81cfc01ba8affc165b42986c1a6e7ce87c5f61df6a5ebcac293e00fa0db');
  assert.equal(PIN.function_identity, 'public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb)');
  // The definition and comment hashes are those of the real SQL 38 and SQL 80 files.
  assert.equal(sha(DEF38), CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql38);
  assert.equal(sha(DEF80), CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80);
  assert.equal(sha(COMMENT38), CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256.sql38);
  assert.equal(sha(COMMENT80), CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256.sql80);
  // Both files have exactly the reviewed statement shape: one SECURITY DEFINER
  // CREATE OR REPLACE with the reviewed search_path/row_security, its comment,
  // and the same REVOKE/GRANT.
  assert.equal(parseSql80(SQL80_TEXT).outside, SQL80_NORMALIZED_STATEMENTS);
  assert.equal(parseSql80(SQL38_TEXT).outside, SQL80_NORMALIZED_STATEMENTS);
  const grantLines = (text) => text.split('\n').filter((line) => /^(REVOKE|GRANT) /.test(line));
  assert.deepEqual(grantLines(SQL80_TEXT), grantLines(SQL38_TEXT));
  const body = parseSql80(SQL80_TEXT).body;
  assert.match(body, /lower\(tu\.role::text\) IN \('owner', 'admin', 'manager', 'operator'\)/);
  assert.doesNotMatch(body, /viewer/);
  const outside = SQL80_TEXT.replace(body, '').replace(/^--.*$/gm, '');
  assert.doesNotMatch(outside, /DROP |ALTER |CREATE POLICY|CREATE TABLE|CREATE TRIGGER|SECURITY INVOKER|TO PUBLIC|anon/i);
  assert.equal((SQL80_TEXT.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 1);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(MIGRATIONS['sql80-checkalt-member-auto-deposit'], PIN);
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === PIN.filename && to === 'sql/80_checkalt_member_auto_deposit.sql'));
  assert.equal(evaluateSqlExecutorAuthorization(sql80Event(), { now: Date.parse(NOW) }).ok, true);
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), PIN.source_sha256);
});

test('the reviewed-text check refuses SECURITY INVOKER, another search_path, a changed body or comment, extra statements', () => {
  for (const [label, from, to] of [
    ['security invoker', /^SECURITY DEFINER$/m, 'SECURITY INVOKER'],
    ['search_path', /^SET search_path = public$/m, 'SET search_path = public, pg_temp'],
    ['row_security', /^SET row_security = off$/m, 'SET row_security = on'],
    ['grant to public', 'TO checksops, authenticated;', 'TO checksops, authenticated, PUBLIC;'],
    ['extra statement', 'REVOKE ALL ON FUNCTION', 'ALTER FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) OWNER TO checksops;\nREVOKE ALL ON FUNCTION'],
  ]) {
    const text = SQL80_TEXT.replace(from, to);
    assert.notEqual(text, SQL80_TEXT, label);
    assert.notEqual(parseSql80(text)?.outside, SQL80_NORMALIZED_STATEMENTS, label);
  }
  const widened = SQL80_TEXT.replace("'manager', 'operator'", "'manager', 'operator', 'viewer'");
  assert.equal(parseSql80(widened).outside, SQL80_NORMALIZED_STATEMENTS);
  assert.notEqual(sha(sql80ReviewedFunctiondef(widened)), CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80);
  const recommented = SQL80_TEXT.replace('viewers refused', 'viewers allowed');
  assert.notEqual(sha(parseSql80(recommented).comment), CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256.sql80);
  assert.equal(parseSql80(`${SQL80_TEXT}\nDO $$ BEGIN END $$;\n`), null);
});

test('apply refuses before connecting: unreviewed pin, read-live sentinel, wrong hash, forged pin, tampered file', async () => {
  const unreviewed = await handlerFor(neverConnect, { sql80Pin: { ...PIN, expected_live_definition_sha256: null } })(sql80Event());
  assert.equal(unreviewed.code, CODES.SQL_COLLISION);
  assert.match(unreviewed.message, /no reviewed pre-apply live definition hash/);
  const sentinel = await handlerFor(neverConnect)(sql80Event({ expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
  assert.equal(sentinel.code, CODES.SQL_COLLISION);
  assert.match(sentinel.message, /bound to the exact allowlisted pin/);
  const other = await handlerFor(neverConnect)(sql80Event({ expected_live_definition_sha256: 'b'.repeat(64) }));
  assert.equal(other.code, CODES.SQL_COLLISION);
  const wrongIntended = await handlerFor(neverConnect)(sql80Event({ intended_replacement_sha256: 'c'.repeat(64) }));
  assert.equal(wrongIntended.ok, false);
  const forged = await handlerFor(neverConnect, { sql80Pin: { ...PIN, intended_replacement_sha256: 'c'.repeat(64) } })(sql80Event());
  assert.equal(forged.code, CODES.SQL_COLLISION);
  assert.match(forged.message, /committed allowlist entry/);
  const forgedFunction = await handlerFor(neverConnect, { sql80Pin: { ...PIN, function_identity: 'public.aws_save_checkalt_tenant_auto_deposit(uuid)' } })(sql80Event());
  assert.equal(forgedFunction.code, CODES.SQL_COLLISION);
  const unsupported = await handlerFor(neverConnect)(sql80Event({ action: 'drop' }));
  assert.equal(unsupported.ok, false);
  for (const extra of [
    'ALTER FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) SECURITY INVOKER;\n',
    'GRANT EXECUTE ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) TO PUBLIC;\n',
    'GRANT UPDATE ON TABLE public.checkalt_tenant_accounts TO checksops;\n',
  ]) {
    const tampered = path.join(os.tmpdir(), `sql80-tampered-${process.pid}.sql`);
    fs.writeFileSync(tampered, `${SQL80_TEXT}${extra}`);
    try {
      const result = await handlerFor(neverConnect, { sqlFile80: tampered })(sql80Event());
      assert.equal(result.code, CODES.SQL_COLLISION, extra);
    } finally {
      fs.rmSync(tampered, { force: true });
    }
  }
});

const ACL = () => ['authenticated', 'checksops'].map((grantee) => ({ grantee, privilege_type: 'EXECUTE', is_grantable: false }));

/**
 * Fake catalog. Running the embedded file replaces the function definition
 * and comment and re-runs the REVOKE/GRANT (onApply may then change the
 * working copy); ROLLBACK discards it.
 */
function fakeDb({ applied = false, mutate, onApply, failOnApply = false } = {}) {
  let committed = {
    fn: {
      present: true,
      def: applied ? DEF80 : DEF38,
      security_definer: true,
      config: ['search_path=public', 'row_security=off'],
      owner_is_executor: true,
      comment: applied ? COMMENT80 : COMMENT38,
      overload_count: 1,
    },
    acl: ACL(),
    prereq: { required_roles_present: true, required_tables_present: true, required_functions_present: true },
    tableUpdate: false,
    relations: [{ relname: 'checkalt_tenant_accounts', relkind: 'r' }, { relname: 'tenants', relkind: 'r' }],
    policies: [{ table_name: 'public.checkalt_tenant_accounts', polname: 'aws_select_checkalt_tenant_accounts', polcmd: 'r', polpermissive: true, polroles: '{16385}', polqual: 'true', polwithcheck: null }],
    otherFunctions: [{ signature: 'public.is_platform_owner()', def_sha256: 'a'.repeat(64), acl: null, prosecdef: true, config: '{search_path=public}', owner: 'checksops_admin' }],
    tableAcl: '{checksops_admin=arwdDxtm/checksops_admin,checksops=r/checksops_admin}',
  };
  if (mutate) mutate(committed);
  let working = null;
  const current = () => working || committed;
  const seen = [];
  return {
    seen,
    get committed() { return committed; },
    connect: async () => ({
      end: async () => {},
      query: async (sql) => {
        const text = String(sql);
        seen.push(text);
        const db = current();
        if (text === 'BEGIN' || text === 'BEGIN READ ONLY') { working = clone(committed); return { rows: [] }; }
        if (text.startsWith('SET LOCAL lock_timeout')) return { rows: [] };
        if (text === 'COMMIT') { committed = working; working = null; return { rows: [] }; }
        if (text === 'ROLLBACK') { working = null; return { rows: [] }; }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (text.includes("set_config('search_path'")) return { rows: [{ set_config: 'pg_catalog' }] };
        if (text.includes('AS overload_count')) {
          return { rows: [db.fn.present ? clone(db.fn) : { present: false, def: null, security_definer: null, config: [], owner_is_executor: null, comment: null, overload_count: db.fn.overload_count }] };
        }
        if (text.includes("acldefault('f'")) return { rows: clone(db.acl) };
        if (text.includes('AS required_tables_present')) return { rows: [clone(db.prereq)] };
        if (text.includes('AS table_update_granted')) return { rows: [{ table_update_granted: db.tableUpdate }] };
        if (text.includes('relnamespace')) return { rows: clone(db.relations) };
        if (text.includes('FROM pg_policy pol')) return { rows: clone(db.policies) };
        if (text.includes("nspname IN ('public', 'auth')")) return { rows: clone(db.otherFunctions) };
        if (text.includes('AS table_acl')) return { rows: [{ table_acl: db.tableAcl }] };
        if (text.includes('CREATE OR REPLACE FUNCTION public.aws_save_checkalt_tenant_auto_deposit')) {
          if (failOnApply) throw new Error('must be owner of function aws_save_checkalt_tenant_auto_deposit');
          db.fn.def = DEF80;
          db.fn.comment = COMMENT80;
          db.acl = db.acl.filter((entry) => entry.grantee !== 'PUBLIC');
          for (const grantee of ['checksops', 'authenticated']) {
            if (!db.acl.some((entry) => entry.grantee === grantee && entry.privilege_type === 'EXECUTE')) db.acl.push({ grantee, privilege_type: 'EXECUTE', is_grantable: false });
          }
          if (onApply) onApply(db);
          return { rows: [] };
        }
        throw new Error(`unexpected SQL ${text.slice(0, 60)}`);
      },
    }),
  };
}

test('inspect only SELECTs and reports the SQL 38 state; read-live prints its flags; a pin without an expected hash is not executable', async () => {
  const db = fakeDb();
  const inspect = await handlerFor(db.connect)(sql80Event({
    action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
  }));
  assert.equal(inspect.ok, true, JSON.stringify(inspect));
  const receipt = inspect.details.receipt;
  assert.equal(receipt.live_definition_sha256, PIN.expected_live_definition_sha256);
  assert.equal(receipt.before_hash, receipt.after_hash);
  assert.equal(receipt.exists, true);
  assert.equal(receipt.overload_count, 1);
  assert.equal(receipt.security_definer, true);
  assert.equal(receipt.config_as_reviewed, true);
  assert.equal(receipt.owner_is_executor, true);
  assert.equal(receipt.acl_as_expected, true);
  assert.equal(receipt.table_update_granted, false);
  assert.deepEqual(receipt.function_states, { definition: 'expected', comment: 'expected' });
  assert.equal(receipt.function_definition_sha256, CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql38);
  assert.equal(receipt.prerequisites_ok, true);
  assert.equal(receipt.pin_executable, true);
  assert.equal(receipt.apply_preconditions_met, true);
  assert.equal(db.seen[0], 'BEGIN READ ONLY');
  assert.equal(db.seen.at(-1), 'ROLLBACK');
  assert.ok(db.seen.slice(1, -1).every((text) => /^\s*(SELECT|WITH)\b/i.test(text)), JSON.stringify(db.seen));
  assert.ok(!db.seen.some((text) => text.includes('CREATE OR REPLACE')));

  const summary = readLiveSummary({ ok: true, details: inspect }, { migration: 'sql80-checkalt-member-auto-deposit', pin: PIN });
  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(summary.details.matches_pinned_expected, true);
  assert.equal(summary.details.overload_count, 1);
  assert.equal(summary.details.security_definer, true);
  assert.equal(summary.details.acl_as_expected, true);
  assert.deepEqual(summary.details.function_states, { definition: 'expected', comment: 'expected' });

  const unreviewed = await handlerFor(fakeDb().connect, { sql80Pin: { ...PIN, expected_live_definition_sha256: null } })(sql80Event({
    action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
  }));
  assert.equal(unreviewed.details.receipt.pin_executable, false);
  assert.equal(unreviewed.details.receipt.apply_preconditions_met, false);

  const applied = await handlerFor(fakeDb({ applied: true }).connect)(sql80Event({ action: 'inspect' }));
  assert.equal(applied.details.receipt.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(applied.details.receipt.function_states, { definition: 'intended', comment: 'intended' });
  assert.equal(applied.details.receipt.apply_preconditions_met, false);
});

test('apply replaces the function once; replay, re-apply, drift, prerequisites and collateral changes are refused and rolled back', async () => {
  const db = fakeDb();
  const handler = handlerFor(db.connect);
  const event = sql80Event();
  const applied = await handler(event);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, PIN.expected_live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(applied.details.receipt.function_states, { definition: 'intended', comment: 'intended' });
  assert.equal(db.seen[db.seen.indexOf('BEGIN') + 1], "SET LOCAL lock_timeout = '5s'");
  assert.ok(db.seen[db.seen.indexOf('BEGIN') + 2].includes('pg_advisory_xact_lock'));
  assert.ok(db.seen.includes('COMMIT'));
  assert.equal(db.committed.fn.def, DEF80);
  assert.deepEqual(db.committed.acl, ACL());
  assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
  const again = await handler(sql80Event());
  assert.equal(again.code, CODES.UNRELATED_MUTATION);
  assert.match(again.message, /already in place/);

  for (const [label, mutate] of [
    ['another definition', (d) => { d.fn.def = DEF38.replace("('admin', 'owner')", "('admin', 'owner', 'viewer')"); }],
    ['an overload', (d) => { d.fn.overload_count = 2; }],
    ['function absent', (d) => { d.fn.present = false; d.fn.overload_count = 0; }],
    ['SECURITY INVOKER', (d) => { d.fn.security_definer = false; }],
    ['search_path changed', (d) => { d.fn.config = ['search_path=public, pg_temp', 'row_security=off']; }],
    ['row_security not set', (d) => { d.fn.config = ['search_path=public']; }],
    ['another owner', (d) => { d.fn.owner_is_executor = false; }],
    ['PUBLIC can execute', (d) => { d.acl.push({ grantee: 'PUBLIC', privilege_type: 'EXECUTE', is_grantable: false }); }],
    ['grant option', (d) => { d.acl[0].is_grantable = true; }],
    ['extra grantee', (d) => { d.acl.push({ grantee: 'anon', privilege_type: 'EXECUTE', is_grantable: false }); }],
    ['checksops cannot execute', (d) => { d.acl = d.acl.filter((entry) => entry.grantee !== 'checksops'); }],
    ['table UPDATE granted', (d) => { d.tableUpdate = true; }],
    ['table UPDATE unknown', (d) => { d.tableUpdate = null; }],
    ['grantee role missing', (d) => { d.prereq.required_roles_present = false; }],
    ['table missing', (d) => { d.prereq.required_tables_present = false; }],
    ['helper missing', (d) => { d.prereq.required_functions_present = false; }],
    ['comment changed', (d) => { d.fn.comment = 'something else'; }],
  ]) {
    const blocked = fakeDb({ mutate });
    const inspected = await handlerFor(blocked.connect)(sql80Event({ action: 'inspect' }));
    assert.equal(inspected.details.receipt.apply_preconditions_met, false, label);
    const refused = await handlerFor(blocked.connect)(sql80Event());
    assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(refused)}`);
    assert.ok(!blocked.seen.some((text) => text.includes('CREATE OR REPLACE')), label);
    assert.ok(blocked.seen.includes('ROLLBACK'), label);
  }

  for (const [label, onApply] of [
    ['grants changed', (d) => { d.acl.push({ grantee: 'anon', privilege_type: 'EXECUTE', is_grantable: false }); }],
    ['security definer dropped', (d) => { d.fn.security_definer = false; }],
    ['search_path changed', (d) => { d.fn.config = ['search_path=public, pg_temp', 'row_security=off']; }],
    ['another definition landed', (d) => { d.fn.def = DEF80.replace("'operator')", "'operator', 'viewer')"); }],
    ['an overload created', (d) => { d.fn.overload_count = 2; }],
    ['table UPDATE granted', (d) => { d.tableUpdate = true; }],
    ['table ACL changed', (d) => { d.tableAcl = `${d.tableAcl},anon=r/checksops_admin`; }],
    ['another function changed', (d) => { d.otherFunctions[0].def_sha256 = 'b'.repeat(64); }],
    ['a policy changed', (d) => { d.policies[0].polqual = 'false'; }],
    ['a relation created', (d) => { d.relations.push({ relname: 'evil', relkind: 'r' }); }],
  ]) {
    const collateral = fakeDb({ onApply });
    const refused = await handlerFor(collateral.connect)(sql80Event());
    assert.equal(refused.code, CODES.UNRELATED_MUTATION, `${label}: ${JSON.stringify(refused)}`);
    assert.equal(collateral.committed.fn.def, DEF38, label);
    assert.ok(collateral.seen.includes('ROLLBACK'), label);
    assert.ok(!collateral.seen.includes('COMMIT'), label);
  }

  const broken = fakeDb({ failOnApply: true });
  const failed = await handlerFor(broken.connect)(sql80Event());
  assert.equal(failed.code, CODES.UNRELATED_MUTATION);
  assert.equal(broken.committed.fn.def, DEF38);
  assert.ok(broken.seen.includes('ROLLBACK'));
});

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const A_OPERATOR = 'a1000000-0000-4000-8000-00000000000a';
const A_VIEWER = 'a1000000-0000-4000-8000-00000000000c';

test('PostgreSQL 16: the real catalog matches both pinned hashes; the handler applies SQL 80 once and refuses everything else', {
  timeout: 180000,
}, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql80-exec-', 55800);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await applyBaseSchema(admin);
    await admin.query(`
      CREATE TABLE public.checkalt_tenant_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE UNIQUE,
        enabled boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now(),
        auto_approve_enabled boolean NOT NULL DEFAULT false,
        auto_approve_max_cents integer);
      REVOKE ALL ON TABLE public.checkalt_tenant_accounts FROM checksops, authenticated;
      GRANT SELECT ON TABLE public.checkalt_tenant_accounts TO checksops;
      ALTER TABLE public.checkalt_tenant_accounts ENABLE ROW LEVEL SECURITY;
      -- Like the AWS database user: a non-superuser that owns the table and applied SQL 38.
      CREATE ROLE sql80_owner LOGIN NOSUPERUSER;
      GRANT USAGE, CREATE ON SCHEMA public TO sql80_owner;
      GRANT USAGE ON SCHEMA auth TO sql80_owner;
      GRANT SELECT ON public.tenant_users, public.identity_accounts TO sql80_owner;
      ALTER TABLE public.checkalt_tenant_accounts OWNER TO sql80_owner;
      INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A');
      INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
        ('${TENANT_A}', '${A_OPERATOR}', 'operator'), ('${TENANT_A}', '${A_VIEWER}', 'viewer');
      INSERT INTO public.checkalt_tenant_accounts (tenant_id, auto_approve_enabled, auto_approve_max_cents)
        VALUES ('${TENANT_A}', true, 200000);
    `);
    const owner = await connectAs('sql80_owner');
    try {
      await owner.query(SQL38_TEXT);
    } finally {
      await owner.end();
    }
    const fnAcl = async () => (await admin.query(`SELECT proacl::text AS acl FROM pg_proc WHERE oid = '${CHECKALT_AUTO_DEPOSIT_FUNCTION}'::regprocedure`)).rows[0].acl;
    const aclBefore = await fnAcl();
    /** The RPC as the API calls it: checksops with the caller's application user id. */
    const save = async (user, settings) => {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE checksops');
        await admin.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const { rows } = await admin.query('SELECT public.aws_save_checkalt_tenant_auto_deposit($1::uuid, $2::jsonb) AS r', [TENANT_A, JSON.stringify(settings)]);
        await admin.query('COMMIT');
        return rows[0].r;
      } catch (error) {
        await admin.query('ROLLBACK');
        return { error: error.message };
      }
    };
    assert.equal((await save(A_OPERATOR, { auto_approve_enabled: false })).error, 'not_authorized');

    const handler = handlerFor(() => connectAs('sql80_owner'));
    const inspect = async () => handler(sql80Event({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));

    const before = await inspect();
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.details.receipt.function_definition_sha256, CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql38, JSON.stringify(before.details.receipt));
    assert.equal(before.details.receipt.live_definition_sha256, PIN.expected_live_definition_sha256, JSON.stringify(before.details.receipt));
    assert.deepEqual(before.details.receipt.function_states, { definition: 'expected', comment: 'expected' });
    assert.equal(before.details.receipt.table_update_granted, false);
    assert.equal(before.details.receipt.apply_preconditions_met, true, JSON.stringify(before.details.receipt));
    const realDef38 = (await admin.query(`SELECT pg_get_functiondef('${CHECKALT_AUTO_DEPOSIT_FUNCTION}'::regprocedure) AS d`)).rows[0].d;
    assert.equal(realDef38, DEF38);

    const refusedThenRestored = async (label, breakIt, restore) => {
      await admin.query(breakIt);
      const refused = await inspect();
      assert.equal(refused.ok, true, `${label}: ${JSON.stringify(refused)}`);
      assert.equal(refused.details.receipt.apply_preconditions_met, false, label);
      const applyRefused = await handler(sql80Event());
      assert.equal(applyRefused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(applyRefused)}`);
      await admin.query(restore);
      assert.equal((await inspect()).details.receipt.apply_preconditions_met, true, label);
    };
    const fn = CHECKALT_AUTO_DEPOSIT_FUNCTION;
    await refusedThenRestored('an overload',
      'CREATE FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
      'DROP FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid)');
    await refusedThenRestored('an overload in another schema',
      'CREATE FUNCTION auth.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
      'DROP FUNCTION auth.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb)');
    await refusedThenRestored('SECURITY INVOKER', `ALTER FUNCTION ${fn} SECURITY INVOKER`, `ALTER FUNCTION ${fn} SECURITY DEFINER`);
    await refusedThenRestored('search_path', `ALTER FUNCTION ${fn} SET search_path = public, pg_temp`, `ALTER FUNCTION ${fn} SET search_path = public`);
    await refusedThenRestored('PUBLIC EXECUTE', `GRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC`, `REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC`);
    await refusedThenRestored('grant option', `GRANT EXECUTE ON FUNCTION ${fn} TO checksops WITH GRANT OPTION`, `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${fn} FROM checksops`);
    await refusedThenRestored('column UPDATE granted', 'GRANT UPDATE (auto_approve_enabled) ON public.checkalt_tenant_accounts TO checksops', 'REVOKE UPDATE (auto_approve_enabled) ON public.checkalt_tenant_accounts FROM checksops');
    await refusedThenRestored('another owner', `ALTER FUNCTION ${fn} OWNER TO ubuntu`, `ALTER FUNCTION ${fn} OWNER TO sql80_owner`);
    assert.equal(await fnAcl(), aclBefore);

    const event = sql80Event();
    const applied = await handler(event);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PIN.expected_live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.details.receipt.live_definition_sha256, PIN.intended_replacement_sha256);
    assert.equal(after.details.receipt.function_definition_sha256, CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80);
    assert.deepEqual(after.details.receipt.function_states, { definition: 'intended', comment: 'intended' });
    assert.equal(after.details.receipt.security_definer, true);
    assert.equal(after.details.receipt.config_as_reviewed, true);
    assert.equal(after.details.receipt.acl_sha256, before.details.receipt.acl_sha256);
    assert.equal(after.details.receipt.apply_preconditions_met, false);
    const realDef80 = (await admin.query(`SELECT pg_get_functiondef('${fn}'::regprocedure) AS d`)).rows[0].d;
    assert.equal(realDef80, DEF80);
    // Grants are unchanged: the same proacl, EXECUTE for checksops and authenticated only.
    assert.equal(await fnAcl(), aclBefore);
    assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
    const reapply = await handler(sql80Event());
    assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
    assert.match(reapply.message, /already in place/);

    // SQL 80 behavior: an operator can now save, a viewer still cannot.
    assert.deepEqual(await save(A_OPERATOR, { auto_approve_enabled: false, auto_approve_max_cents: 150000 }), {
      tenant_id: TENANT_A, auto_approve_enabled: false, auto_approve_max_cents: 150000,
    });
    assert.equal((await save(A_VIEWER, { auto_approve_enabled: true })).error, 'not_authorized');
  } finally {
    await admin.end();
    server.stop();
  }
});

test('a failing statement inside the apply transaction leaves SQL 38 in place (PostgreSQL 16)', { timeout: 180000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql80-rollback-', 55850);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  try {
    await applyBaseSchema(admin);
    await admin.query(`
      CREATE TABLE public.checkalt_tenant_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid UNIQUE, updated_at timestamptz,
        auto_approve_enabled boolean NOT NULL DEFAULT false, auto_approve_max_cents integer);
      GRANT SELECT ON TABLE public.checkalt_tenant_accounts TO checksops;
      CREATE ROLE sql80_owner LOGIN NOSUPERUSER;
      GRANT USAGE, CREATE ON SCHEMA public TO sql80_owner;
    `);
    const asOwner = async () => {
      const client = new pg.Client({ host: server.host, port: server.port, user: 'sql80_owner', database: 'postgres' });
      await client.connect();
      return client;
    };
    const owner = await asOwner();
    await owner.query(SQL38_TEXT);
    await owner.end();
    // The executor role may replace the function, but the GRANT in SQL 80 fails
    // half-way through the file once checksops is dropped; nothing may stick.
    const handler = handlerFor(async () => {
      const client = await asOwner();
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql).includes('GRANT EXECUTE ON FUNCTION')
        ? query(`${String(sql).replace('TO checksops, authenticated;', 'TO checksops, sql80_missing_role;')}`, params)
        : query(sql, params));
      return client;
    });
    const result = await handler(sql80Event());
    assert.equal(result.code, CODES.UNRELATED_MUTATION, JSON.stringify(result));
    const def = (await admin.query(`SELECT pg_get_functiondef('${CHECKALT_AUTO_DEPOSIT_FUNCTION}'::regprocedure) AS d`)).rows[0].d;
    assert.equal(def, DEF38);
  } finally {
    await admin.end();
    server.stop();
  }
});
