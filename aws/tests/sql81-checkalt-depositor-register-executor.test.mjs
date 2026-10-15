/**
 * Staging VPC executor support for SQL 81 (CREATE of the SECURITY DEFINER
 * function public.aws_register_checkalt_tenant_account(uuid, jsonb), the
 * platform-owner-only production Check Alt depositor registration writer, its
 * comment, REVOKE ALL ... FROM PUBLIC and GRANT EXECUTE ... TO checksops,
 * authenticated).
 *
 * Both hashes are code-derived: the pre-apply state is the function absent (no
 * function of that name in any schema), the intended state the one SQL 81
 * leaves. The PostgreSQL 16 test below re-derives both from the real catalog
 * with the real SQL 81 file, then applies through the handler.
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
  AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER as PIN,
  AUTHORIZED_STAGING_SQL,
  CHECKALT_REGISTER_APPLIED_STATE,
  CHECKALT_REGISTER_COMMENT_SHA256,
  CHECKALT_REGISTER_DEFINITION_SHA256,
  CHECKALT_REGISTER_FUNCTION,
  CHECKALT_REGISTER_PRE_STATE,
  authorizationFingerprint,
  checkaltRegisterStateText,
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
const NOW = '2026-10-15T19:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler, parseSql81, sql81ReviewedFunctiondef, SQL81_NORMALIZED_STATEMENTS } = executorModule;

const SQL81_TEXT = fs.readFileSync(SQL_FILE, 'utf8');
// pg_get_functiondef / obj_description on PostgreSQL 16 (checked against the real catalog below).
const DEF81 = sql81ReviewedFunctiondef(SQL81_TEXT);
const COMMENT81 = parseSql81(SQL81_TEXT).comment;

function sql81Event(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql81-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const event = {
    action: 'apply',
    workstream_id: 'staging-sql81-checkalt-depositor-register',
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
    `sql81-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile81: SQL_FILE, ...extra });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};

test('pin matches the SQL file and its commit; both hashes are the code-derived absent and SQL 81 states', () => {
  assert.equal(sha(fs.readFileSync(SQL_FILE)), PIN.source_sha256);
  assert.equal(PIN.source_sha256, '88aafdacf83ea382e4b2f0c56da8d8c2048d36773ada18c49874e807cdbd8fbe');
  assert.equal(PIN.migration_id, '81_checkalt_production_register');
  assert.equal(PIN.expected_live_definition_sha256, sha(checkaltRegisterStateText(CHECKALT_REGISTER_PRE_STATE)));
  assert.equal(PIN.expected_live_definition_sha256, 'e12fdf2fe609d474a9cc215c018cce922cc2a63edfd18f7b5988ce21d1903f37');
  assert.equal(checkaltRegisterStateText(CHECKALT_REGISTER_PRE_STATE), [
    'function public.aws_register_checkalt_tenant_account(uuid, jsonb): absent',
    'functions named aws_register_checkalt_tenant_account: 0',
  ].join('\n'));
  assert.equal(PIN.intended_replacement_sha256, sha(checkaltRegisterStateText(CHECKALT_REGISTER_APPLIED_STATE)));
  assert.equal(PIN.intended_replacement_sha256, '36623ccebd920a9c6316da7f787ad99126e474656877e01b5854e099ce661225');
  assert.equal(PIN.function_identity, 'public.aws_register_checkalt_tenant_account(uuid, jsonb)');
  // The definition and comment hashes are those of the real SQL 81 file.
  assert.equal(sha(DEF81), CHECKALT_REGISTER_DEFINITION_SHA256.sql81);
  assert.equal(CHECKALT_REGISTER_DEFINITION_SHA256.sql81, 'd1f781edb9e8665748da96b28a8afca54279fa43cf603c526f4200524d104a78');
  assert.equal(sha(COMMENT81), CHECKALT_REGISTER_COMMENT_SHA256.sql81);
  assert.equal(CHECKALT_REGISTER_COMMENT_SHA256.sql81, 'e48465b4e9badfe5435ffcfc7162770b95746954b95c71eb9a9e304570bc435b');
  // Exactly the reviewed statement shape: one SECURITY DEFINER CREATE OR REPLACE
  // with the reviewed search_path/row_security, its comment, REVOKE PUBLIC and the GRANT.
  assert.equal(parseSql81(SQL81_TEXT).outside, SQL81_NORMALIZED_STATEMENTS);
  const body = parseSql81(SQL81_TEXT).body;
  assert.match(body, /IF NOT public\.is_platform_owner\(\) THEN\s+RAISE EXCEPTION 'not_authorized'/);
  assert.match(body, /\^\[0-9\]\{5,17\}\$/);
  assert.doesNotMatch(body, /auto_approve_/);
  const outside = SQL81_TEXT.replace(body, '').replace(/^--.*$/gm, '');
  assert.doesNotMatch(outside, /DROP |ALTER |CREATE POLICY|CREATE TABLE|CREATE TRIGGER|SECURITY INVOKER|TO PUBLIC|anon/i);
  assert.equal((SQL81_TEXT.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 1);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(MIGRATIONS['sql81-checkalt-depositor-register'], PIN);
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === PIN.filename && to === 'sql/81_checkalt_production_register.sql'));
  assert.equal(evaluateSqlExecutorAuthorization(sql81Event(), { now: Date.parse(NOW) }).ok, true);
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), PIN.source_sha256);
});

test('the reviewed-text check refuses SECURITY INVOKER, another search_path, a PUBLIC grant, a changed body or comment, extra statements', () => {
  for (const [label, from, to] of [
    ['security invoker', /^SECURITY DEFINER$/m, 'SECURITY INVOKER'],
    ['search_path', /^SET search_path = public$/m, 'SET search_path = public, pg_temp'],
    ['row_security', /^SET row_security = off$/m, 'SET row_security = on'],
    ['grant to public', 'TO checksops, authenticated;', 'TO checksops, authenticated, PUBLIC;'],
    ['no revoke', 'REVOKE ALL ON FUNCTION public.aws_register_checkalt_tenant_account(uuid, jsonb) FROM PUBLIC;\n', ''],
    ['extra statement', 'REVOKE ALL ON FUNCTION', 'ALTER FUNCTION public.aws_register_checkalt_tenant_account(uuid, jsonb) OWNER TO checksops;\nREVOKE ALL ON FUNCTION'],
  ]) {
    const text = SQL81_TEXT.replace(from, to);
    assert.notEqual(text, SQL81_TEXT, label);
    assert.notEqual(parseSql81(text)?.outside, SQL81_NORMALIZED_STATEMENTS, label);
  }
  const widened = SQL81_TEXT.replace('IF NOT public.is_platform_owner() THEN', 'IF false THEN');
  assert.equal(parseSql81(widened).outside, SQL81_NORMALIZED_STATEMENTS);
  assert.notEqual(sha(sql81ReviewedFunctiondef(widened)), CHECKALT_REGISTER_DEFINITION_SHA256.sql81);
  const recommented = SQL81_TEXT.replace('Platform-owner-only', 'Anyone');
  assert.notEqual(sha(parseSql81(recommented).comment), CHECKALT_REGISTER_COMMENT_SHA256.sql81);
  assert.equal(parseSql81(`${SQL81_TEXT}\nDO $$ BEGIN END $$;\n`), null);
});

test('apply refuses before connecting: unreviewed pin, read-live sentinel, wrong hash, forged pin, tampered file', async () => {
  const unreviewed = await handlerFor(neverConnect, { sql81Pin: { ...PIN, expected_live_definition_sha256: null } })(sql81Event());
  assert.equal(unreviewed.code, CODES.SQL_COLLISION);
  assert.match(unreviewed.message, /no reviewed pre-apply live definition hash/);
  const sentinel = await handlerFor(neverConnect)(sql81Event({ expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
  assert.equal(sentinel.code, CODES.SQL_COLLISION);
  assert.match(sentinel.message, /bound to the exact allowlisted pin/);
  const other = await handlerFor(neverConnect)(sql81Event({ expected_live_definition_sha256: 'b'.repeat(64) }));
  assert.equal(other.code, CODES.SQL_COLLISION);
  const wrongIntended = await handlerFor(neverConnect)(sql81Event({ intended_replacement_sha256: 'c'.repeat(64) }));
  assert.equal(wrongIntended.ok, false);
  const forged = await handlerFor(neverConnect, { sql81Pin: { ...PIN, intended_replacement_sha256: 'c'.repeat(64) } })(sql81Event());
  assert.equal(forged.code, CODES.SQL_COLLISION);
  assert.match(forged.message, /committed allowlist entry/);
  const forgedFunction = await handlerFor(neverConnect, { sql81Pin: { ...PIN, function_identity: 'public.aws_register_checkalt_tenant_account(uuid)' } })(sql81Event());
  assert.equal(forgedFunction.code, CODES.SQL_COLLISION);
  const unsupported = await handlerFor(neverConnect)(sql81Event({ action: 'drop' }));
  assert.equal(unsupported.ok, false);
  for (const extra of [
    'ALTER FUNCTION public.aws_register_checkalt_tenant_account(uuid, jsonb) SECURITY INVOKER;\n',
    'GRANT EXECUTE ON FUNCTION public.aws_register_checkalt_tenant_account(uuid, jsonb) TO PUBLIC;\n',
    'GRANT INSERT, UPDATE ON TABLE public.checkalt_tenant_accounts TO checksops;\n',
  ]) {
    const tampered = path.join(os.tmpdir(), `sql81-tampered-${process.pid}.sql`);
    fs.writeFileSync(tampered, `${SQL81_TEXT}${extra}`);
    try {
      const result = await handlerFor(neverConnect, { sqlFile81: tampered })(sql81Event());
      assert.equal(result.code, CODES.SQL_COLLISION, extra);
    } finally {
      fs.rmSync(tampered, { force: true });
    }
  }
});

const ACL = () => ['authenticated', 'checksops'].map((grantee) => ({ grantee, privilege_type: 'EXECUTE', is_grantable: false }));
const ABSENT_FN = () => ({ present: false, def: null, security_definer: null, config: [], owner_is_executor: null, comment: null, overload_count: 0 });
const APPLIED_FN = () => ({
  present: true,
  def: DEF81,
  security_definer: true,
  config: ['search_path=public', 'row_security=off'],
  owner_is_executor: true,
  comment: COMMENT81,
  overload_count: 1,
});

/**
 * Fake catalog. Running the embedded file creates the function with its
 * comment and grants (onApply may then change the working copy); ROLLBACK
 * discards it.
 */
function fakeDb({ applied = false, mutate, onApply, failOnApply = false } = {}) {
  let committed = {
    fn: applied ? APPLIED_FN() : ABSENT_FN(),
    acl: applied ? ACL() : [],
    prereq: { required_roles_present: true, required_tables_present: true, required_functions_present: true, required_columns_present: true },
    writes: { register_table_update_granted: false, register_table_insert_granted: false },
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
        if (text.includes('AS overload_count')) return { rows: [clone(db.fn)] };
        if (text.includes("acldefault('f'")) return { rows: clone(db.acl) };
        if (text.includes('AS required_columns_present')) return { rows: [clone(db.prereq)] };
        if (text.includes('AS register_table_insert_granted')) return { rows: [clone(db.writes)] };
        if (text.includes('relnamespace')) return { rows: clone(db.relations) };
        if (text.includes('FROM pg_policy pol')) return { rows: clone(db.policies) };
        if (text.includes("nspname IN ('public', 'auth')")) return { rows: clone(db.otherFunctions) };
        if (text.includes('AS table_acl')) return { rows: [{ table_acl: db.tableAcl }] };
        if (text.includes('CREATE OR REPLACE FUNCTION public.aws_register_checkalt_tenant_account')) {
          if (failOnApply) throw new Error('permission denied for schema public');
          const overloads = db.fn.overload_count;
          db.fn = { ...APPLIED_FN(), overload_count: overloads + 1 };
          db.acl = ACL();
          if (onApply) onApply(db);
          return { rows: [] };
        }
        throw new Error(`unexpected SQL ${text.slice(0, 60)}`);
      },
    }),
  };
}

test('inspect only SELECTs and reports the absent state; read-live prints its flags; a pin without an expected hash is not executable', async () => {
  const db = fakeDb();
  const inspect = await handlerFor(db.connect)(sql81Event({
    action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
  }));
  assert.equal(inspect.ok, true, JSON.stringify(inspect));
  const receipt = inspect.details.receipt;
  assert.equal(receipt.live_definition_sha256, PIN.expected_live_definition_sha256);
  assert.equal(receipt.before_hash, receipt.after_hash);
  assert.equal(receipt.exists, false);
  assert.equal(receipt.overload_count, 0);
  assert.equal(receipt.required_columns_present, true);
  assert.equal(receipt.table_update_granted, false);
  assert.equal(receipt.table_insert_granted, false);
  assert.deepEqual(receipt.function_states, { definition: 'absent', comment: 'absent' });
  assert.equal(receipt.function_definition_sha256, null);
  assert.equal(receipt.prerequisites_ok, true);
  assert.equal(receipt.pin_executable, true);
  assert.equal(receipt.apply_preconditions_met, true);
  assert.equal(db.seen[0], 'BEGIN READ ONLY');
  assert.equal(db.seen.at(-1), 'ROLLBACK');
  assert.ok(db.seen.slice(1, -1).every((text) => /^\s*(SELECT|WITH)\b/i.test(text)), JSON.stringify(db.seen));
  assert.ok(!db.seen.some((text) => text.includes('CREATE OR REPLACE')));

  const summary = readLiveSummary({ ok: true, details: inspect }, { migration: 'sql81-checkalt-depositor-register', pin: PIN });
  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(summary.details.matches_pinned_expected, true);
  assert.equal(summary.details.exists, false);
  assert.equal(summary.details.overload_count, 0);
  assert.equal(summary.details.table_insert_granted, false);
  assert.equal(summary.details.required_columns_present, true);
  assert.deepEqual(summary.details.function_states, { definition: 'absent', comment: 'absent' });

  const unreviewed = await handlerFor(fakeDb().connect, { sql81Pin: { ...PIN, expected_live_definition_sha256: null } })(sql81Event({
    action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
  }));
  assert.equal(unreviewed.details.receipt.pin_executable, false);
  assert.equal(unreviewed.details.receipt.apply_preconditions_met, false);

  const applied = await handlerFor(fakeDb({ applied: true }).connect)(sql81Event({ action: 'inspect' }));
  assert.equal(applied.details.receipt.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(applied.details.receipt.function_states, { definition: 'intended', comment: 'intended' });
  assert.equal(applied.details.receipt.acl_as_expected, true);
  assert.equal(applied.details.receipt.apply_preconditions_met, false);
});

test('apply creates the function once; replay, re-apply, drift, prerequisites and collateral changes are refused and rolled back', async () => {
  const db = fakeDb();
  const handler = handlerFor(db.connect);
  const event = sql81Event();
  const applied = await handler(event);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, PIN.expected_live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(applied.details.receipt.function_states, { definition: 'intended', comment: 'intended' });
  assert.equal(db.seen[db.seen.indexOf('BEGIN') + 1], "SET LOCAL lock_timeout = '5s'");
  assert.ok(db.seen[db.seen.indexOf('BEGIN') + 2].includes('pg_advisory_xact_lock'));
  assert.ok(db.seen.includes('COMMIT'));
  assert.equal(db.committed.fn.def, DEF81);
  assert.deepEqual(db.committed.acl, ACL());
  assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
  const again = await handler(sql81Event());
  assert.equal(again.code, CODES.UNRELATED_MUTATION);
  assert.match(again.message, /already in place/);

  for (const [label, mutate] of [
    ['another function with that name exists', (d) => { d.fn = { ...APPLIED_FN(), def: DEF81.replace('IF NOT public.is_platform_owner()', 'IF false') }; d.acl = ACL(); }],
    ['an overload in another schema', (d) => { d.fn.overload_count = 1; }],
    ['grantee role missing', (d) => { d.prereq.required_roles_present = false; }],
    ['table missing', (d) => { d.prereq.required_tables_present = false; }],
    ['helper missing', (d) => { d.prereq.required_functions_present = false; }],
    ['column or unique tenant_id missing', (d) => { d.prereq.required_columns_present = false; }],
    ['table UPDATE granted', (d) => { d.writes.register_table_update_granted = true; }],
    ['table INSERT granted', (d) => { d.writes.register_table_insert_granted = true; }],
    ['table writes unknown', (d) => { d.writes.register_table_insert_granted = null; }],
  ]) {
    const blocked = fakeDb({ mutate });
    const inspected = await handlerFor(blocked.connect)(sql81Event({ action: 'inspect' }));
    assert.equal(inspected.details.receipt.apply_preconditions_met, false, label);
    const refused = await handlerFor(blocked.connect)(sql81Event());
    assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(refused)}`);
    assert.ok(!blocked.seen.some((text) => text.includes('CREATE OR REPLACE')), label);
    assert.ok(blocked.seen.includes('ROLLBACK'), label);
  }

  for (const [label, onApply] of [
    ['PUBLIC kept EXECUTE', (d) => { d.acl.push({ grantee: 'PUBLIC', privilege_type: 'EXECUTE', is_grantable: false }); }],
    ['extra grantee', (d) => { d.acl.push({ grantee: 'anon', privilege_type: 'EXECUTE', is_grantable: false }); }],
    ['grant option', (d) => { d.acl[0].is_grantable = true; }],
    ['authenticated not granted', (d) => { d.acl = d.acl.filter((entry) => entry.grantee !== 'authenticated'); }],
    ['security definer dropped', (d) => { d.fn.security_definer = false; }],
    ['search_path changed', (d) => { d.fn.config = ['search_path=public, pg_temp', 'row_security=off']; }],
    ['another owner', (d) => { d.fn.owner_is_executor = false; }],
    ['another definition landed', (d) => { d.fn.def = DEF81.replace('IF NOT public.is_platform_owner()', 'IF false'); }],
    ['another comment landed', (d) => { d.fn.comment = 'x'; }],
    ['an overload created', (d) => { d.fn.overload_count = 2; }],
    ['table UPDATE granted', (d) => { d.writes.register_table_update_granted = true; }],
    ['table INSERT granted', (d) => { d.writes.register_table_insert_granted = true; }],
    ['table ACL changed', (d) => { d.tableAcl = `${d.tableAcl},anon=r/checksops_admin`; }],
    ['another function changed', (d) => { d.otherFunctions[0].def_sha256 = 'b'.repeat(64); }],
    ['a policy changed', (d) => { d.policies[0].polqual = 'false'; }],
    ['a relation created', (d) => { d.relations.push({ relname: 'evil', relkind: 'r' }); }],
  ]) {
    const collateral = fakeDb({ onApply });
    const refused = await handlerFor(collateral.connect)(sql81Event());
    assert.equal(refused.code, CODES.UNRELATED_MUTATION, `${label}: ${JSON.stringify(refused)}`);
    assert.equal(collateral.committed.fn.present, false, label);
    assert.ok(collateral.seen.includes('ROLLBACK'), label);
    assert.ok(!collateral.seen.includes('COMMIT'), label);
  }

  const broken = fakeDb({ failOnApply: true });
  const failed = await handlerFor(broken.connect)(sql81Event());
  assert.equal(failed.code, CODES.UNRELATED_MUTATION);
  assert.equal(broken.committed.fn.present, false);
  assert.ok(broken.seen.includes('ROLLBACK'));
});

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const OWNER = 'a1000000-0000-4000-8000-0000000000f1';
const A_ADMIN = 'a1000000-0000-4000-8000-0000000000ad';

/** checkalt_tenant_accounts as SQL 81 expects it (no table write grant), owned by the non-superuser executor role. */
const STAGING_SCHEMA = (owner) => `
  CREATE TABLE public.checkalt_tenant_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE UNIQUE,
    sso_user_id text NOT NULL,
    deposit_account_number text NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    registered_at timestamptz,
    last_register_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    auto_approve_enabled boolean NOT NULL DEFAULT false,
    auto_approve_max_cents integer);
  REVOKE ALL ON TABLE public.checkalt_tenant_accounts FROM checksops, authenticated;
  GRANT SELECT ON TABLE public.checkalt_tenant_accounts TO checksops;
  ALTER TABLE public.checkalt_tenant_accounts ENABLE ROW LEVEL SECURITY;
  -- Like the AWS database user: a non-superuser that owns the table and runs SQL 81.
  CREATE ROLE ${owner} LOGIN NOSUPERUSER;
  GRANT USAGE, CREATE ON SCHEMA public TO ${owner};
  GRANT USAGE ON SCHEMA auth TO ${owner};
  GRANT SELECT ON public.tenants, public.tenant_users, public.identity_accounts, public.user_roles TO ${owner};
  ALTER TABLE public.checkalt_tenant_accounts OWNER TO ${owner};
  INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A');
  INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
    ('${OWNER}', 'checksopsadmin@gmail.com', 'active'), ('${A_ADMIN}', 'admin@a.example', 'active');
  INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_A}', '${A_ADMIN}', 'admin');
`;

test('PostgreSQL 16: the real catalog matches both pinned hashes; the handler applies SQL 81 once and refuses everything else', {
  timeout: 180000,
}, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql81-exec-', 56400);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await applyBaseSchema(admin);
    await admin.query(STAGING_SCHEMA('sql81_owner'));
    const fn = CHECKALT_REGISTER_FUNCTION;
    const register = async (user, account) => {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE checksops');
        await admin.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const { rows } = await admin.query(`SELECT ${fn.replace('(uuid, jsonb)', '')}($1::uuid, $2::jsonb) AS r`, [TENANT_A, JSON.stringify(account)]);
        await admin.query('COMMIT');
        return rows[0].r;
      } catch (error) {
        await admin.query('ROLLBACK');
        return { error: error.message };
      }
    };
    const account = { sso_user_id: 'dep-1', first_name: 'A', last_name: 'B', email: 'a@b.example', deposit_account_number: '123456789' };
    assert.match((await register(OWNER, account)).error, /does not exist/);

    const handler = handlerFor(() => connectAs('sql81_owner'));
    const inspect = async () => handler(sql81Event({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));

    const before = await inspect();
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.details.receipt.live_definition_sha256, PIN.expected_live_definition_sha256, JSON.stringify(before.details.receipt));
    assert.deepEqual(before.details.receipt.function_states, { definition: 'absent', comment: 'absent' });
    assert.equal(before.details.receipt.required_columns_present, true);
    assert.equal(before.details.receipt.table_update_granted, false);
    assert.equal(before.details.receipt.table_insert_granted, false);
    assert.equal(before.details.receipt.apply_preconditions_met, true, JSON.stringify(before.details.receipt));

    const refusedThenRestored = async (label, breakIt, restore) => {
      await admin.query(breakIt);
      const refused = await inspect();
      assert.equal(refused.ok, true, `${label}: ${JSON.stringify(refused)}`);
      assert.equal(refused.details.receipt.apply_preconditions_met, false, label);
      const applyRefused = await handler(sql81Event());
      assert.equal(applyRefused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(applyRefused)}`);
      await admin.query(restore);
      assert.equal((await inspect()).details.receipt.apply_preconditions_met, true, label);
    };
    await refusedThenRestored('an overload',
      'CREATE FUNCTION public.aws_register_checkalt_tenant_account(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
      'DROP FUNCTION public.aws_register_checkalt_tenant_account(uuid)');
    await refusedThenRestored('the same signature in another schema',
      'CREATE FUNCTION auth.aws_register_checkalt_tenant_account(uuid, jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
      'DROP FUNCTION auth.aws_register_checkalt_tenant_account(uuid, jsonb)');
    await refusedThenRestored('table INSERT for checksops', 'GRANT INSERT ON public.checkalt_tenant_accounts TO checksops', 'REVOKE INSERT ON public.checkalt_tenant_accounts FROM checksops');
    await refusedThenRestored('column UPDATE for authenticated', 'GRANT UPDATE (email) ON public.checkalt_tenant_accounts TO authenticated', 'REVOKE UPDATE (email) ON public.checkalt_tenant_accounts FROM authenticated');
    await refusedThenRestored('a missing column', 'ALTER TABLE public.checkalt_tenant_accounts RENAME COLUMN last_register_payload TO payload', 'ALTER TABLE public.checkalt_tenant_accounts RENAME COLUMN payload TO last_register_payload');
    await refusedThenRestored('no unique tenant_id',
      'ALTER TABLE public.checkalt_tenant_accounts DROP CONSTRAINT checkalt_tenant_accounts_tenant_id_key',
      'ALTER TABLE public.checkalt_tenant_accounts ADD CONSTRAINT checkalt_tenant_accounts_tenant_id_key UNIQUE (tenant_id)');

    const event = sql81Event();
    const applied = await handler(event);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PIN.expected_live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.details.receipt.live_definition_sha256, PIN.intended_replacement_sha256);
    assert.equal(after.details.receipt.function_definition_sha256, CHECKALT_REGISTER_DEFINITION_SHA256.sql81);
    assert.deepEqual(after.details.receipt.function_states, { definition: 'intended', comment: 'intended' });
    assert.equal(after.details.receipt.security_definer, true);
    assert.equal(after.details.receipt.config_as_reviewed, true);
    assert.equal(after.details.receipt.owner_is_executor, true);
    assert.equal(after.details.receipt.acl_as_expected, true);
    assert.equal(after.details.receipt.apply_preconditions_met, false);
    const real = (await admin.query(`SELECT pg_get_functiondef('${fn}'::regprocedure) AS d, obj_description('${fn}'::regprocedure, 'pg_proc') AS c,
      proacl::text AS acl, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = '${fn}'::regprocedure`)).rows[0];
    assert.equal(real.d, DEF81);
    assert.equal(real.c, COMMENT81);
    assert.equal(real.owner, 'sql81_owner');
    assert.equal(real.acl, '{sql81_owner=X/sql81_owner,checksops=X/sql81_owner,authenticated=X/sql81_owner}');
    assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
    const reapply = await handler(sql81Event());
    assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
    assert.match(reapply.message, /already in place/);

    // SQL 81 behavior: the platform owner registers; a tenant admin is refused; the result is last four only.
    const ok = await register(OWNER, account);
    assert.equal(ok.account_last4, '6789', JSON.stringify(ok));
    assert.equal(JSON.stringify(ok).includes('123456789'), false);
    assert.equal((await register(A_ADMIN, account)).error, 'not_authorized');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.checkalt_tenant_accounts')).rows[0].n, 1);
  } finally {
    await admin.end();
    server.stop();
  }
});

test('a failing statement inside the apply transaction leaves the function absent (PostgreSQL 16)', { timeout: 180000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql81-rollback-', 56450);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  try {
    await applyBaseSchema(admin);
    await admin.query(STAGING_SCHEMA('sql81_owner'));
    // The CREATE succeeds, but the GRANT in SQL 81 names a missing role half-way through the file; nothing may stick.
    const handler = handlerFor(async () => {
      const client = new pg.Client({ host: server.host, port: server.port, user: 'sql81_owner', database: 'postgres' });
      await client.connect();
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql).includes('GRANT EXECUTE ON FUNCTION')
        ? query(`${String(sql).replace('TO checksops, authenticated;', 'TO checksops, sql81_missing_role;')}`, params)
        : query(sql, params));
      return client;
    });
    const result = await handler(sql81Event());
    assert.equal(result.code, CODES.UNRELATED_MUTATION, JSON.stringify(result));
    const row = (await admin.query(`SELECT to_regprocedure('${CHECKALT_REGISTER_FUNCTION}') AS p,
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'aws_register_checkalt_tenant_account') AS n`)).rows[0];
    assert.deepEqual(row, { p: null, n: 0 });
  } finally {
    await admin.end();
    server.stop();
  }
});
