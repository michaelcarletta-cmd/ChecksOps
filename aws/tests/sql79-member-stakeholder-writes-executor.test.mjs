/**
 * Staging VPC executor support for SQL 79 (tenant-member INSERT and DELETE
 * policies on public.check_stakeholders and
 * public.check_partner_stakeholder_removals).
 *
 * Both hashes are code-derived from the repo's policy and function files: the
 * pre-apply state is what SQL 12/24/77/78 leave, the intended state adds the
 * four member policies. The PostgreSQL 16 test below re-derives both from the
 * real catalog with the real helper files, then applies through the handler.
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
  AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES as PIN,
  AUTHORIZED_STAGING_SQL,
  MEMBER_STAKEHOLDER_APPLIED_STATE,
  MEMBER_STAKEHOLDER_FUNCTION_SHA256,
  MEMBER_STAKEHOLDER_NEW_POLICIES,
  MEMBER_STAKEHOLDER_PRE_STATE,
  MEMBER_STAKEHOLDER_TABLES,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
  memberStakeholderWritesStateText,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { applyBaseSchema, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL_FILE = path.join(ROOT, PIN.filename);
const NOW = '2026-10-14T19:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const [STAKEHOLDERS, REMOVALS] = MEMBER_STAKEHOLDER_TABLES;
const NEW_POLICY_NAMES = MEMBER_STAKEHOLDER_TABLES.flatMap((table) => MEMBER_STAKEHOLDER_NEW_POLICIES[table].map((p) => p.name));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler, SQL79_NORMALIZED_STATEMENTS } = executorModule;

function memberEvent(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql79-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const event = {
    action: 'apply',
    workstream_id: 'staging-sql79-member-stakeholder-writes',
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
    expiry: '2026-10-14T20:00:00.000Z',
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
    `sql79-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile79: SQL_FILE, ...extra });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};

test('pin matches the SQL file and its commit; both hashes are the code-derived pre and applied states', () => {
  const text = fs.readFileSync(SQL_FILE, 'utf8');
  assert.equal(sha(fs.readFileSync(SQL_FILE)), PIN.source_sha256);
  assert.equal(PIN.expected_live_definition_sha256, sha(memberStakeholderWritesStateText(MEMBER_STAKEHOLDER_PRE_STATE)));
  assert.equal(PIN.expected_live_definition_sha256, 'd9bc8921d75864abe9af5bf404f237fb561bc2c1cad21339e7f60decd0a6f0a4');
  assert.equal(PIN.intended_replacement_sha256, sha(memberStakeholderWritesStateText(MEMBER_STAKEHOLDER_APPLIED_STATE)));
  assert.equal(PIN.intended_replacement_sha256, 'c9c41944e66025b9b1175855a3d4f2f7e26c657f8fb908eb44930c79bd930ef6');
  assert.equal(text.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim(), SQL79_NORMALIZED_STATEMENTS);
  const body = text.replace(/^--.*$/gm, '');
  assert.doesNotMatch(body, /UPDATE|DROP |GRANT|ALTER|SECURITY DEFINER|aws_can_write_tenant|aws_is_cross_tenant_reader|aws_financial_execution_active| OR /i);
  assert.equal((body.match(/CREATE POLICY/g) || []).length, 4);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(MIGRATIONS['sql79-member-stakeholder-writes'], PIN);
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === PIN.filename && to === 'sql/79_member_stakeholder_writes.sql'));
  assert.equal(evaluateSqlExecutorAuthorization(memberEvent(), { now: Date.parse(NOW) }).ok, true);
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), PIN.source_sha256);
  // aws_user_tenant_ids() is pinned to the tenant_users-only body in aws/rls/sql/02_helpers.sql.
  const helpers = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/02_helpers.sql'), 'utf8');
  assert.match(helpers, /FUNCTION public\.aws_user_tenant_ids\(\)[\s\S]*?FROM public\.tenant_users tu\s+WHERE tu\.user_id = auth\.uid\(\);\s+\$\$;/);
});

test('apply refuses before connecting: unreviewed pin, read-live sentinel, wrong hash, forged pin, tampered file', async () => {
  const unreviewed = await handlerFor(neverConnect, { sql79Pin: { ...PIN, expected_live_definition_sha256: null } })(memberEvent());
  assert.equal(unreviewed.code, CODES.SQL_COLLISION);
  assert.match(unreviewed.message, /no reviewed pre-apply live definition hash/);
  const sentinel = await handlerFor(neverConnect)(memberEvent({ expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
  assert.equal(sentinel.code, CODES.SQL_COLLISION);
  assert.match(sentinel.message, /bound to the exact allowlisted pin/);
  const other = await handlerFor(neverConnect)(memberEvent({ expected_live_definition_sha256: 'b'.repeat(64) }));
  assert.equal(other.code, CODES.SQL_COLLISION);
  const wrongIntended = await handlerFor(neverConnect)(memberEvent({ intended_replacement_sha256: 'c'.repeat(64) }));
  assert.equal(wrongIntended.ok, false);
  const forged = await handlerFor(neverConnect, { sql79Pin: { ...PIN, intended_replacement_sha256: 'c'.repeat(64) } })(memberEvent());
  assert.equal(forged.code, CODES.SQL_COLLISION);
  assert.match(forged.message, /committed allowlist entry/);
  const unsupported = await handlerFor(neverConnect)(memberEvent({ action: 'drop' }));
  assert.equal(unsupported.ok, false);
  for (const extra of [
    'CREATE POLICY open ON public.check_stakeholders FOR UPDATE TO authenticated USING (true);\n',
    'ALTER TABLE public.check_stakeholders DISABLE ROW LEVEL SECURITY;\n',
    'GRANT UPDATE ON TABLE public.check_stakeholders TO checksops;\n',
  ]) {
    const tampered = path.join(os.tmpdir(), `sql79-tampered-${process.pid}.sql`);
    fs.writeFileSync(tampered, `${fs.readFileSync(SQL_FILE, 'utf8')}${extra}`);
    try {
      const result = await handlerFor(neverConnect, { sqlFile79: tampered })(memberEvent());
      assert.equal(result.code, CODES.SQL_COLLISION, extra);
    } finally {
      fs.rmSync(tampered, { force: true });
    }
  }
});

const clone = (value) => JSON.parse(JSON.stringify(value));
// pg_get_functiondef on PostgreSQL 16 for aws/rls/sql/02_helpers.sql and 20_write_helpers.sql.
const FUNCTION_DEFS = Object.freeze({
  'public.aws_user_tenant_ids()': "CREATE OR REPLACE FUNCTION public.aws_user_tenant_ids()\n RETURNS SETOF uuid\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO 'public'\n SET row_security TO 'off'\nAS $function$\n  SELECT tu.tenant_id\n  FROM public.tenant_users tu\n  WHERE tu.user_id = auth.uid();\n$function$\n",
  'public.aws_is_authenticated()': "CREATE OR REPLACE FUNCTION public.aws_is_authenticated()\n RETURNS boolean\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO 'public'\n SET row_security TO 'off'\nAS $function$\n  SELECT auth.uid() IS NOT NULL;\n$function$\n",
});
const ACL = () => ['authenticated', 'checksops'].flatMap((grantee) => ['DELETE', 'INSERT', 'SELECT']
  .map((privilege_type) => ({ grantee, privilege_type, is_grantable: false })));
const tableRow = (table, withNew) => ({
  present: true,
  rls_enabled: true,
  rls_forced: false,
  owner_is_executor: true,
  policies: clone((withNew ? MEMBER_STAKEHOLDER_APPLIED_STATE : MEMBER_STAKEHOLDER_PRE_STATE).tables[table].policies),
  acl: ACL(),
  bypasses: false,
});

/**
 * Fake catalog. Running the embedded file adds the four member policies
 * (onApply may then change the working copy); ROLLBACK discards it.
 */
function fakeDb({ applied = false, mutate, functions = FUNCTION_DEFS, executable = true, roles = true, onApply, failOnApply = false } = {}) {
  let committed = {
    tables: Object.fromEntries(MEMBER_STAKEHOLDER_TABLES.map((table) => [table, tableRow(table, applied)])),
    functions: { ...functions },
    relations: [{ relname: 'tenants', relkind: 'r' }, { relname: 'tenants_pkey', relkind: 'i' }],
    otherPolicies: [{ table_name: 'public.tenants', polname: 'aws_select_tenants', polcmd: 'r', polpermissive: true, polroles: '{16385}', polqual: 'true', polwithcheck: null }],
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
      query: async (sql, params = []) => {
        const text = String(sql);
        seen.push(text);
        const db = current();
        const t = db.tables[params[0]];
        if (text === 'BEGIN' || text === 'BEGIN READ ONLY') { working = clone(committed); return { rows: [] }; }
        if (text.startsWith('SET LOCAL lock_timeout')) return { rows: [] };
        if (text === 'COMMIT') { committed = working; working = null; return { rows: [] }; }
        if (text === 'ROLLBACK') { working = null; return { rows: [] }; }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (text.includes("set_config('search_path'")) return { rows: [{ set_config: 'pg_catalog' }] };
        if (text.includes('AS required_roles_present')) return { rows: [{ required_roles_present: roles }] };
        if (text.includes('AS owner_is_executor')) {
          return { rows: [t?.present ? { present: true, rls_enabled: t.rls_enabled, rls_forced: t.rls_forced, owner_is_executor: t.owner_is_executor } : { present: false, rls_enabled: null, rls_forced: null, owner_is_executor: null }] };
        }
        if (text.includes('AS member_bypasses')) return { rows: [{ member_bypasses: t.bypasses }] };
        if (text.includes('pg_get_functiondef')) {
          const def = db.functions[params[0]] ?? null;
          return { rows: [{ def, executable: def === null ? null : executable }] };
        }
        if (text.includes('polrelid::regclass::text')) return { rows: clone(db.otherPolicies) };
        if (text.includes('relnamespace')) return { rows: clone(db.relations) };
        if (text.includes('FROM pg_policy pol')) return { rows: clone(t.policies) };
        if (text.includes('aclexplode')) return { rows: clone(t.acl) };
        if (text.includes('CREATE POLICY aws_member_insert_check_stakeholders')) {
          if (failOnApply) throw new Error('policy "aws_member_insert_check_stakeholders" for table "check_stakeholders" already exists');
          for (const table of MEMBER_STAKEHOLDER_TABLES) db.tables[table].policies.push(...clone(MEMBER_STAKEHOLDER_NEW_POLICIES[table]));
          if (onApply) onApply(db);
          return { rows: [] };
        }
        throw new Error(`unexpected SQL ${text.slice(0, 60)}`);
      },
    }),
  };
}

test('inspect only SELECTs and reports the pre-apply state; a pin without an expected hash is not executable', async () => {
  const db = fakeDb();
  const inspect = await handlerFor(db.connect)(memberEvent({
    action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
  }));
  assert.equal(inspect.ok, true, JSON.stringify(inspect));
  const receipt = inspect.details.receipt;
  assert.equal(receipt.live_definition_sha256, PIN.expected_live_definition_sha256);
  assert.equal(receipt.apply_preconditions_met, true);
  assert.equal(receipt.before_hash, receipt.after_hash);
  assert.equal(receipt.tables_present, true);
  assert.equal(receipt.rls_enabled, true);
  assert.equal(receipt.reviewed_policies_as_expected, true);
  assert.deepEqual(receipt.member_policy_states, Object.fromEntries(NEW_POLICY_NAMES.map((name) => [name, 'absent'])));
  assert.equal(receipt.other_policy_count, 0);
  assert.equal(receipt.required_functions_present, true);
  assert.equal(receipt.functions_executable, true);
  assert.equal(receipt.grantee_bypasses_rls, false);
  assert.equal(receipt.update_granted, false);
  assert.equal(receipt.write_grants_present, true);
  assert.equal(receipt.prerequisites_ok, true);
  assert.equal(receipt.pin_executable, true);
  assert.equal(db.seen[0], 'BEGIN READ ONLY');
  assert.equal(db.seen.at(-1), 'ROLLBACK');
  assert.ok(db.seen.slice(1, -1).every((text) => /^\s*(SELECT|WITH)\b/i.test(text)), JSON.stringify(db.seen));

  const unreviewed = await handlerFor(fakeDb().connect, { sql79Pin: { ...PIN, expected_live_definition_sha256: null } })(memberEvent({
    action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
  }));
  assert.equal(unreviewed.details.receipt.pin_executable, false);
  assert.equal(unreviewed.details.receipt.apply_preconditions_met, false);

  const applied = await handlerFor(fakeDb({ applied: true }).connect)(memberEvent({ action: 'inspect' }));
  assert.equal(applied.details.receipt.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.equal(applied.details.receipt.member_policies_present, true);
  assert.equal(applied.details.receipt.apply_preconditions_met, false);
});

test('apply adds exactly the four policies once; replay, re-create, drift, prerequisites and collateral changes are refused', async () => {
  for (const [signature, def] of Object.entries(FUNCTION_DEFS)) assert.equal(sha(def), MEMBER_STAKEHOLDER_FUNCTION_SHA256[signature]);
  const db = fakeDb();
  const handler = handlerFor(db.connect);
  const event = memberEvent();
  const applied = await handler(event);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, PIN.expected_live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(applied.details.receipt.member_policy_states, Object.fromEntries(NEW_POLICY_NAMES.map((name) => [name, 'present'])));
  assert.equal(db.seen[db.seen.indexOf('BEGIN') + 1], "SET LOCAL lock_timeout = '5s'");
  assert.ok(db.seen[db.seen.indexOf('BEGIN') + 2].includes('pg_advisory_xact_lock'));
  assert.equal(db.committed.tables[STAKEHOLDERS].policies.length, 4);
  assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
  const again = await handler(memberEvent());
  assert.equal(again.code, CODES.UNRELATED_MUTATION);
  assert.match(again.message, /already in place/);

  // aws_user_tenant_ids() widened (e.g. to shared tenants) reads as drift.
  const widened = fakeDb({ functions: { ...FUNCTION_DEFS, 'public.aws_user_tenant_ids()': FUNCTION_DEFS['public.aws_user_tenant_ids()'].replace('auth.uid();', 'auth.uid() UNION SELECT target_tenant_id FROM public.shared_checks;') } });
  const driftRefused = await handlerFor(widened.connect)(memberEvent());
  assert.equal(driftRefused.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(!widened.seen.some((text) => text.includes('CREATE POLICY')));

  for (const [label, options] of [
    ['RLS off on check_stakeholders', { mutate: (d) => { d.tables[STAKEHOLDERS].rls_enabled = false; } }],
    ['extra permissive policy', { mutate: (d) => { d.tables[REMOVALS].policies.push({ name: 'open', permissive: true, cmd: 'ALL', roles: ['public'], using: 'true', with_check: 'true' }); } }],
    ['write policy loosened', { mutate: (d) => { d.tables[STAKEHOLDERS].policies[1].using = 'true'; } }],
    ['another owner', { mutate: (d) => { d.tables[REMOVALS].owner_is_executor = false; } }],
    ['removals table missing', { mutate: (d) => { d.tables[REMOVALS] = { present: false, policies: [], acl: [], bypasses: true }; } }],
    ['UPDATE granted', { mutate: (d) => { d.tables[STAKEHOLDERS].acl.push({ grantee: 'checksops', privilege_type: 'UPDATE', is_grantable: false }); } }],
    ['a grantee bypasses RLS', { mutate: (d) => { d.tables[STAKEHOLDERS].bypasses = true; } }],
    ['bypass unknown', { mutate: (d) => { d.tables[REMOVALS].bypasses = null; } }],
    ['function missing', { functions: { ...FUNCTION_DEFS, 'public.aws_user_tenant_ids()': null } }],
    ['function not executable', { executable: false }],
    ['grantee role missing', { roles: false }],
  ]) {
    const blocked = fakeDb(options);
    const inspected = await handlerFor(blocked.connect)(memberEvent({ action: 'inspect' }));
    assert.equal(inspected.details.receipt.apply_preconditions_met, false, label);
    const refused = await handlerFor(blocked.connect)(memberEvent());
    assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, label);
    assert.ok(!blocked.seen.some((text) => text.includes('CREATE POLICY')), label);
  }

  // One member policy already there (any shape): never re-created.
  const partial = fakeDb({ mutate: (d) => { d.tables[STAKEHOLDERS].policies.push(clone(MEMBER_STAKEHOLDER_NEW_POLICIES[STAKEHOLDERS][0])); } });
  const partialRefused = await handlerFor(partial.connect)(memberEvent());
  assert.equal(partialRefused.code, CODES.UNRELATED_MUTATION);
  assert.match(partialRefused.message, /already in place/);
  assert.ok(!partial.seen.some((text) => text.includes('CREATE POLICY')));

  for (const [label, onApply] of [
    ['a member policy loosened', (d) => { d.tables[STAKEHOLDERS].policies.at(-1).using = 'true'; }],
    ['an extra policy', (d) => { d.tables[REMOVALS].policies.push({ name: 'open', permissive: true, cmd: 'UPDATE', roles: ['authenticated'], using: 'true', with_check: 'true' }); }],
    ['a grant changed', (d) => { d.tables[REMOVALS].acl.push({ grantee: 'anon', privilege_type: 'SELECT', is_grantable: false }); }],
    ['UPDATE granted', (d) => { d.tables[STAKEHOLDERS].acl.push({ grantee: 'checksops', privilege_type: 'UPDATE', is_grantable: false }); }],
    ['RLS turned off', (d) => { d.tables[STAKEHOLDERS].rls_enabled = false; }],
    ['another relation created', (d) => { d.relations.push({ relname: 'evil', relkind: 'r' }); }],
    ['another table policy changed', (d) => { d.otherPolicies[0].polqual = 'false'; }],
    ['a function redefined', (d) => { d.functions['public.aws_is_authenticated()'] = 'CREATE FUNCTION x'; }],
  ]) {
    const collateral = fakeDb({ onApply });
    const refused = await handlerFor(collateral.connect)(memberEvent());
    assert.equal(refused.code, CODES.UNRELATED_MUTATION, label);
    assert.equal(collateral.committed.tables[STAKEHOLDERS].policies.length, 2, label);
    assert.ok(collateral.seen.includes('ROLLBACK'), label);
  }

  const broken = fakeDb({ failOnApply: true });
  const failed = await handlerFor(broken.connect)(memberEvent());
  assert.equal(failed.code, CODES.UNRELATED_MUTATION);
  assert.equal(broken.committed.tables[STAKEHOLDERS].policies.length, 2);
});

test('PostgreSQL 16: the real catalog matches both pinned hashes; the handler applies SQL 79 once and refuses everything else', {
  timeout: 180000,
}, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql79-', 54900);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await applyBaseSchema(admin);
    // Like the AWS database user: a non-superuser that owns both tables.
    await admin.query('CREATE ROLE sql79_owner LOGIN NOSUPERUSER');
    await admin.query('GRANT USAGE ON SCHEMA public TO sql79_owner');
    for (const table of MEMBER_STAKEHOLDER_TABLES) await admin.query(`ALTER TABLE ${table} OWNER TO sql79_owner`);
    const handler = handlerFor(() => connectAs('sql79_owner'));
    const inspect = async () => handler(memberEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));

    const before = await inspect();
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.details.receipt.live_definition_sha256, PIN.expected_live_definition_sha256, JSON.stringify(before.details.receipt));
    assert.deepEqual(before.details.receipt.function_definition_sha256, MEMBER_STAKEHOLDER_FUNCTION_SHA256);
    assert.equal(before.details.receipt.apply_preconditions_met, true, JSON.stringify(before.details.receipt));
    assert.equal(before.details.receipt.write_grants_present, true);

    const refusedThenRestored = async (label, breakIt, restore) => {
      await breakIt();
      const refused = await inspect();
      assert.equal(refused.ok, true, `${label}: ${JSON.stringify(refused)}`);
      assert.equal(refused.details.receipt.apply_preconditions_met, false, label);
      const applyRefused = await handler(memberEvent());
      assert.equal(applyRefused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(applyRefused)}`);
      await restore();
      assert.equal((await inspect()).details.receipt.apply_preconditions_met, true, label);
    };
    // aws_user_tenant_ids widened to every tenant a check is shared with: drift.
    const original = (await admin.query("SELECT pg_get_functiondef('public.aws_user_tenant_ids()'::regprocedure) AS d")).rows[0].d;
    await refusedThenRestored('aws_user_tenant_ids redefined',
      () => admin.query(`CREATE OR REPLACE FUNCTION public.aws_user_tenant_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = public SET row_security = off AS $$
        SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid()
        UNION SELECT sc.source_tenant_id FROM public.shared_checks sc JOIN public.tenant_users tu ON tu.tenant_id = sc.target_tenant_id WHERE tu.user_id = auth.uid();
        $$`),
      () => admin.query(original));
    await refusedThenRestored('BYPASSRLS member of authenticated',
      () => admin.query('CREATE ROLE sql79_svc BYPASSRLS IN ROLE authenticated'),
      () => admin.query('DROP ROLE sql79_svc'));
    await refusedThenRestored('extra policy on check_stakeholders',
      () => admin.query('CREATE POLICY sql79_extra ON public.check_stakeholders FOR SELECT TO authenticated USING (true)'),
      () => admin.query('DROP POLICY sql79_extra ON public.check_stakeholders'));
    await refusedThenRestored('UPDATE granted on removals',
      () => admin.query('GRANT UPDATE ON public.check_partner_stakeholder_removals TO checksops'),
      () => admin.query('REVOKE UPDATE ON public.check_partner_stakeholder_removals FROM checksops'));
    await refusedThenRestored('RLS off on removals',
      () => admin.query('ALTER TABLE public.check_partner_stakeholder_removals DISABLE ROW LEVEL SECURITY'),
      () => admin.query('ALTER TABLE public.check_partner_stakeholder_removals ENABLE ROW LEVEL SECURITY'));

    const event = memberEvent();
    const applied = await handler(event);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PIN.expected_live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.details.receipt.live_definition_sha256, PIN.intended_replacement_sha256);
    assert.equal(after.details.receipt.member_policies_present, true);
    assert.equal(after.details.receipt.tenant_guard_ok, true);
    assert.equal(after.details.receipt.apply_preconditions_met, false);
    assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
    const recreate = await handler(memberEvent());
    assert.equal(recreate.code, CODES.UNRELATED_MUTATION);
    assert.match(recreate.message, /already in place/);
    // Re-applying the file by hand fails visibly (plain CREATE POLICY).
    await assert.rejects(admin.query(fs.readFileSync(SQL_FILE, 'utf8')), /already exists/);

    // Grants are unchanged: SELECT, INSERT, DELETE only.
    const { rows: grants } = await admin.query(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_name IN ('check_stakeholders', 'check_partner_stakeholder_removals') AND grantee IN ('checksops', 'authenticated')
      ORDER BY 1, 2, 3`);
    assert.deepEqual(grants.map((r) => r.privilege_type), ['DELETE', 'INSERT', 'SELECT', 'DELETE', 'INSERT', 'SELECT', 'DELETE', 'INSERT', 'SELECT', 'DELETE', 'INSERT', 'SELECT']);
  } finally {
    await admin.end();
    server.stop();
  }
});
