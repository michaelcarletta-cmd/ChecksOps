/**
 * Staging VPC executor support for SQL 76 (tenant partnership invitee consent).
 * A fake client covers the decision logic; the PostgreSQL 16 test runs the real
 * handler against tenant_partnerships with the retired policies, the real
 * aws_connect_partner_by_code from SQL 32 and the live helper function names.
 *
 * The committed pin has no pre-apply live hash yet (expected_live_definition_sha256
 * is null), so apply paths run on a copy with a reviewed hash filled in; the
 * committed pin itself must refuse apply.
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
  AUTHORIZED_SQL76_PARTNERSHIP_CONSENT as PIN,
  AUTHORIZED_STAGING_SQL,
  PARTNERSHIP_CONNECT_BODY_SHA256,
  PARTNERSHIP_CONNECT_CONFIG,
  PARTNERSHIP_CONSENT_APPLIED_STATE,
  PARTNERSHIP_RETIRED_POLICIES,
  SQL76_PROPOSED_AUTHORIZATION_PHRASE,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
  partnershipConsentStateText,
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
const SQL32_FILE = path.join(ROOT, 'aws/rls/sql/32_partner_share_lifecycle.sql');
// aws_connect_partner_by_code's body (prosrc) exactly as SQL 32 defines it.
const SQL32_CONNECT_BODY = (() => {
  const match = fs.readFileSync(SQL32_FILE, 'utf8')
    .match(/CREATE OR REPLACE FUNCTION public\.aws_connect_partner_by_code\([\s\S]*?\nAS \$\$([\s\S]*?)\$\$;/);
  assert.ok(match, 'aws_connect_partner_by_code body not found in SQL 32');
  return match[1];
})();

// Pre-apply state the repo expects (guard absent, marker unset, all five
// retired policies present, connect pinned, no other triggers). Only a staging
// inspect can confirm it.
const ALL_PRESENT_BEFORE = sha(partnershipConsentStateText({}));
const ALL_PRESENT_BEFORE_SHA256 = '219007090acfeba71518ec999d386eca3a9ef40c5c7336c5115abf7a3e183f1c';
const EXECUTABLE_PIN = Object.freeze({ ...PIN, expected_live_definition_sha256: ALL_PRESENT_BEFORE });

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler, sql76StatementsAllowed, sql76GuardBody } = executorModule;
const SQL_TEXT = fs.readFileSync(SQL_FILE, 'utf8');
const BODY = sql76GuardBody(SQL_TEXT);

function consentEvent(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql76-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const event = {
    action: 'apply',
    workstream_id: 'staging-sql76-tenant-partnership-consent',
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
    expected_live_definition_sha256: ALL_PRESENT_BEFORE,
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
    `sql76-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile76: SQL_FILE, sql76Pin: EXECUTABLE_PIN, ...extra });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};

const OTHER_POLICIES = [
  { tablename: 'tenant_partnerships', policyname: 'aws_select_tenant_partnerships', cmd: 'SELECT', roles: '{authenticated}', permissive: 'PERMISSIVE', qual: 'aws_can_access_tenant(inviter_tenant_id)', with_check: null },
  { tablename: 'tenant_partnerships', policyname: 'aws_write_tenant_partnerships', cmd: 'ALL', roles: '{authenticated}', permissive: 'PERMISSIVE', qual: 'aws_can_write_tenant(inviter_tenant_id)', with_check: 'aws_can_write_tenant(inviter_tenant_id)' },
];
const RETIRED = PARTNERSHIP_RETIRED_POLICIES.map((policyname) => ({
  tablename: 'tenant_partnerships', policyname, cmd: 'UPDATE', roles: '{authenticated}', permissive: 'PERMISSIVE', qual: 'true', with_check: null,
}));
const OTHER_TRIGGER = {
  tgname: 'tenant_partnerships_touch', tgtype: 19, tgenabled: 'O', tgnargs: 0, tgattr: '', has_qual: false,
  function_name: 'public.touch_updated_at', definition: 'CREATE TRIGGER tenant_partnerships_touch BEFORE UPDATE ...',
};
const PINNED_GUARD = {
  prosrc: BODY, lanname: 'plpgsql', prosecdef: false, proconfig: ['search_path=public'], rettype: 'trigger', pronargs: 0, public_execute: false,
};
const PINNED_TRIGGER = {
  tgname: 'aws_tenant_partnership_consent_guard', tgtype: 23, tgenabled: 'O', tgnargs: 0, tgattr: '', has_qual: false,
  function_name: 'public.aws_tenant_partnership_consent_guard', definition: 'CREATE TRIGGER aws_tenant_partnership_consent_guard ...',
};
// Pinned: SECURITY DEFINER, the SQL 32 config and body.
const CONNECT = { prosrc: SQL32_CONNECT_BODY, prosecdef: true, proconfig: ['search_path=public', 'row_security=off'] };

/** In-memory catalog. Running the embedded SQL applies SQL 76 (or a variant via onApply). */
function fakeDb({
  policies = [...OTHER_POLICIES, ...RETIRED],
  triggers = [],
  guard = [],
  connectRow = CONNECT,
  table = { relrowsecurity: true, relforcerowsecurity: false },
  functions = ['aws_can_write_tenant', 'aws_user_tenant_ids'],
  onApply,
} = {}) {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  let committed = clone({ policies, triggers, guard, connect: connectRow, table });
  let working = null;
  const current = () => working || committed;
  return {
    get state() { return committed; },
    connect: async () => ({
      end: async () => {},
      query: async (sql) => {
        const text = String(sql);
        if (text === 'BEGIN') { working = clone(committed); return { rows: [] }; }
        if (text === 'COMMIT') { committed = working; working = null; return { rows: [] }; }
        if (text === 'ROLLBACK') { working = null; return { rows: [] }; }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (text.includes('FROM pg_class c')) return { rows: current().table ? [current().table] : [] };
        if (text.includes("p.proname = 'aws_tenant_partnership_consent_guard'")) return { rows: current().guard };
        if (text.includes('FROM pg_trigger')) return { rows: current().triggers };
        if (text.includes('to_regprocedure')) return { rows: current().connect ? [current().connect] : [] };
        if (text.includes('FROM pg_policies')) return { rows: current().policies };
        if (text.includes('has_function_privilege')) return { rows: functions.map((proname) => ({ proname, can_execute: true })) };
        if (text.includes('CREATE TRIGGER aws_tenant_partnership_consent_guard')) {
          const next = current();
          next.guard = [{ ...PINNED_GUARD }];
          next.triggers = [...next.triggers.filter((row) => row.tgname !== PINNED_TRIGGER.tgname), { ...PINNED_TRIGGER }];
          next.connect = { ...next.connect, proconfig: [...next.connect.proconfig, 'checksops.partnership_writer=aws_connect_partner_by_code'] };
          next.policies = next.policies.filter((row) => !PARTNERSHIP_RETIRED_POLICIES.includes(row.policyname));
          if (onApply) onApply(next);
          return { rows: [] };
        }
        throw new Error(`unexpected SQL ${text.slice(0, 60)}`);
      },
    }),
  };
}

test('pin matches the SQL file and its commit, and is not executable until a live hash is reviewed', () => {
  assert.equal(sha(fs.readFileSync(SQL_FILE)), PIN.source_sha256);
  assert.equal(sha(partnershipConsentStateText(PARTNERSHIP_CONSENT_APPLIED_STATE)), PIN.intended_replacement_sha256);
  assert.equal(PIN.expected_live_definition_sha256, null);
  assert.equal(SQL76_PROPOSED_AUTHORIZATION_PHRASE, 'GUARD_PARTNERSHIP_ACTIVATION');
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(MIGRATIONS['sql76-tenant-partnership-consent'], PIN);
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === PIN.filename && to === 'sql/76_tenant_partnership_invitee_consent.sql'));
  assert.equal(evaluateSqlExecutorAuthorization(consentEvent(), { now: Date.parse(NOW) }).ok, true);
  assert.equal(sql76StatementsAllowed(SQL_TEXT), true);
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), PIN.source_sha256);
});

test('connect body pin equals the sha256 of the SQL 32 body; the expected pre-state hash is the reviewed one', () => {
  assert.equal(sha(SQL32_CONNECT_BODY), PARTNERSHIP_CONNECT_BODY_SHA256);
  assert.deepEqual([...PARTNERSHIP_CONNECT_CONFIG], ['search_path=public', 'row_security=off']);
  assert.equal(ALL_PRESENT_BEFORE, ALL_PRESENT_BEFORE_SHA256);
  // Every drifted connect or extra trigger yields a different pre-state text.
  for (const drift of [{ connect: 'different' }, { connect: 'missing_function' }, { otherTriggers: 'present' }]) {
    assert.notEqual(sha(partnershipConsentStateText(drift)), ALL_PRESENT_BEFORE, JSON.stringify(drift));
  }
});

test('statement allowlist refuses anything beyond the pinned SQL 76 statements', () => {
  for (const extra of [
    'GRANT ALL ON public.tenant_partnerships TO authenticated;',
    'DROP POLICY IF EXISTS aws_write_tenant_partnerships ON public.tenant_partnerships;',
    'ALTER TABLE public.tenant_partnerships DISABLE ROW LEVEL SECURITY;',
    "SELECT set_config('checksops.partnership_writer', 'aws_connect_partner_by_code', false);",
    'ALTER FUNCTION public.aws_tenant_partnership_consent_guard() SECURITY DEFINER;',
  ]) {
    assert.equal(sql76StatementsAllowed(`${SQL_TEXT}\n${extra}\n`), false, extra);
  }
  // Function header and trigger shape.
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace('LANGUAGE plpgsql\nSET search_path', 'LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path')), false);
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace('BEFORE INSERT OR UPDATE', 'BEFORE INSERT')), false);
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace('FROM PUBLIC;', 'FROM anon;')), false);
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace("SET checksops.partnership_writer = 'aws_connect_partner_by_code'", "SET checksops.partnership_writer = 'anyone'")), false);
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace('DROP POLICY IF EXISTS "Admins can view any partnership"', 'DROP POLICY IF EXISTS "aws_select_tenant_partnerships"')), false);
  // Guard body: the consent rule cannot be loosened or widened.
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace('COALESCE(public.aws_can_write_tenant(NEW.invitee_tenant_id), false)', 'true')), false);
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace('RETURN NEW;', "PERFORM set_config('x', 'y', true);\n  RETURN NEW;")), false);
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace('RETURN NEW;', 'UPDATE public.tenants SET name = name;\n  RETURN NEW;')), false);
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace('RETURN NEW;', "EXECUTE 'SELECT 1';\n  RETURN NEW;")), false);
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace('NEW.invitee_tenant_id IS NULL\n       OR NOT', 'NEW.invitee_tenant_id IS NULL\n       OR public.aws_can_write_tenant(NEW.inviter_tenant_id)\n       OR NOT')), false);
  // Order matters.
  const trigger = 'DROP TRIGGER IF EXISTS aws_tenant_partnership_consent_guard ON public.tenant_partnerships;\n';
  assert.equal(sql76StatementsAllowed(SQL_TEXT.replace(trigger, '').replace('ALTER FUNCTION public.aws_connect', `${trigger}ALTER FUNCTION public.aws_connect`)), false);
});

test('the committed pin refuses apply before connecting; inspect still reports the live hash', async () => {
  const committed = (connect) => handlerFor(connect, { sql76Pin: PIN });
  const refused = await committed(neverConnect)(consentEvent());
  assert.equal(refused.code, CODES.SQL_COLLISION);
  assert.match(refused.message, /no reviewed pre-apply live definition hash/);

  const db = fakeDb();
  const inspect = await committed(db.connect)(consentEvent({ action: 'inspect' }));
  assert.equal(inspect.ok, true, JSON.stringify(inspect));
  assert.equal(inspect.details.receipt.live_definition_sha256, ALL_PRESENT_BEFORE);
  assert.equal(inspect.details.receipt.pin_executable, false);
  assert.equal(inspect.details.receipt.apply_preconditions_met, false);
  assert.equal(db.state.policies.length, 7);
});

/** A client that answers only catalog SELECTs and throws on anything else (BEGIN, DDL, the migration file). */
function selectOnly(db, seen) {
  return async () => {
    const client = await db.connect();
    return {
      end: client.end,
      query: async (sql, params) => {
        const text = String(sql);
        seen.push(text);
        if (!/^\s*SELECT\b/i.test(text) || /pg_advisory|\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|COMMENT|TRUNCATE|BEGIN|COMMIT)\b/i.test(text.replace(/'[^']*'/g, "''"))) {
          throw new Error(`read-only inspect issued a non-SELECT statement: ${text.slice(0, 60)}`);
        }
        return client.query(sql, params);
      },
    };
  };
}

test('inspect (the read-live action) only SELECTs: no BEGIN, no lock, no migration file, no one_use_id consumption', async () => {
  for (const pin of [PIN, EXECUTABLE_PIN]) {
    for (const expected of [READ_LIVE_EXPECTED_SENTINEL, ALL_PRESENT_BEFORE]) {
      const db = fakeDb();
      const seen = [];
      const handler = handlerFor(selectOnly(db, seen), { sql76Pin: pin });
      const event = consentEvent({ action: 'inspect', expected_live_definition_sha256: expected });
      const result = await handler(event);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.details.receipt.result, 'inspect');
      assert.equal(result.details.receipt.live_definition_sha256, ALL_PRESENT_BEFORE);
      assert.equal(result.details.receipt.before_hash, result.details.receipt.after_hash);
      assert.equal(result.details.receipt.pin_executable, pin === EXECUTABLE_PIN);
      assert.ok(seen.length > 0);
      assert.ok(!seen.some((text) => text === SQL_TEXT || text.includes('CREATE TRIGGER')));
      // Nothing changed and the one_use_id was not consumed: the same id can still be inspected.
      assert.equal(db.state.policies.length, 7);
      assert.deepEqual(db.state.guard, []);
      assert.equal(fs.existsSync(process.env.SQL_EXECUTOR_CONSUMED_PATH), false);
      assert.equal((await handler(event)).ok, true);
    }
  }
  // The strict client is real: apply (BEGIN) through it fails and nothing is written.
  const db = fakeDb();
  const seen = [];
  const applied = await handlerFor(selectOnly(db, seen))(consentEvent());
  assert.equal(applied.ok, false);
  assert.match(applied.message, /non-SELECT statement: BEGIN/);
  assert.equal(db.state.policies.length, 7);
});

test('a read-live package (sentinel expected hash) relabelled as apply is refused before connecting', async () => {
  for (const pin of [PIN, EXECUTABLE_PIN]) {
    const refused = await handlerFor(neverConnect, { sql76Pin: pin })(consentEvent({
      action: 'apply',
      expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
    }));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, CODES.SQL_COLLISION);
  }
  assert.notEqual(READ_LIVE_EXPECTED_SENTINEL, ALL_PRESENT_BEFORE);
  assert.notEqual(READ_LIVE_EXPECTED_SENTINEL, PIN.intended_replacement_sha256);
});

test('apply refuses before connecting unless it is the exact pin; tampered files and pins are refused', async () => {
  assert.equal((await handlerFor(neverConnect)(consentEvent({ expected_live_definition_sha256: 'b'.repeat(64) }))).code, CODES.SQL_COLLISION);
  const forged = await handlerFor(neverConnect, { sql76Pin: { ...EXECUTABLE_PIN, intended_replacement_sha256: 'c'.repeat(64) } })(consentEvent());
  assert.equal(forged.code, CODES.SQL_COLLISION);
  const tampered = path.join(os.tmpdir(), `sql76-tampered-${process.pid}.sql`);
  fs.writeFileSync(tampered, `${SQL_TEXT}GRANT ALL ON public.tenant_partnerships TO authenticated;\n`);
  try {
    assert.equal((await handlerFor(neverConnect, { sqlFile76: tampered })(consentEvent())).code, CODES.SQL_COLLISION);
  } finally {
    fs.rmSync(tampered, { force: true });
  }
});

test('inspect, apply, replay and re-apply refusal', async () => {
  const db = fakeDb();
  const handler = handlerFor(db.connect);
  const inspect = await handler(consentEvent({ action: 'inspect' }));
  assert.equal(inspect.ok, true, JSON.stringify(inspect));
  assert.equal(inspect.details.receipt.apply_preconditions_met, true);
  assert.equal(inspect.details.receipt.other_policy_count, 2);
  assert.equal(inspect.details.receipt.other_trigger_count, 0);
  assert.equal(inspect.details.receipt.live_definition_sha256, ALL_PRESENT_BEFORE_SHA256);
  assert.equal(inspect.details.receipt.consent_state.connect, 'pinned');
  assert.equal(inspect.details.receipt.consent_state.other_triggers, 'none');

  const event = consentEvent();
  const applied = await handler(event);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, ALL_PRESENT_BEFORE);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(applied.details.receipt.consent_state_after.policies, Object.fromEntries(PARTNERSHIP_RETIRED_POLICIES.map((n) => [n, 'absent'])));
  assert.equal(db.state.policies.length, 2);

  assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
  assert.equal((await handler(consentEvent())).code, CODES.UNRELATED_MUTATION);
});

test('drift, missing prerequisites and collateral changes are refused and rolled back', async () => {
  // A different guard already present, or only some retired policies live.
  const drifted = fakeDb({ guard: [{ ...PINNED_GUARD, prosecdef: true }] });
  assert.equal((await handlerFor(drifted.connect)(consentEvent())).code, CODES.DEPLOYMENT_COLLISION);
  const partial = fakeDb({ policies: [...OTHER_POLICIES, ...RETIRED.slice(1)] });
  assert.equal((await handlerFor(partial.connect)(consentEvent())).code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(partial.state.policies.length, 6);

  const noConnect = fakeDb({ connectRow: null });
  assert.equal((await handlerFor(noConnect.connect)(consentEvent())).code, CODES.DEPLOYMENT_COLLISION);
  // The trusted writer must be exactly the reviewed SQL 32 function, and no other
  // trigger may run on the table: each drift changes the pre-state hash and apply is refused.
  for (const [label, options, connectState] of [
    ['different connect body', { connectRow: { ...CONNECT, prosrc: `${SQL32_CONNECT_BODY}-- drift\n` } }, 'different'],
    ['connect not SECURITY DEFINER', { connectRow: { ...CONNECT, prosecdef: false } }, 'different'],
    ['connect with extra proconfig', { connectRow: { ...CONNECT, proconfig: [...CONNECT.proconfig, 'statement_timeout=0'] } }, 'different'],
    ['connect missing row_security=off', { connectRow: { ...CONNECT, proconfig: ['search_path=public'] } }, 'different'],
    ['extra trigger on the table', { triggers: [OTHER_TRIGGER] }, 'pinned'],
  ]) {
    const db = fakeDb(options);
    const inspect = await handlerFor(db.connect)(consentEvent({ action: 'inspect' }));
    assert.equal(inspect.ok, true, label);
    assert.notEqual(inspect.details.receipt.live_definition_sha256, ALL_PRESENT_BEFORE, label);
    assert.equal(inspect.details.receipt.apply_preconditions_met, false, label);
    assert.equal(inspect.details.receipt.consent_state.connect, connectState, label);
    const refused = await handlerFor(db.connect)(consentEvent());
    assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, label);
    assert.equal(db.state.guard.length, 0, label);
    assert.equal(db.state.policies.length, 7, label);
  }

  const noHelpers = fakeDb({ functions: ['aws_user_tenant_ids'] });
  assert.equal((await handlerFor(noHelpers.connect)(consentEvent())).code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(noHelpers.state.policies.length, 7);

  for (const [label, onApply] of [
    ['other policy dropped', (next) => { next.policies = next.policies.filter((row) => row.policyname !== 'aws_write_tenant_partnerships'); }],
    ['other trigger added', (next) => { next.triggers = [...next.triggers, { ...OTHER_TRIGGER }]; }],
    ['connect function body changed', (next) => { next.connect = { ...next.connect, prosrc: 'BEGIN RETURN 1; END;' }; }],
    ['connect function lost row_security=off', (next) => { next.connect = { ...next.connect, proconfig: next.connect.proconfig.filter((e) => e !== 'row_security=off') }; }],
    ['RLS disabled', (next) => { next.table = { ...next.table, relrowsecurity: false }; }],
    ['guard executable by PUBLIC', (next) => { next.guard = [{ ...next.guard[0], public_execute: true }]; }],
    ['trigger only on INSERT', (next) => { next.triggers = next.triggers.map((row) => (row.tgname === PINNED_TRIGGER.tgname ? { ...row, tgtype: 7 } : row)); }],
  ]) {
    const db = fakeDb({ onApply });
    const refused = await handlerFor(db.connect)(consentEvent());
    assert.equal(refused.code, CODES.UNRELATED_MUTATION, label);
    assert.equal(db.state.policies.length, 7, label);
    assert.equal(db.state.guard.length, 0, label);
  }
});

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

test('PostgreSQL 16: the real handler applies SQL 76 and only the invitee side can activate', {
  timeout: 180000,
}, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const { default: pg } = await import('pg');
  const server = serverUser || {};
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sql76-exec-'));
  if (serverUser) fs.chownSync(pgData, serverUser.uid, serverUser.gid);
  const port = 59800 + (process.pid % 1000);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], { encoding: 'utf8', ...server });
  assert.equal(init.status, 0, init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${pgData}'\nlogging_collector = off\n`);
  const started = spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', '-t', '30', 'start'], { encoding: 'utf8', ...server });
  assert.equal(started.status, 0, started.stderr);
  const admin = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE ROLE authenticated NOLOGIN');
  await admin.query('CREATE ROLE checksops LOGIN IN ROLE authenticated');
  await admin.query('CREATE DATABASE sql76');
  const connect = async (user = 'ubuntu') => {
    const client = new pg.Client({ host: pgData, port, user, database: 'sql76' });
    await client.connect();
    return client;
  };
  const INVITER_USER = '11111111-1111-4111-8111-111111111111';
  const INVITEE_USER = '22222222-2222-4222-8222-222222222222';
  const INVITER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const INVITEE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const INVITEE_CODE = 'AB3K7X9P';
  try {
    const seed = await connect();
    await seed.query(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.app_user_id', true), '')::uuid $$;
      CREATE TABLE public.tenant_users (user_id uuid, tenant_id uuid);
      INSERT INTO public.tenant_users VALUES ('${INVITER_USER}', '${INVITER}'), ('${INVITEE_USER}', '${INVITEE}');
      CREATE FUNCTION public.aws_user_tenant_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$ SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid() $$;
      CREATE FUNCTION public.aws_can_write_tenant(_tenant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT _tenant IN (SELECT public.aws_user_tenant_ids()) $$;
      CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text, partner_code text UNIQUE, subscription_status text NOT NULL DEFAULT 'active');
      INSERT INTO public.tenants (id, name, partner_code) VALUES ('${INVITER}', 'Inviter Co', 'ZZZZZZZ1'), ('${INVITEE}', 'Invitee Co', '${INVITEE_CODE}');
      CREATE FUNCTION public.lookup_tenant_by_partner_code(_code text) RETURNS TABLE(id uuid, name text)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT t.id, t.name FROM public.tenants t
        WHERE t.subscription_status = 'active' AND t.partner_code = regexp_replace(upper(coalesce(_code, '')), '[^A-Z0-9]', '', 'g') LIMIT 1 $$;
      CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, status text);
      CREATE TABLE public.tenant_partnerships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inviter_tenant_id uuid NOT NULL, invitee_tenant_id uuid,
        invite_code text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending', created_by uuid,
        created_at timestamptz DEFAULT now(), accepted_at timestamptz, revoked_at timestamptz);
      CREATE TABLE public.shared_checks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, source_tenant_id uuid NOT NULL,
        target_tenant_id uuid NOT NULL, shared_by uuid, access_level text NOT NULL DEFAULT 'read_only',
        created_at timestamptz DEFAULT now(), revoked_at timestamptz,
        CONSTRAINT shared_checks_unique_active UNIQUE (check_id, source_tenant_id, target_tenant_id));
      ALTER TABLE public.tenant_partnerships ENABLE ROW LEVEL SECURITY;
      CREATE POLICY aws_select_tenant_partnerships ON public.tenant_partnerships FOR SELECT TO authenticated
        USING (inviter_tenant_id IN (SELECT public.aws_user_tenant_ids()) OR invitee_tenant_id IN (SELECT public.aws_user_tenant_ids()));
      CREATE POLICY aws_write_tenant_partnerships ON public.tenant_partnerships FOR ALL TO authenticated
        USING (public.aws_can_write_tenant(inviter_tenant_id) OR public.aws_can_write_tenant(invitee_tenant_id))
        WITH CHECK (public.aws_can_write_tenant(inviter_tenant_id) OR public.aws_can_write_tenant(invitee_tenant_id));
      CREATE POLICY "Inviter can create partnerships" ON public.tenant_partnerships FOR INSERT TO authenticated WITH CHECK (true);
      CREATE POLICY "Partners can update partnerships" ON public.tenant_partnerships FOR UPDATE TO authenticated USING (true);
      CREATE POLICY "Admins can create any partnership" ON public.tenant_partnerships FOR INSERT TO authenticated WITH CHECK (true);
      CREATE POLICY "Admins can view any partnership" ON public.tenant_partnerships FOR SELECT TO authenticated USING (true);
      CREATE POLICY "Admins can update any partnership" ON public.tenant_partnerships FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
      GRANT USAGE ON SCHEMA auth TO authenticated;
      GRANT SELECT, INSERT, UPDATE ON public.tenant_partnerships TO checksops;
      GRANT EXECUTE ON FUNCTION public.aws_user_tenant_ids(), public.aws_can_write_tenant(uuid) TO authenticated;`);
    // The real trusted writer: aws_connect_partner_by_code (SECURITY DEFINER,
    // search_path=public, row_security=off) exactly as SQL 32 defines it.
    await seed.query(fs.readFileSync(SQL32_FILE, 'utf8'));
    const { rows: [connectRow] } = await seed.query(
      "SELECT prosrc, prosecdef, proconfig::text[] AS proconfig FROM pg_proc WHERE oid = to_regprocedure('public.aws_connect_partner_by_code(text, uuid)')",
    );
    assert.equal(sha(connectRow.prosrc), PARTNERSHIP_CONNECT_BODY_SHA256);
    assert.equal(connectRow.prosecdef, true);
    assert.deepEqual(connectRow.proconfig, [...PARTNERSHIP_CONNECT_CONFIG]);
    await seed.end();

    // read-live: the committed pin (no reviewed hash), the sentinel package, and a
    // session that PostgreSQL itself keeps read-only (any write would fail 25006).
    const readOnlyConnect = async () => {
      const client = await connect();
      await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
      return client;
    };
    const readLive = await handlerFor(readOnlyConnect, { sql76Pin: PIN })(consentEvent({
      action: 'inspect',
      expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
    }));
    assert.equal(readLive.ok, true, JSON.stringify(readLive));
    assert.equal(readLive.details.receipt.live_definition_sha256, ALL_PRESENT_BEFORE_SHA256);
    assert.equal(readLive.details.receipt.pin_executable, false);
    assert.equal(readLive.details.receipt.apply_preconditions_met, false);
    const check = await connect();
    const { rows: [counts] } = await check.query(
      "SELECT (SELECT count(*)::int FROM pg_policies WHERE tablename = 'tenant_partnerships') AS policies, (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.tenant_partnerships'::regclass AND NOT tgisinternal) AS triggers",
    );
    assert.deepEqual(counts, { policies: 7, triggers: 0 });
    await check.end();

    const handler = handlerFor(() => connect());
    const inspect = await handler(consentEvent({ action: 'inspect' }));
    assert.equal(inspect.ok, true, JSON.stringify(inspect));
    assert.equal(inspect.details.receipt.live_definition_sha256, ALL_PRESENT_BEFORE_SHA256, JSON.stringify(inspect.details.receipt.consent_state));
    assert.equal(inspect.details.receipt.consent_state.connect, 'pinned');
    assert.equal(inspect.details.receipt.consent_state.other_triggers, 'none');
    assert.equal(inspect.details.receipt.apply_preconditions_met, true);
    const applied = await handler(consentEvent());
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    assert.equal(applied.details.receipt.other_policy_count, 2);
    assert.equal(applied.details.receipt.other_trigger_count, 0);
    // Real catalog round-trip: the guard, trigger and marker read back as pinned.
    const after = await handler(consentEvent({ action: 'inspect' }));
    assert.deepEqual(
      {
        guard: after.details.receipt.consent_state.guard,
        trigger: after.details.receipt.consent_state.trigger,
        marker: after.details.receipt.consent_state.marker,
        connect: after.details.receipt.consent_state.connect,
        other_triggers: after.details.receipt.consent_state.other_triggers,
      },
      { guard: 'pinned', trigger: 'pinned', marker: 'pinned', connect: 'pinned', other_triggers: 'none' },
    );
    assert.equal((await handler(consentEvent())).code, CODES.UNRELATED_MUTATION);

    const app = await connect('checksops');
    const as = async (user, sql, params = []) => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('request.app_user_id', '${user}', true)`);
        // An array runs its statements in order in one transaction (no params).
        let rows = [];
        for (const statement of Array.isArray(sql) ? sql : [sql]) {
          rows = (await app.query(statement, Array.isArray(sql) ? [] : params)).rows;
        }
        await app.query('ROLLBACK');
        return rows[0] && 'result' in rows[0] ? rows[0].result : 'allowed';
      } catch (error) {
        await app.query('ROLLBACK');
        return error.code;
      }
    };
    const insertLive = 'INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status) VALUES ($1, $2, $3, \'active\')';
    assert.equal(await as(INVITER_USER, insertLive, [INVITER, INVITEE, 'DIRECT01']), '42501');
    assert.equal(await as(INVITEE_USER, insertLive, [INVITER, INVITEE, 'DIRECT02']), 'allowed');
    // Inviter redeeming the invitee's real Partner Code goes through the trusted writer.
    const connected = await as(INVITER_USER, 'SELECT public.aws_connect_partner_by_code($1, $2) AS result', [INVITEE_CODE, INVITER]);
    assert.equal(connected?.ok, true, JSON.stringify(connected));
    assert.equal(connected.created, true, JSON.stringify(connected));
    assert.equal(connected.partner_tenant_id, INVITEE);
    // Inviter cannot flip its own pending row to active directly.
    const pending = `INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status) VALUES ('${INVITER}', '${INVITEE}', 'PENDING1', 'pending')`;
    const activate = "UPDATE public.tenant_partnerships SET status = 'active', accepted_at = now() WHERE invite_code = 'PENDING1'";
    assert.equal(await as(INVITER_USER, [pending]), 'allowed');
    assert.equal(await as(INVITER_USER, [pending, activate]), '42501');
    await app.end();
  } finally {
    await admin.end();
    spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop'], server);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
});
