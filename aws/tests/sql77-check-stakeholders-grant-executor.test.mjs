/**
 * Staging VPC executor support for SQL 77
 * (GRANT SELECT, INSERT, DELETE ON public.check_stakeholders TO checksops, authenticated).
 *
 * The committed pin's pre-apply hash is the SELECT-only state a staging
 * read-live run reported; EXECUTABLE_PIN must equal it. Apply also needs
 * row-level security and the aws_write_check_stakeholders policy.
 * The PostgreSQL 16 test applies as a non-superuser table owner, like the AWS
 * database user.
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
  AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT as PIN,
  AUTHORIZED_STAGING_SQL,
  STAKEHOLDER_GRANT_APPLIED_STATE,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
  resolveAuthorizedMigration,
  stakeholderGrantStateText,
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

// The staging state read live before apply: checksops SELECT, authenticated nothing.
const SELECT_ONLY = Object.freeze({
  checksops: { SELECT: 'granted' },
  authenticated: {},
});
const SELECT_ONLY_SHA256 = sha(stakeholderGrantStateText(SELECT_ONLY));
const EXECUTABLE_PIN = Object.freeze({ ...PIN, expected_live_definition_sha256: SELECT_ONLY_SHA256 });

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function grantEvent(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql77-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const event = {
    action: 'apply',
    workstream_id: 'staging-sql77-check-stakeholders-grant',
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
    expected_live_definition_sha256: SELECT_ONLY_SHA256,
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
    `sql77-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile77: SQL_FILE, sql77Pin: EXECUTABLE_PIN, ...extra });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};

test('pin matches the SQL file and its commit; intended is code-derived; expected is the staging SELECT-only state', () => {
  assert.equal(sha(fs.readFileSync(SQL_FILE)), PIN.source_sha256);
  assert.equal(sha(stakeholderGrantStateText(STAKEHOLDER_GRANT_APPLIED_STATE)), PIN.intended_replacement_sha256);
  assert.equal(PIN.expected_live_definition_sha256, SELECT_ONLY_SHA256);
  assert.equal(PIN.expected_live_definition_sha256, '714659325ea58a54fdc2ad39b35224308f8f9df92629c3c53b8e3c6fe3faa4e7');
  assert.deepEqual(EXECUTABLE_PIN, PIN);
  assert.match(fs.readFileSync(SQL_FILE, 'utf8'),
    /^GRANT SELECT, INSERT, DELETE ON TABLE public\.check_stakeholders TO checksops, authenticated;$/m);
  assert.doesNotMatch(fs.readFileSync(SQL_FILE, 'utf8').replace(/^--.*$/gm, ''), /UPDATE/);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(MIGRATIONS['sql77-check-stakeholders-grant'], PIN);
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === PIN.filename && to === 'sql/77_check_stakeholders_write_grant.sql'));
  assert.equal(evaluateSqlExecutorAuthorization(grantEvent(), { now: Date.parse(NOW) }).ok, true);
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), PIN.source_sha256);
});

test('apply refuses before connecting: unreviewed pin, read-live sentinel, wrong hash, tampered file', async () => {
  const unreviewed = await handlerFor(neverConnect, { sql77Pin: { ...PIN, expected_live_definition_sha256: null } })(grantEvent());
  assert.equal(unreviewed.code, CODES.SQL_COLLISION);
  assert.match(unreviewed.message, /no reviewed pre-apply live definition hash/);
  const sentinel = await handlerFor(neverConnect)(grantEvent({ expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
  assert.equal(sentinel.ok, false);
  const other = await handlerFor(neverConnect)(grantEvent({ expected_live_definition_sha256: 'b'.repeat(64) }));
  assert.equal(other.code, CODES.SQL_COLLISION);
  const forged = await handlerFor(neverConnect, { sql77Pin: { ...EXECUTABLE_PIN, intended_replacement_sha256: 'c'.repeat(64) } })(grantEvent());
  assert.equal(forged.code, CODES.SQL_COLLISION);
  for (const extra of [
    'GRANT UPDATE ON TABLE public.check_stakeholders TO checksops;\n',
    'GRANT ALL ON TABLE public.payment_transfers TO authenticated;\n',
  ]) {
    const tampered = path.join(os.tmpdir(), `sql77-tampered-${process.pid}.sql`);
    fs.writeFileSync(tampered, `${fs.readFileSync(SQL_FILE, 'utf8')}${extra}`);
    try {
      const result = await handlerFor(neverConnect, { sqlFile77: tampered })(grantEvent());
      assert.equal(result.code, CODES.SQL_COLLISION, extra);
    } finally {
      fs.rmSync(tampered, { force: true });
    }
  }
});

const WRITE_POLICY = Object.freeze({
  name: 'aws_write_check_stakeholders', permissive: true, cmd: 'ALL', roles: ['authenticated'],
  using: 'aws_can_write_tenant(tenant_id)', with_check: 'aws_can_write_tenant(tenant_id)',
});
const SELECT_POLICY = Object.freeze({
  name: 'aws_select_check_stakeholders', permissive: true, cmd: 'SELECT', roles: ['authenticated'],
  using: 'aws_can_read_tenant(tenant_id)', with_check: null,
});

/** Fake catalog: ACL rows; running the embedded GRANT adds the three privileges (or a variant via onApply). */
function fakeDb({ acl = [
  { grantee: 'owner_role', privilege_type: 'SELECT', is_grantable: false },
  { grantee: 'owner_role', privilege_type: 'INSERT', is_grantable: false },
  { grantee: 'checksops', privilege_type: 'SELECT', is_grantable: false },
], present = true, rlsEnabled = true, policies = [SELECT_POLICY, WRITE_POLICY], bypasses = false, onApply } = {}) {
  let committed = acl.map((row) => ({ ...row }));
  let working = null;
  const current = () => working || committed;
  const seen = [];
  return {
    seen,
    get acl() { return committed; },
    connect: async () => ({
      end: async () => {},
      query: async (sql) => {
        const text = String(sql);
        seen.push(text);
        if (text === 'BEGIN') { working = committed.map((row) => ({ ...row })); return { rows: [] }; }
        if (text === 'COMMIT') { committed = working; working = null; return { rows: [] }; }
        if (text === 'ROLLBACK') { working = null; return { rows: [] }; }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (text.includes('IS NOT NULL AS present')) return { rows: [{ present }] };
        if (text.includes('AS rls_enabled')) return { rows: [{ rls_enabled: rlsEnabled }] };
        if (text.includes('FROM pg_policy pol')) return { rows: policies.map((policy) => ({ ...policy })) };
        if (text.includes('AS bypasses')) return { rows: [{ bypasses }] };
        if (text.includes('aclexplode')) return { rows: current().map((row) => ({ ...row })) };
        if (text.includes('GRANT SELECT, INSERT, DELETE ON TABLE public.check_stakeholders')) {
          for (const grantee of ['checksops', 'authenticated']) {
            for (const privilege_type of ['SELECT', 'INSERT', 'DELETE']) {
              if (!current().some((row) => row.grantee === grantee && row.privilege_type === privilege_type)) {
                current().push({ grantee, privilege_type, is_grantable: false });
              }
            }
          }
          if (onApply) onApply(current());
          return { rows: [] };
        }
        throw new Error(`unexpected SQL ${text.slice(0, 60)}`);
      },
    }),
  };
}

test('inspect only SELECTs and reports the privilege and tenant-guard state; a pin without an expected hash is not executable', async () => {
  const db = fakeDb();
  const inspect = await handlerFor(db.connect, { sql77Pin: { ...PIN, expected_live_definition_sha256: null } })(grantEvent({
    action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
  }));
  assert.equal(inspect.ok, true, JSON.stringify(inspect));
  const receipt = inspect.details.receipt;
  assert.equal(receipt.live_definition_sha256, SELECT_ONLY_SHA256);
  assert.equal(receipt.before_hash, receipt.after_hash);
  assert.equal(receipt.pin_executable, false);
  assert.equal(receipt.apply_preconditions_met, false);
  assert.equal(receipt.update_granted, false);
  assert.equal(receipt.rls_enabled, true);
  assert.equal(receipt.write_policy_present, true);
  assert.equal(receipt.write_policy_as_expected, true);
  assert.equal(receipt.other_write_policy_count, 0);
  assert.equal(receipt.grantee_bypasses_rls, false);
  assert.equal(receipt.tenant_guard_ok, true);
  assert.deepEqual(receipt.privilege_state.checksops, { SELECT: 'granted', INSERT: 'absent', UPDATE: 'absent', DELETE: 'absent' });
  assert.ok(db.seen.every((text) => /^\s*SELECT\b/i.test(text)), JSON.stringify(db.seen));
});

test('apply lands exactly on the intended state once; replay, re-grant, UPDATE drift and collateral changes are refused', async () => {
  const db = fakeDb();
  const handler = handlerFor(db.connect);
  const event = grantEvent();
  const applied = await handler(event);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, SELECT_ONLY_SHA256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(applied.details.receipt.privilege_state_after.authenticated, { SELECT: 'granted', INSERT: 'granted', UPDATE: 'absent', DELETE: 'granted' });
  assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
  assert.equal((await handler(grantEvent())).code, CODES.UNRELATED_MUTATION);

  const withUpdate = fakeDb({ acl: [
    { grantee: 'checksops', privilege_type: 'SELECT', is_grantable: false },
    { grantee: 'checksops', privilege_type: 'UPDATE', is_grantable: false },
    { grantee: 'authenticated', privilege_type: 'SELECT', is_grantable: false },
  ] });
  assert.equal((await handlerFor(withUpdate.connect)(grantEvent())).code, CODES.DEPLOYMENT_COLLISION);

  const different = fakeDb({ acl: [
    { grantee: 'checksops', privilege_type: 'SELECT', is_grantable: false },
    { grantee: 'authenticated', privilege_type: 'SELECT', is_grantable: false },
  ] });
  assert.equal((await handlerFor(different.connect)(grantEvent())).code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(different.acl.length, 2);

  // Spacing, schema prefix and outer parentheses in the deparsed policy still match.
  const reformatted = fakeDb({ policies: [SELECT_POLICY, {
    ...WRITE_POLICY, using: '(public.aws_can_write_tenant(tenant_id))', with_check: 'public.aws_can_write_tenant( tenant_id )',
  }] });
  assert.equal((await handlerFor(reformatted.connect)(grantEvent())).ok, true);

  for (const [label, options] of [
    ['RLS off', { rlsEnabled: false }],
    ['no write policy', { policies: [SELECT_POLICY] }],
    ['write policy allows any row', { policies: [SELECT_POLICY, { ...WRITE_POLICY, using: 'true', with_check: 'true' }] }],
    ['write policy checks only USING', { policies: [SELECT_POLICY, { ...WRITE_POLICY, with_check: null }] }],
    ['write policy for PUBLIC', { policies: [SELECT_POLICY, { ...WRITE_POLICY, roles: ['public'] }] }],
    ['write policy for INSERT only', { policies: [SELECT_POLICY, { ...WRITE_POLICY, cmd: 'INSERT' }] }],
    ['write policy restrictive', { policies: [SELECT_POLICY, { ...WRITE_POLICY, permissive: false }] }],
    ['extra permissive INSERT policy', { policies: [SELECT_POLICY, WRITE_POLICY, { name: 'open_insert', permissive: true, cmd: 'INSERT', roles: ['authenticated'], using: null, with_check: 'true' }] }],
    ['extra permissive DELETE policy', { policies: [SELECT_POLICY, WRITE_POLICY, { name: 'open_delete', permissive: true, cmd: 'DELETE', roles: ['public'], using: 'true', with_check: null }] }],
    ['a grantee bypasses RLS', { bypasses: true }],
    ['bypass unknown', { bypasses: null }],
  ]) {
    const unguarded = fakeDb(options);
    const inspected = await handlerFor(unguarded.connect)(grantEvent({ action: 'inspect' }));
    assert.equal(inspected.details.receipt.tenant_guard_ok, false, label);
    assert.equal(inspected.details.receipt.apply_preconditions_met, false, label);
    const refused = await handlerFor(unguarded.connect)(grantEvent());
    assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, label);
    assert.match(refused.message, /row-level security/, label);
    assert.equal(unguarded.acl.length, 3, label);
  }

  // A restrictive extra policy only narrows writes, so it does not block.
  const narrowed = fakeDb({ policies: [SELECT_POLICY, WRITE_POLICY, { name: 'narrow', permissive: false, cmd: 'ALL', roles: ['authenticated'], using: 'false', with_check: 'false' }] });
  assert.equal((await handlerFor(narrowed.connect)(grantEvent())).ok, true);

  for (const [label, onApply] of [
    ['another grantee changed', (rows) => { rows.push({ grantee: 'anon', privilege_type: 'SELECT', is_grantable: false }); }],
    ['TRUNCATE granted too', (rows) => { rows.push({ grantee: 'checksops', privilege_type: 'TRUNCATE', is_grantable: false }); }],
    ['UPDATE granted too', (rows) => { rows.push({ grantee: 'authenticated', privilege_type: 'UPDATE', is_grantable: false }); }],
  ]) {
    const collateral = fakeDb({ onApply });
    const refused = await handlerFor(collateral.connect)(grantEvent());
    assert.equal(refused.code, CODES.UNRELATED_MUTATION, label);
    assert.equal(collateral.acl.length, 3, label);
  }

  const missing = fakeDb({ present: false });
  assert.equal((await handlerFor(missing.connect)(grantEvent({ action: 'inspect' }))).code, CODES.SQL_COLLISION);
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

test('PostgreSQL 16: a non-superuser owner applies SQL 77 through the real handler and checksops can then link', {
  timeout: 180000,
}, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const { default: pg } = await import('pg');
  const server = serverUser || {};
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sql77-'));
  if (serverUser) fs.chownSync(pgData, serverUser.uid, serverUser.gid);
  const port = 58800 + (process.pid % 1000);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], { encoding: 'utf8', ...server });
  assert.equal(init.status, 0, init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${pgData}'\nlogging_collector = off\n`);
  const started = spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', '-t', '30', 'start'], { encoding: 'utf8', ...server });
  assert.equal(started.status, 0, started.stderr);
  const connectAs = async (user) => {
    const client = new pg.Client({ host: pgData, port, user, database: 'sql77' });
    await client.connect();
    return client;
  };
  const admin = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  try {
    await admin.query('CREATE ROLE authenticated NOLOGIN');
    await admin.query('CREATE ROLE checksops LOGIN IN ROLE authenticated');
    await admin.query('CREATE ROLE sql77_owner LOGIN NOSUPERUSER');
    await admin.query('CREATE DATABASE sql77 OWNER sql77_owner');
    const owner = await connectAs('sql77_owner');
    await owner.query(`
      CREATE TABLE public.check_stakeholders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid NOT NULL,
        stakeholder_account_id uuid NOT NULL, tenant_id uuid NOT NULL,
        added_via text NOT NULL DEFAULT 'manual', partner_tenant_id uuid, added_by uuid,
        UNIQUE (check_intake_item_id, stakeholder_account_id));
      GRANT SELECT ON public.check_stakeholders TO checksops;
      ALTER TABLE public.check_stakeholders ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION public.aws_can_write_tenant(uuid) RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true';
      CREATE POLICY aws_write_check_stakeholders ON public.check_stakeholders FOR ALL TO authenticated
        USING (public.aws_can_write_tenant(tenant_id)) WITH CHECK (public.aws_can_write_tenant(tenant_id));`);
    await owner.end();

    const insertAsApi = async () => {
      const app = await connectAs('checksops');
      try {
        await app.query(
          "INSERT INTO public.check_stakeholders (check_intake_item_id, stakeholder_account_id, tenant_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
        );
        return 'allowed';
      } catch (error) {
        return error.code;
      } finally {
        await app.end();
      }
    };
    // The restored state: SELECT only, so the API cannot link (42501).
    assert.equal(await insertAsApi(), '42501');

    const handler = handlerFor(() => connectAs('sql77_owner'));
    const inspect = await handler(grantEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
    assert.equal(inspect.ok, true, JSON.stringify(inspect));
    assert.equal(inspect.details.receipt.live_definition_sha256, SELECT_ONLY_SHA256);
    assert.equal(inspect.details.receipt.tenant_guard_ok, true, JSON.stringify(inspect.details.receipt));
    assert.equal(inspect.details.receipt.apply_preconditions_met, true);

    // A loosened write policy on the real catalog is refused.
    const alter = async (cond) => {
      const owner = await connectAs('sql77_owner');
      await owner.query(`ALTER POLICY aws_write_check_stakeholders ON public.check_stakeholders USING (${cond}) WITH CHECK (${cond})`);
      await owner.end();
    };
    await alter('true');
    const loosened = await handler(grantEvent());
    assert.equal(loosened.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(loosened));
    await alter('public.aws_can_write_tenant(tenant_id)');

    const event = grantEvent();
    const applied = await handler(event);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    assert.equal(await insertAsApi(), 'allowed');
    assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
    assert.equal((await handler(grantEvent())).code, CODES.UNRELATED_MUTATION);

    const check = await connectAs('sql77_owner');
    const { rows: [privs] } = await check.query(`SELECT
      has_table_privilege('checksops', 'public.check_stakeholders', 'UPDATE') AS can_update,
      has_table_privilege('checksops', 'public.check_stakeholders', 'DELETE') AS can_delete`);
    await check.end();
    assert.deepEqual(privs, { can_update: false, can_delete: true });
  } finally {
    await admin.end();
    spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop'], server);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
});
