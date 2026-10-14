/**
 * Staging VPC executor support for SQL 78
 * (CREATE TABLE public.check_partner_stakeholder_removals with RLS, two
 * tenant policies and SELECT, INSERT, DELETE for checksops and authenticated).
 *
 * The pre-apply state is "table absent" (a fixed, code-derived hash). The
 * intended hash is the state read back after the file is applied on
 * PostgreSQL 16 by a non-superuser owner, like the AWS database user; the
 * PostgreSQL 16 test below re-derives it from the real catalog.
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
  AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS as PIN,
  AUTHORIZED_STAGING_SQL,
  PARTNER_STAKEHOLDER_REMOVALS_ABSENT_TEXT,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
  partnerStakeholderRemovalsStateText,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SQL_FILE = path.join(ROOT, PIN.filename);
const NOW = '2026-10-14T17:30:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');

const ABSENT_SHA256 = sha(PARTNER_STAKEHOLDER_REMOVALS_ABSENT_TEXT);

// The catalog as PostgreSQL 16 reports it right after the file runs.
const SELECT_POLICY = Object.freeze({
  name: 'aws_select_check_partner_stakeholder_removals', permissive: true, cmd: 'SELECT', roles: ['authenticated'],
  using: '(public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id))', with_check: null,
});
const WRITE_POLICY = Object.freeze({
  name: 'aws_write_check_partner_stakeholder_removals', permissive: true, cmd: 'ALL', roles: ['authenticated'],
  using: 'public.aws_can_write_tenant(tenant_id)', with_check: 'public.aws_can_write_tenant(tenant_id)',
});
const APPLIED = Object.freeze({
  present: true,
  columns: [
    { name: 'id', type: 'uuid', not_null: true, default: 'gen_random_uuid()' },
    { name: 'check_intake_item_id', type: 'uuid', not_null: true, default: null },
    { name: 'tenant_id', type: 'uuid', not_null: true, default: null },
    { name: 'partner_tenant_id', type: 'uuid', not_null: true, default: null },
    { name: 'removed_by', type: 'uuid', not_null: false, default: null },
    { name: 'created_at', type: 'timestamp with time zone', not_null: true, default: 'now()' },
  ],
  constraints: [
    { name: 'check_partner_stakeholder_removals_check_intake_item_id_fkey', def: 'FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE CASCADE' },
    { name: 'check_partner_stakeholder_removals_not_self', def: 'CHECK ((partner_tenant_id <> tenant_id))' },
    { name: 'check_partner_stakeholder_removals_partner_tenant_id_fkey', def: 'FOREIGN KEY (partner_tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE' },
    { name: 'check_partner_stakeholder_removals_pkey', def: 'PRIMARY KEY (id)' },
    { name: 'check_partner_stakeholder_removals_removed_by_fkey', def: 'FOREIGN KEY (removed_by) REFERENCES public.identity_accounts(application_user_id)' },
    { name: 'check_partner_stakeholder_removals_tenant_id_fkey', def: 'FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE' },
    { name: 'check_partner_stakeholder_removals_unique', def: 'UNIQUE (check_intake_item_id, partner_tenant_id)' },
  ],
  rls_enabled: true,
  rls_forced: false,
  policies: [SELECT_POLICY, WRITE_POLICY],
  acl: ['authenticated', 'checksops'].flatMap((grantee) => ['DELETE', 'INSERT', 'SELECT'].map((privilege) => ({ grantee, privilege, grantable: false }))),
  owner_is_executor: true,
});
const APPLIED_SHA256 = sha(partnerStakeholderRemovalsStateText(APPLIED));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler, SQL78_NORMALIZED_STATEMENTS } = executorModule;

function removalsEvent(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql78-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const event = {
    action: 'apply',
    workstream_id: 'staging-sql78-check-partner-stakeholder-removals',
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
    expected_live_definition_sha256: ABSENT_SHA256,
    one_use_id: oneUse,
    expiry: '2026-10-14T18:30:00.000Z',
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
    `sql78-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile78: SQL_FILE, ...extra });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};

test('pin matches the SQL file and its commit; expected is the absent state; intended is the PostgreSQL 16 applied state', () => {
  const text = fs.readFileSync(SQL_FILE, 'utf8');
  assert.equal(sha(fs.readFileSync(SQL_FILE)), PIN.source_sha256);
  assert.equal(PIN.expected_live_definition_sha256, ABSENT_SHA256);
  assert.equal(PIN.expected_live_definition_sha256, '4031dea6c0fbb70af1b17befa7ffb161fec40227cda080cd87c222dec674d269');
  assert.equal(PIN.intended_replacement_sha256, APPLIED_SHA256);
  assert.equal(PIN.intended_replacement_sha256, 'd9f75f8e7327f5fc5b2a45adeb47ceb6ac20c3237ae7660ab1235eddcf501430');
  assert.equal(text.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim(), SQL78_NORMALIZED_STATEMENTS);
  assert.doesNotMatch(text.replace(/^--.*$/gm, ''), /UPDATE|SECURITY DEFINER|BYPASSRLS|DROP /);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(MIGRATIONS['sql78-check-partner-stakeholder-removals'], PIN);
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === PIN.filename && to === 'sql/78_check_partner_stakeholder_removals.sql'));
  assert.equal(evaluateSqlExecutorAuthorization(removalsEvent(), { now: Date.parse(NOW) }).ok, true);
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), PIN.source_sha256);
});

test('apply refuses before connecting: unreviewed pin, read-live sentinel, wrong hash, forged pin, tampered file', async () => {
  const unreviewed = await handlerFor(neverConnect, { sql78Pin: { ...PIN, expected_live_definition_sha256: null } })(removalsEvent());
  assert.equal(unreviewed.code, CODES.SQL_COLLISION);
  assert.match(unreviewed.message, /no reviewed pre-apply live definition hash/);
  const sentinel = await handlerFor(neverConnect)(removalsEvent({ expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
  assert.equal(sentinel.code, CODES.SQL_COLLISION);
  assert.match(sentinel.message, /bound to the exact allowlisted pin/);
  const other = await handlerFor(neverConnect)(removalsEvent({ expected_live_definition_sha256: 'b'.repeat(64) }));
  assert.equal(other.code, CODES.SQL_COLLISION);
  const wrongIntended = await handlerFor(neverConnect)(removalsEvent({ intended_replacement_sha256: 'c'.repeat(64) }));
  assert.equal(wrongIntended.ok, false);
  const forged = await handlerFor(neverConnect, { sql78Pin: { ...PIN, intended_replacement_sha256: 'c'.repeat(64) } })(removalsEvent());
  assert.equal(forged.code, CODES.SQL_COLLISION);
  assert.match(forged.message, /committed allowlist entry/);
  const unsupported = await handlerFor(neverConnect)(removalsEvent({ action: 'drop' }));
  assert.equal(unsupported.ok, false);
  for (const extra of [
    'GRANT UPDATE ON TABLE public.check_partner_stakeholder_removals TO checksops;\n',
    'ALTER TABLE public.check_partner_stakeholder_removals DISABLE ROW LEVEL SECURITY;\n',
    'GRANT ALL ON TABLE public.payment_transfers TO authenticated;\n',
  ]) {
    const tampered = path.join(os.tmpdir(), `sql78-tampered-${process.pid}.sql`);
    fs.writeFileSync(tampered, `${fs.readFileSync(SQL_FILE, 'utf8')}${extra}`);
    try {
      const result = await handlerFor(neverConnect, { sqlFile78: tampered })(removalsEvent());
      assert.equal(result.code, CODES.SQL_COLLISION, extra);
    } finally {
      fs.rmSync(tampered, { force: true });
    }
  }
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const PREREQS = Object.freeze({
  required_tables_present: true,
  required_functions_present: true,
  required_roles_present: true,
  references_granted: true,
  schema_create_granted: true,
});

/**
 * Fake catalog. Running the embedded file creates the table in the APPLIED
 * shape (onApply may then change the working copy); ROLLBACK discards it.
 */
function fakeDb({ present = false, table = APPLIED, prereqs = PREREQS, bypasses = false, onApply, failOnApply = false } = {}) {
  let committed = {
    present,
    table: clone(table),
    relations: [{ relname: 'tenants', relkind: 'r' }, { relname: 'tenants_pkey', relkind: 'i' }],
    otherPolicies: [{ table_name: 'public.tenants', polname: 'aws_select_tenants', polcmd: 'r', polpermissive: true, polroles: '{16385}', polqual: 'true', polwithcheck: null }],
  };
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
        const t = db.table;
        if (text === 'BEGIN') { working = clone(committed); return { rows: [] }; }
        if (text === 'COMMIT') { committed = working; working = null; return { rows: [] }; }
        if (text === 'ROLLBACK') { working = null; return { rows: [] }; }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (text.includes("set_config('search_path'")) return { rows: [{ set_config: 'pg_catalog' }] };
        if (text.includes('AS removals_present')) return { rows: [{ removals_present: db.present }] };
        if (text.includes('AS required_tables_present')) return { rows: [{ ...prereqs }] };
        if (text.includes('AS removals_bypasses')) return { rows: [{ removals_bypasses: bypasses }] };
        if (text.includes('polrelid::regclass::text')) return { rows: clone(db.otherPolicies) };
        if (text.includes('relnamespace')) return { rows: clone(db.relations) };
        if (text.includes('FROM pg_attribute a')) {
          return { rows: db.present ? t.columns.map((c) => ({ name: c.name, type: c.type, not_null: c.not_null, default_expr: c.default })) : [] };
        }
        if (text.includes('pg_get_constraintdef')) return { rows: db.present ? clone(t.constraints) : [] };
        if (text.includes('AS rls_forced')) {
          return { rows: db.present ? [{ rls_enabled: t.rls_enabled, rls_forced: t.rls_forced, owner_is_executor: t.owner_is_executor }] : [] };
        }
        if (text.includes('FROM pg_policy pol')) return { rows: db.present ? clone(t.policies) : [] };
        if (text.includes('aclexplode')) {
          return { rows: db.present ? t.acl.map((row) => ({ grantee: row.grantee, privilege_type: row.privilege, is_grantable: row.grantable })) : [] };
        }
        if (text.includes('CREATE TABLE public.check_partner_stakeholder_removals')) {
          if (failOnApply) throw new Error('relation "public.identity_accounts" does not exist');
          db.present = true;
          db.table = clone(APPLIED);
          if (onApply) onApply(db);
          return { rows: [] };
        }
        throw new Error(`unexpected SQL ${text.slice(0, 60)}`);
      },
    }),
  };
}

test('inspect only SELECTs and reports the absent state and prerequisites; a pin without an expected hash is not executable', async () => {
  const db = fakeDb();
  const inspect = await handlerFor(db.connect)(removalsEvent({
    action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
  }));
  assert.equal(inspect.ok, true, JSON.stringify(inspect));
  const receipt = inspect.details.receipt;
  assert.equal(receipt.live_definition_sha256, ABSENT_SHA256);
  assert.equal(receipt.before_hash, receipt.after_hash);
  assert.equal(receipt.table_present, false);
  assert.equal(receipt.prerequisites_ok, true);
  assert.equal(receipt.grantee_bypasses_rls, false);
  assert.equal(receipt.tenant_guard_ok, false);
  assert.equal(receipt.pin_executable, true);
  assert.equal(receipt.apply_preconditions_met, true);
  assert.ok(db.seen.every((text) => /^\s*(SELECT|WITH)\b/i.test(text)), JSON.stringify(db.seen));

  const unreviewed = await handlerFor(fakeDb().connect, { sql78Pin: { ...PIN, expected_live_definition_sha256: null } })(removalsEvent({
    action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
  }));
  assert.equal(unreviewed.details.receipt.pin_executable, false);
  assert.equal(unreviewed.details.receipt.apply_preconditions_met, false);

  const applied = await handlerFor(fakeDb({ present: true }).connect)(removalsEvent({ action: 'inspect' }));
  const after = applied.details.receipt;
  assert.equal(after.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.equal(after.tenant_guard_ok, true);
  assert.equal(after.select_policy_as_expected, true);
  assert.equal(after.write_policy_as_expected, true);
  assert.equal(after.other_policy_count, 0);
  assert.equal(after.update_granted, false);
  assert.equal(after.apply_preconditions_met, false);
});

test('apply creates exactly the reviewed table once; replay, re-create, missing prerequisites and collateral changes are refused', async () => {
  const db = fakeDb();
  const handler = handlerFor(db.connect);
  const event = removalsEvent();
  const applied = await handler(event);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, ABSENT_SHA256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.equal(applied.details.receipt.tenant_guard_ok, true);
  assert.equal(db.committed.present, true);
  assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
  const again = await handler(removalsEvent());
  assert.equal(again.code, CODES.UNRELATED_MUTATION);
  assert.match(again.message, /already in place/);

  for (const [label, options] of [
    ['referenced table missing', { prereqs: { ...PREREQS, required_tables_present: false } }],
    ['policy function missing', { prereqs: { ...PREREQS, required_functions_present: false } }],
    ['grantee role missing', { prereqs: { ...PREREQS, required_roles_present: false } }],
    ['no REFERENCES', { prereqs: { ...PREREQS, references_granted: false } }],
    ['no schema CREATE', { prereqs: { ...PREREQS, schema_create_granted: false } }],
    ['prerequisites unknown', { prereqs: {} }],
    ['a grantee bypasses RLS', { bypasses: true }],
    ['bypass unknown', { bypasses: null }],
  ]) {
    const blocked = fakeDb(options);
    const inspected = await handlerFor(blocked.connect)(removalsEvent({ action: 'inspect' }));
    assert.equal(inspected.details.receipt.apply_preconditions_met, false, label);
    const refused = await handlerFor(blocked.connect)(removalsEvent());
    assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, label);
    assert.equal(blocked.committed.present, false, label);
    assert.ok(!blocked.seen.some((text) => text.includes('CREATE TABLE')), label);
  }

  // A table already there (whatever its shape) is never re-created.
  const different = fakeDb({ present: true, table: { ...APPLIED, rls_enabled: false } });
  assert.equal((await handlerFor(different.connect)(removalsEvent())).code, CODES.UNRELATED_MUTATION);
  assert.ok(!different.seen.some((text) => text.includes('CREATE TABLE')));

  for (const [label, onApply] of [
    ['RLS off', (d) => { d.table.rls_enabled = false; }],
    ['extra permissive policy', (d) => { d.table.policies.push({ name: 'open', permissive: true, cmd: 'ALL', roles: ['public'], using: 'true', with_check: 'true' }); }],
    ['select policy loosened', (d) => { d.table.policies[0] = { ...SELECT_POLICY, using: 'true' }; }],
    ['write policy without schema', (d) => { d.table.policies[1] = { ...WRITE_POLICY, using: 'aws_can_write_tenant(tenant_id)', with_check: 'aws_can_write_tenant(tenant_id)' }; }],
    ['UPDATE granted too', (d) => { d.table.acl.push({ grantee: 'checksops', privilege: 'UPDATE', grantable: false }); }],
    ['PUBLIC kept a grant', (d) => { d.table.acl.push({ grantee: 'PUBLIC', privilege: 'SELECT', grantable: false }); }],
    ['grant option', (d) => { d.table.acl[0].grantable = true; }],
    ['other owner', (d) => { d.table.owner_is_executor = false; }],
    ['extra column', (d) => { d.table.columns.push({ name: 'note', type: 'text', not_null: false, default: null }); }],
    ['constraint dropped', (d) => { d.table.constraints.pop(); }],
    ['another relation created', (d) => { d.relations.push({ relname: 'evil', relkind: 'r' }); }],
    ['another table policy changed', (d) => { d.otherPolicies[0].polqual = 'false'; }],
  ]) {
    const collateral = fakeDb({ onApply });
    const refused = await handlerFor(collateral.connect)(removalsEvent());
    assert.equal(refused.code, CODES.UNRELATED_MUTATION, label);
    assert.equal(collateral.committed.present, false, label);
    assert.ok(collateral.seen.includes('ROLLBACK'), label);
  }

  const broken = fakeDb({ failOnApply: true });
  const failed = await handlerFor(broken.connect)(removalsEvent());
  assert.equal(failed.code, CODES.UNRELATED_MUTATION);
  assert.equal(broken.committed.present, false);
});

// initdb refuses to run as root; run the server binaries as 'ubuntu' then.
const serverUser = (() => {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('ubuntu:'));
  if (!line) return null;
  const [, , uid, gid] = line.split(':');
  return { uid: Number(uid), gid: Number(gid) };
})();

const pgSkipReason = () => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return 'PostgreSQL 16 initdb is not installed in this environment';
  if (typeof process.getuid === 'function' && process.getuid() === 0 && !serverUser) return 'initdb cannot run as root and no ubuntu account exists';
  return null;
};

test('PostgreSQL 16: a non-superuser owner creates the table through the real handler and RLS keeps each tenant to its own rows', {
  timeout: 180000,
}, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const { default: pg } = await import('pg');
  const server = serverUser || {};
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sql78-'));
  if (serverUser) fs.chownSync(pgData, serverUser.uid, serverUser.gid);
  const port = 54700 + (process.pid % 1000);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], { encoding: 'utf8', ...server });
  assert.equal(init.status, 0, init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${pgData}'\nlogging_collector = off\n`);
  const started = spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', '-t', '30', 'start'], { encoding: 'utf8', ...server });
  assert.equal(started.status, 0, started.stderr);
  const connectAs = async (user) => {
    const client = new pg.Client({ host: pgData, port, user, database: 'sql78' });
    await client.connect();
    return client;
  };
  const admin = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const TENANT_A = '00000000-0000-4000-8000-00000000000a';
  const TENANT_B = '00000000-0000-4000-8000-00000000000b';
  const TENANT_P = '00000000-0000-4000-8000-0000000000ff';
  const CHECK_A = '00000000-0000-4000-8000-0000000000a1';
  const CHECK_B = '00000000-0000-4000-8000-0000000000b1';
  try {
    await admin.query('CREATE ROLE authenticated NOLOGIN');
    await admin.query('CREATE ROLE checksops LOGIN IN ROLE authenticated');
    await admin.query('CREATE ROLE sql78_owner LOGIN NOSUPERUSER');
    await admin.query('CREATE DATABASE sql78 OWNER sql78_owner');
    const owner = await connectAs('sql78_owner');
    // Staging: the restore role's default privileges give checksops SELECT on new tables.
    await owner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO checksops;
      CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text);
      CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenants(id));
      CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY, email text);
      ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION public.aws_is_cross_tenant_reader() RETURNS boolean LANGUAGE sql STABLE AS 'SELECT false';
      CREATE FUNCTION public.aws_can_access_tenant(_tenant_id uuid) RETURNS boolean LANGUAGE sql STABLE
        AS $$ SELECT _tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid $$;
      CREATE FUNCTION public.aws_can_write_tenant(_tenant_id uuid) RETURNS boolean LANGUAGE sql STABLE
        AS $$ SELECT _tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid $$;
      CREATE POLICY aws_select_check_intake_items ON public.check_intake_items FOR SELECT TO authenticated
        USING (public.aws_can_access_tenant(tenant_id));
      INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'a'), ('${TENANT_B}', 'b'), ('${TENANT_P}', 'partner');
      INSERT INTO public.check_intake_items (id, tenant_id) VALUES ('${CHECK_A}', '${TENANT_A}'), ('${CHECK_B}', '${TENANT_B}');`);
    await owner.end();

    const handler = handlerFor(() => connectAs('sql78_owner'));
    const inspect = await handler(removalsEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
    assert.equal(inspect.ok, true, JSON.stringify(inspect));
    assert.equal(inspect.details.receipt.live_definition_sha256, PIN.expected_live_definition_sha256);
    assert.equal(inspect.details.receipt.prerequisites_ok, true, JSON.stringify(inspect.details.receipt));
    assert.equal(inspect.details.receipt.grantee_bypasses_rls, false);
    assert.equal(inspect.details.receipt.apply_preconditions_met, true);

    // On the real catalog: a missing policy function, a BYPASSRLS member of
    // authenticated, and the would-be owner reachable through authenticated are
    // each refused before the file runs; undoing each lets the check pass.
    const refusedThenRestored = async (label, breakIt, restore) => {
      await breakIt();
      const refused = await handler(removalsEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
      assert.equal(refused.details.receipt.apply_preconditions_met, false, label);
      assert.equal((await handler(removalsEvent())).code, CODES.DEPLOYMENT_COLLISION, label);
      await restore();
      const again = await handler(removalsEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
      assert.equal(again.details.receipt.apply_preconditions_met, true, label);
    };
    const asOwner = async (sql) => {
      const c = await connectAs('sql78_owner');
      await c.query(sql);
      await c.end();
    };
    await refusedThenRestored('policy function missing',
      () => asOwner('ALTER FUNCTION public.aws_is_cross_tenant_reader() RENAME TO aws_is_cross_tenant_reader_off'),
      () => asOwner('ALTER FUNCTION public.aws_is_cross_tenant_reader_off() RENAME TO aws_is_cross_tenant_reader'));
    await refusedThenRestored('BYPASSRLS member of authenticated',
      () => admin.query('CREATE ROLE sql78_svc BYPASSRLS IN ROLE authenticated'),
      () => admin.query('DROP ROLE sql78_svc'));
    await refusedThenRestored('owner reachable through authenticated',
      () => admin.query('GRANT sql78_owner TO authenticated'),
      () => admin.query('REVOKE sql78_owner FROM authenticated'));

    const event = removalsEvent();
    const applied = await handler(event);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PIN.expected_live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

    const reread = await handler(removalsEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
    assert.equal(reread.details.receipt.live_definition_sha256, PIN.intended_replacement_sha256);
    assert.equal(reread.details.receipt.tenant_guard_ok, true, JSON.stringify(reread.details.receipt));
    assert.equal(reread.details.receipt.apply_preconditions_met, false);
    assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
    const recreate = await handler(removalsEvent());
    assert.equal(recreate.code, CODES.UNRELATED_MUTATION);
    assert.match(recreate.message, /already in place/);

    // Tenant B's row, written by the owner (no RLS for the owner).
    await asOwner(`INSERT INTO public.check_partner_stakeholder_removals (check_intake_item_id, tenant_id, partner_tenant_id)
      VALUES ('${CHECK_B}', '${TENANT_B}', '${TENANT_P}')`);

    const api = await connectAs('checksops');
    const attempt = async (sql, params = []) => {
      try {
        return { ok: true, rowCount: (await api.query(sql, params)).rowCount };
      } catch (error) {
        return { ok: false, code: error.code };
      }
    };
    try {
      await api.query(`SELECT set_config('app.tenant_id', '${TENANT_A}', false)`);
      const insertOwn = await attempt(`INSERT INTO public.check_partner_stakeholder_removals (check_intake_item_id, tenant_id, partner_tenant_id)
        VALUES ('${CHECK_A}', '${TENANT_A}', '${TENANT_P}')`);
      assert.deepEqual(insertOwn, { ok: true, rowCount: 1 });
      const insertOther = await attempt(`INSERT INTO public.check_partner_stakeholder_removals (check_intake_item_id, tenant_id, partner_tenant_id)
        VALUES ('${CHECK_B}', '${TENANT_B}', '${TENANT_A}')`);
      assert.deepEqual(insertOther, { ok: false, code: '42501' });
      const self = await attempt(`INSERT INTO public.check_partner_stakeholder_removals (check_intake_item_id, tenant_id, partner_tenant_id)
        VALUES ('${CHECK_A}', '${TENANT_A}', '${TENANT_A}')`);
      assert.deepEqual(self, { ok: false, code: '23514' });
      const duplicate = await attempt(`INSERT INTO public.check_partner_stakeholder_removals (check_intake_item_id, tenant_id, partner_tenant_id)
        VALUES ('${CHECK_A}', '${TENANT_A}', '${TENANT_P}')`);
      assert.deepEqual(duplicate, { ok: false, code: '23505' });
      const { rows: visible } = await api.query('SELECT tenant_id FROM public.check_partner_stakeholder_removals');
      assert.deepEqual(visible.map((row) => row.tenant_id), [TENANT_A]);
      assert.deepEqual(await attempt(`DELETE FROM public.check_partner_stakeholder_removals WHERE tenant_id = '${TENANT_B}'`), { ok: true, rowCount: 0 });
      assert.deepEqual(await attempt(`UPDATE public.check_partner_stakeholder_removals SET removed_by = NULL WHERE tenant_id = '${TENANT_A}'`), { ok: false, code: '42501' });
      assert.deepEqual(await attempt(`DELETE FROM public.check_partner_stakeholder_removals WHERE tenant_id = '${TENANT_A}'`), { ok: true, rowCount: 1 });
    } finally {
      await api.end();
    }
    const check = await connectAs('sql78_owner');
    const { rows: remaining } = await check.query('SELECT tenant_id FROM public.check_partner_stakeholder_removals');
    const { rows: [privs] } = await check.query(`SELECT
      has_table_privilege('authenticated', 'public.check_partner_stakeholder_removals', 'UPDATE') AS can_update,
      has_table_privilege('authenticated', 'public.check_partner_stakeholder_removals', 'DELETE') AS can_delete`);
    await check.end();
    assert.deepEqual(remaining.map((row) => row.tenant_id), [TENANT_B]);
    assert.deepEqual(privs, { can_update: false, can_delete: true });
  } finally {
    await admin.end();
    spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop'], server);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
});
