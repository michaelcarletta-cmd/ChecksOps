/**
 * Staging VPC executor support for SQL 84 (Mortgage Ops Return to Queue, the request
 * audit table and the per-check unique gate), SQL 85 (compensation Adjust, its
 * columns, indexes and CHECK, dropping the five-argument signature) and SQL 86 (the
 * SQL 47 compensation helper and reconciliation become platform owner only; EXECUTE
 * on earn_mortgage_agent_compensation is left to its owner).
 *
 * No pre-state is code-derived: each pin's expected hash is recorded from a guarded
 * staging read-live run (2026-10-16, main 2e500dad1: run 58 for SQL 84, run 59 for
 * SQL 85, run 60 for SQL 86; staging carries Cursor SQL 48 / 49 and SQL 47). Tests
 * that need the no-pre-state behaviour pass an explicit copy with the hash null
 * (UNRECORDED). The intended hash is code-derived; the PostgreSQL 16 tests re-derive
 * it and the definition hashes from the real catalog, starting from the real Cursor
 * SQL 47 / 48 / 49 files (fixtures), and apply through the handler with a pin copy
 * carrying the inspected pre-state.
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
  AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE as PIN84,
  AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST as PIN85,
  AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY as PIN86,
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
  BILLING_CHECK_1,
  CURSOR_SQL48_SHA256,
  CURSOR_SQL49_SHA256,
  DUPLICATE_BILLING_SQL,
  SQL47_SHA256,
  STAGING_PER_CHECK_INDEX_SQL,
  assertNoSeededPii,
  cursorSql48,
  cursorSql49,
  mortgageRolesSql,
  mortgageSchemaSql,
  sql47,
} from './helpers/mortgage-sql-pg.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-16T12:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');

const { module: executorModule } = await importGuardedSqlExecutor();
const {
  createHandler,
  parseMortgageSql,
  mortgageReviewedFunctiondefs,
  mortgageSqlIsReviewed,
  MORTGAGE_OUTSIDE_SHA256,
} = executorModule;

const KEYS = ['sql84', 'sql85', 'sql86'];
const PINS = { sql84: PIN84, sql85: PIN85, sql86: PIN86 };
// The pre-states recorded from the staging read-live runs of 2026-10-16 (run 58 /
// 38892001098, run 59 / 38892111590, run 60 / 38892218991).
const RECORDED_STAGING_PRE = {
  sql84: '53a0fa9f2b9cb126b3852a8b0595504fb74947c46a5a8390d67b46d7d67ad496',
  sql85: '7d5e766cf30a46e2925af225e9c2c19ee3cdb9a84ccf2685c23393f7cc06ee2d',
  sql86: 'c982ece2661a85293c2122c3aaf8226050d3c6670c436c94e34b870292289d0b',
};
// The committed pins with no recorded pre-state, for the no-pre-state refusals.
const UNRECORDED = Object.fromEntries(Object.entries(PINS).map(([key, pin]) => [key, { ...pin, expected_live_definition_sha256: null }]));
const CHOICES = { sql84: 'sql84-mortgage-return-to-queue', sql85: 'sql85-mortgage-compensation-adjust', sql86: 'sql86-mortgage-compensation-owner-only' };
const FILES = Object.fromEntries(KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)]));
const TEXT = Object.fromEntries(KEYS.map((key) => [key, fs.readFileSync(FILES[key], 'utf8')]));
const DEFS = Object.fromEntries(KEYS.map((key) => [key, mortgageReviewedFunctiondefs(key, TEXT[key])]));
const pinKey = { sql84: 'sql84Pin', sql85: 'sql85Pin', sql86: 'sql86Pin' };
const fileKey = { sql84: 'sqlFile84', sql85: 'sqlFile85', sql86: 'sqlFile86' };
const targets = (key) => MORTGAGE_MIGRATIONS[key].functions.filter((fn) => fn.role === 'target');

function mortgageEvent(key, overrides = {}) {
  const pin = overrides.pin || PINS[key];
  const oneUse = overrides.one_use_id || `${key}-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${CHOICES[key]}`,
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
const inspectEvent = (key, overrides = {}) => mortgageEvent(key, { action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL, ...overrides });

function handlerFor(connect, extra = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(
    os.tmpdir(),
    `sql8486-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile84: FILES.sql84, sqlFile85: FILES.sql85, sqlFile86: FILES.sql86, ...extra });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK TO)\b/i;

test('pins match the SQL files and their commit; pre-states recorded from read-live, post-states code-derived; registered everywhere', () => {
  assert.equal(PIN84.source_sha256, '0b6fe69b92e66f6e66a3a2438806e67cfa31d6c741802608881fb2fec5c9e806');
  assert.equal(PIN85.source_sha256, '4cc77457554ed9c24407db61bc292c168db0794ed7b884180554d69989e52b3d');
  assert.equal(PIN86.source_sha256, '1449df1f0c58aee2562e495d65e1327f4b6b4527005a55b5596b064de798df16');
  assert.equal(PIN84.migration_id, '84_mortgage_return_to_queue');
  assert.equal(PIN85.migration_id, '85_mortgage_compensation_adjust');
  assert.equal(PIN86.migration_id, '86_mortgage_compensation_owner_only');
  for (const key of KEYS) {
    const pin = PINS[key];
    assert.equal(sha(fs.readFileSync(FILES[key])), pin.source_sha256, key);
    // Recorded from the staging read-live run (not code-derived), and not the post-state.
    assert.equal(pin.expected_live_definition_sha256, RECORDED_STAGING_PRE[key], key);
    assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
    assert.equal(pin.intended_replacement_sha256, sha(mortgageStateText(key, mortgageAppliedStates(key))), key);
    assert.deepEqual([...pin.function_identities], MORTGAGE_MIGRATIONS[key].functions.filter((fn) => fn.role !== 'referenced').map((fn) => fn.identity));
    assert.equal(pin.migration, key);
    assert.ok(AUTHORIZED_STAGING_SQL.includes(pin), key);
    assert.equal(MIGRATIONS[CHOICES[key]], pin, key);
    assert.equal(resolveAuthorizedMigration({ filename: pin.filename, migration_id: pin.migration_id }), pin, key);
    assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === pin.filename && to === `sql/${path.basename(pin.filename)}`), key);
    assert.equal(sha(parseMortgageSql(key, TEXT[key]).outside), MORTGAGE_OUTSIDE_SHA256[key], key);
    assert.equal(mortgageSqlIsReviewed(key, TEXT[key]), true, key);
    for (const fn of targets(key)) assert.equal(sha(DEFS[key][fn.identity]), MORTGAGE_DEFINITION_SHA256[fn.identity], fn.identity);
    const atCommit = spawnSync('git', ['show', `${pin.commit}:${pin.filename}`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
    if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), pin.source_sha256, key);
  }
  assert.equal(PIN84.intended_replacement_sha256, 'ff920f5453283e9ca550bb8a191905386832f44e2e35567522530b806cb0e983');
  assert.equal(PIN85.intended_replacement_sha256, '051e82285f54c40b4af289956cf537e79123de5e5dad7e6b8d83dd528e778908');
  assert.equal(PIN86.intended_replacement_sha256, 'fb7e82291b146d0bf243dab1f607b2202b131c09cccac56e40de96c64542062f');
  assert.equal(sha(sql47()), SQL47_SHA256);
  assert.equal(sha(cursorSql48()), CURSOR_SQL48_SHA256);
  assert.equal(sha(cursorSql49()), CURSOR_SQL49_SHA256);
  // Authorization packages (read-live sentinel, and an apply with a recorded pre-state) evaluate.
  assert.equal(evaluateSqlExecutorAuthorization(inspectEvent('sql84'), { now: Date.parse(NOW) }).ok, true);
  const recorded = { ...PIN86, expected_live_definition_sha256: 'a'.repeat(64) };
  assert.equal(evaluateSqlExecutorAuthorization(mortgageEvent('sql86', { pin: recorded }), { now: Date.parse(NOW) }).ok, true);
  for (const key of KEYS) {
    assert.equal(evaluateSqlExecutorAuthorization(mortgageEvent(key), { now: Date.parse(NOW) }).ok, true, `${key} committed pin`);
    assert.equal(mortgageEvent(key).expected_live_definition_sha256, RECORDED_STAGING_PRE[key], key);
  }
});

test('the workflow offers the three pins and runs this test', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  const migrationInput = workflow.slice(workflow.indexOf('      migration:'), workflow.indexOf('      approved_commit:'));
  const options = [...migrationInput.matchAll(/^\s+- ([a-z0-9-]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(options, Object.keys(MIGRATIONS));
  for (const choice of Object.values(CHOICES)) assert.ok(options.includes(choice), choice);
  assert.match(workflow, /node --test aws\/tests\/sql84-sql86-mortgage-executor\.test\.mjs/);
});

test('the reviewed-text check refuses a wider grant, a missing revoke, an admin check, extra statements and a changed body', () => {
  const cases = {
    sql84: [
      ['security invoker', 'SECURITY DEFINER\nSET search_path = public', 'SECURITY INVOKER\nSET search_path = public'],
      ['no revoke public', 'REVOKE ALL ON FUNCTION public.return_mortgage_handling_request_to_queue(uuid, text) FROM PUBLIC;\n', ''],
      ['grant public', 'TO checksops, authenticated;\n', 'TO checksops, authenticated, PUBLIC;\n'],
      ['admin helper back', 'IF NOT COALESCE(public.is_platform_owner(), false) THEN', 'IF NOT public.aws_can_admin_mortgage_agent_compensation() THEN'],
      ['wider audit policy', 'USING (COALESCE(public.is_platform_owner(), false));', 'USING (true);'],
      ['extra statement', 'GRANT SELECT ON TABLE public.mortgage_ops_request_audit TO checksops, authenticated;', 'GRANT SELECT ON TABLE public.mortgage_ops_request_audit TO checksops, authenticated;\nGRANT UPDATE ON TABLE public.mortgage_handling_requests TO authenticated;'],
    ],
    sql85: [
      ['no drop of the five-argument body', 'DROP FUNCTION IF EXISTS public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text);\n', ''],
      ['grant public', 'TO checksops, authenticated;', 'TO checksops, authenticated, PUBLIC;'],
      ['row_security on', 'SET search_path = public\nSET row_security = off\nAS $$\nDECLARE\n  v_parent', 'SET search_path = public\nSET row_security = on\nAS $$\nDECLARE\n  v_parent'],
      ['changed cap', "RAISE EXCEPTION 'adjustment_exceeds_net'", "RAISE NOTICE 'adjustment_exceeds_net'"],
      ['wider action check', "CHECK (action IN ('approve', 'pay', 'adjust'))", "CHECK (action IN ('approve', 'pay', 'adjust', 'clawback'))"],
    ],
    sql86: [
      ['admin back in the helper', '  SELECT COALESCE(public.is_platform_owner(), false);\n$$;', "  SELECT COALESCE(public.is_platform_owner(), false) OR public.has_role(auth.uid(), 'admin'::public.app_role);\n$$;"],
      ['no earn revoke from authenticated', 'REVOKE ALL ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM authenticated;\n', ''],
      ['no earn guard', "RAISE EXCEPTION 'earn_owner_unsafe: earn_mortgage_agent_compensation owner %", "RAISE NOTICE 'earn_owner_unsafe: earn_mortgage_agent_compensation owner %"],
      ['reconciliation check removed', "  IF NOT public.aws_can_admin_mortgage_agent_compensation() THEN\n    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';\n  END IF;\n\n  RETURN QUERY", '  RETURN QUERY'],
    ],
  };
  for (const [key, list] of Object.entries(cases)) {
    for (const [label, from, to] of list) {
      const text = TEXT[key].replace(from, to);
      assert.notEqual(text, TEXT[key], `${key} ${label}`);
      assert.equal(mortgageSqlIsReviewed(key, text), false, `${key} ${label}`);
    }
    assert.equal(mortgageSqlIsReviewed(key, `${TEXT[key]}\nDO $$ BEGIN END $$;\n`), false, `${key} trailing DO`);
  }
  // Another migration's file is not this one; the Cursor files are not the reviewed ones.
  assert.equal(mortgageSqlIsReviewed('sql84', TEXT.sql85), false);
  assert.equal(mortgageSqlIsReviewed('sql86', TEXT.sql84), false);
  assert.equal(mortgageSqlIsReviewed('sql84', cursorSql48()), false);
  assert.equal(mortgageSqlIsReviewed('sql85', cursorSql49()), false);
  // Comments alone do not matter (the bytes are still pinned by source_sha256).
  assert.equal(mortgageSqlIsReviewed('sql84', TEXT.sql84.replace('-- Idempotent: safe to run more than once.', '-- (reworded)')), true);
});

test('apply refuses before connecting: a pin with no pre-state, the read-live sentinel, a wrong hash, a forged pin, a tampered file', async () => {
  for (const key of KEYS) {
    const pin = PINS[key];
    // A pin with no recorded pre-state (explicit copy; the committed pins are recorded).
    const pending = await handlerFor(neverConnect, { [pinKey[key]]: UNRECORDED[key] })(mortgageEvent(key, { pin: UNRECORDED[key], expected_live_definition_sha256: 'b'.repeat(64) }));
    assert.equal(pending.code, CODES.SQL_COLLISION, key);
    assert.match(pending.message, /no reviewed pre-apply live definition hash/, key);
    // The committed (recorded) pin: any other hash, or the read-live sentinel, is refused.
    for (const expected of ['b'.repeat(64), READ_LIVE_EXPECTED_SENTINEL]) {
      const committed = await handlerFor(neverConnect)(mortgageEvent(key, { expected_live_definition_sha256: expected }));
      assert.equal(committed.code, CODES.SQL_COLLISION, key);
      assert.match(committed.message, /bound to the exact allowlisted pin/, key);
    }
    const recorded = { ...pin, expected_live_definition_sha256: 'a'.repeat(64) };
    const extra = { [pinKey[key]]: recorded };
    const sentinel = await handlerFor(neverConnect, extra)(mortgageEvent(key, { pin: recorded, expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
    assert.equal(sentinel.code, CODES.SQL_COLLISION, key);
    assert.match(sentinel.message, /bound to the exact allowlisted pin/, key);
    const other = await handlerFor(neverConnect, extra)(mortgageEvent(key, { pin: recorded, expected_live_definition_sha256: 'b'.repeat(64) }));
    assert.equal(other.code, CODES.SQL_COLLISION, key);
    const wrongIntended = await handlerFor(neverConnect, extra)(mortgageEvent(key, { pin: recorded, intended_replacement_sha256: 'c'.repeat(64) }));
    assert.equal(wrongIntended.ok, false, key);
    for (const forged of [
      { ...recorded, intended_replacement_sha256: 'c'.repeat(64) },
      { ...recorded, function_identities: [...recorded.function_identities, 'public.approve_mortgage_agent_compensation(uuid[], text)'] },
      { ...recorded, commit: 'f'.repeat(40) },
    ]) {
      const result = await handlerFor(neverConnect, { [pinKey[key]]: forged })(mortgageEvent(key, { pin: recorded }));
      assert.equal(result.code, CODES.SQL_COLLISION, key);
      assert.match(result.message, /committed allowlist entry/, key);
    }
    const unsupported = await handlerFor(neverConnect, extra)(mortgageEvent(key, { pin: recorded, action: 'drop' }));
    assert.equal(unsupported.ok, false, key);
    const tampered = path.join(os.tmpdir(), `sql8486-tampered-${process.pid}-${key}.sql`);
    fs.writeFileSync(tampered, `${TEXT[key]}GRANT EXECUTE ON FUNCTION ${pin.function_identities[0]} TO PUBLIC;\n`);
    try {
      const result = await handlerFor(neverConnect, { ...extra, [fileKey[key]]: tampered })(mortgageEvent(key, { pin: recorded }));
      assert.equal(result.code, CODES.SQL_COLLISION, key);
    } finally {
      fs.rmSync(tampered, { force: true });
    }
  }
});

// --- PostgreSQL 16 ---------------------------------------------------------------

const OWNER = 'mortgage_exec_login';

async function stagingFixture(pg, prefix, port, { cursor = true } = {}) {
  const server = startPg(prefix, port);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await admin.query(mortgageRolesSql(OWNER));
    // SQL 47 (and staging's Cursor SQL 48 / 49 and per-check index), created by the executor login.
    const owner = await connectAs(OWNER);
    try {
      await owner.query(mortgageSchemaSql());
      if (cursor) {
        await owner.query(STAGING_PER_CHECK_INDEX_SQL);
        await owner.query(cursorSql48());
        await owner.query(cursorSql49());
      }
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

test('PostgreSQL 16: from SQL 47 and Cursor SQL 48/49, inspect reports the live state read-only; SQL 84, 85 and 86 land on the code-derived hashes once', { timeout: 240000 }, async (t) => {
  const pg = await loadPg(t);
  if (!pg) return;
  const { server, admin, connectAs } = await stagingFixture(pg, 'pg-sql8486-exec-', 57500);
  try {
    const seen = [];
    const connect = async () => {
      const client = await connectAs(OWNER);
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    for (const key of KEYS) {
      seen.length = 0;
      const before = await handlerFor(connect, { [pinKey[key]]: UNRECORDED[key] })(inspectEvent(key, { pin: UNRECORDED[key] }));
      assert.equal(before.ok, true, JSON.stringify(before));
      const receipt = before.details.receipt;
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.equal(seen.at(-1), 'ROLLBACK');
      assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      const report = receipt.mortgage_inspect;
      assert.deepEqual(receipt.precondition_failures, [], `${key}: ${JSON.stringify(report)}`);
      assert.equal(receipt.sql47_prerequisites_present, true);
      assert.equal(receipt.pin_executable, false);
      assert.equal(receipt.apply_preconditions_met, false, 'a pin with no pre-state');
      assert.notEqual(receipt.live_definition_sha256, PINS[key].intended_replacement_sha256);
      // This fixture (SQL 47 and the real Cursor SQL 48 / 49 files with staging's per-check
      // index, owned by the executor login) reproduces the pre-state recorded from the staging
      // read-live run, so the committed pin is ready to apply here.
      assert.equal(receipt.live_definition_sha256, RECORDED_STAGING_PRE[key], key);
      const committedReceipt = (await handlerFor(connect)(inspectEvent(key))).details.receipt;
      assert.equal(committedReceipt.pin_executable, true, key);
      assert.equal(committedReceipt.apply_preconditions_met, true, key);
      assert.ok(report.prerequisites.every((row) => row.present), key);
      assert.deepEqual(report.missing_columns, {});
      if (key === 'sql84') {
        const fn = report.functions.return_mortgage_handling_request_to_queue;
        assert.equal(fn.state, 'cursor_original');
        assert.equal(fn.definition_sha256, MORTGAGE_KNOWN_DEFINITION_SHA256['public.return_mortgage_handling_request_to_queue(uuid, text)'].cursor_original);
        assert.equal(fn.body_matches_migration, false);
        assert.deepEqual(fn.acl_entries, ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE']);
        assert.equal(report.audit_table.present, true);
        assert.equal(report.audit_table.columns_match, true);
        assert.equal(report.audit_table.policies[0].matches_migration, false, 'Cursor SQL 48 policy uses the admin helper');
        assert.equal(report.per_check_unique_present, true);
        const staging = report.billing_per_check_indexes.find((row) => row.name === 'check_billing_events_mortgage_ops_check_uidx');
        assert.deepEqual({ kind: staging.predicate_kind, gate0: staging.matches_gate0, valid: staging.valid }, { kind: 'staging', gate0: true, valid: true });
        assert.deepEqual(report.billing_duplicates, { readable: true, groups: 0, extra_events: 0 });
      }
      if (key === 'sql85') {
        assert.equal(report.functions.adjust_mortgage_agent_compensation.exists, false);
        assert.equal(report.functions.adjust_mortgage_agent_compensation_five_arg.state, 'cursor_original');
        assert.deepEqual(report.functions.adjust_mortgage_agent_compensation.named_signatures.map((row) => row.signature),
          ['public.adjust_mortgage_agent_compensation(uuid,integer,text,uuid,text)']);
        assert.deepEqual(report.added_columns, { adjustment_reason: 'text', idempotency_key: null });
        assert.equal(report.indexes.mortgage_agent_compensation_entries_parent_idx.matches_migration, true);
        assert.equal(report.action_check.mortgage_agent_compensation_batches_action_check.includes_adjust, true);
        assert.deepEqual(report.batch_actions_outside_check, { readable: true, count: 0 });
      }
      if (key === 'sql86') {
        for (const name of ['aws_can_admin_mortgage_agent_compensation', 'mortgage_agent_compensation_reconciliation', 'earn_mortgage_agent_compensation']) {
          assert.equal(report.functions[name].state, 'ledger_original', name);
        }
        assert.deepEqual(report.functions.earn_mortgage_agent_compensation.acl_entries, ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE']);
        assert.equal(report.earn_owner.earn_owner_safe, true);
        assert.equal(report.earn_owner.same_owner, true);
      }
      assertNoSeededPii(assert, before, `${key} executor result`);
      const summary = readLiveSummary({ ok: true, details: before }, { migration: CHOICES[key], pin: UNRECORDED[key] });
      assert.equal(summary.ok, true, JSON.stringify(summary));
      assert.deepEqual(summary.details.mortgage_inspect, JSON.parse(JSON.stringify(report)), `${key} read-live keeps the whole report`);
      assertNoSeededPii(assert, summary, `${key} read-live summary`);
      assert.equal(JSON.stringify(report).includes(OWNER), false, 'no owner names in the staging report');

      const recorded = { ...PINS[key], expected_live_definition_sha256: receipt.live_definition_sha256 };
      const handler = handlerFor(connect, { [pinKey[key]]: recorded });
      assert.equal((await handler(inspectEvent(key, { pin: recorded }))).details.receipt.apply_preconditions_met, true);
      const event = mortgageEvent(key, { pin: recorded });
      const applied = await handler(event);
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal(applied.details.receipt.after_hash, PINS[key].intended_replacement_sha256);
      const after = (await handler(inspectEvent(key, { pin: recorded }))).details.receipt;
      assert.equal(after.live_definition_sha256, PINS[key].intended_replacement_sha256);
      assert.equal(after.already_applied, true);
      assert.equal(after.apply_preconditions_met, false);
      // The hashes are pg_get_functiondef under search_path pg_catalog, as the executor reads them.
      await admin.query("SELECT set_config('search_path', 'pg_catalog', false)");
      for (const fn of targets(key)) {
        const row = (await admin.query(`SELECT encode(sha256(convert_to(pg_get_functiondef($1::regprocedure), 'UTF8')), 'hex') AS def_sha,
          pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = $1::regprocedure`, [fn.identity])).rows[0];
        assert.equal(row.def_sha, MORTGAGE_DEFINITION_SHA256[fn.identity], fn.identity);
        assert.equal(row.owner, OWNER);
        assert.equal(after.mortgage_inspect.functions[fn.key].matches_migration, true);
        assert.equal(after.mortgage_inspect.functions[fn.key].body_matches_migration, true);
      }
      assert.equal((await handler(event)).code, CODES.SQL_COLLISION, 'replay');
      const reapply = await handler(mortgageEvent(key, { pin: recorded }));
      assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
      assert.match(reapply.message, /already in place/);
    }
    // No fallback index on top of staging's; the five-argument body is gone; earn is owner-only.
    const facts = (await admin.query(`SELECT
      to_regclass('public.check_billing_events_one_mortgage_ops_per_check') IS NULL AS no_fallback,
      to_regprocedure('public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text)') IS NULL AS five_dropped,
      has_function_privilege('authenticated', 'public.earn_mortgage_agent_compensation(uuid)', 'EXECUTE') AS earn_authenticated,
      has_function_privilege('authenticated', 'public.return_mortgage_handling_request_to_queue(uuid, text)', 'EXECUTE') AS return_authenticated`)).rows[0];
    assert.deepEqual(facts, { no_fallback: true, five_dropped: true, earn_authenticated: false, return_authenticated: true });
  } finally {
    await admin.end();
    server.stop();
  }
});

test('PostgreSQL 16: duplicate billing events, an unsafe earn owner, another signature, a different audit table and an extra grant fail closed; drift is a collision; a failing statement rolls back', { timeout: 240000 }, async (t) => {
  const pg = await loadPg(t);
  if (!pg) return;
  // Production-like: no Cursor SQL 48 / 49 and no staging per-check index.
  const { server, admin, connectAs } = await stagingFixture(pg, 'pg-sql8486-clash-', 57600, { cursor: false });
  try {
    const connect = () => connectAs(OWNER);
    const owner = await connectAs(OWNER);
    const inspect = async (key, pin = PINS[key]) => (await handlerFor(connect, { [pinKey[key]]: pin })(inspectEvent(key, { pin }))).details.receipt;
    const refusedThenRestored = async (key, label, breakIt, restore, failures, as = owner) => {
      await as.query(breakIt);
      const receipt = await inspect(key);
      for (const failure of failures) assert.ok(receipt.precondition_failures.includes(failure), `${label}: ${JSON.stringify(receipt.precondition_failures)}`);
      const recorded = { ...PINS[key], expected_live_definition_sha256: receipt.live_definition_sha256 };
      const refused = await handlerFor(connect, { [pinKey[key]]: recorded })(mortgageEvent(key, { pin: recorded }));
      assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(refused)}`);
      await as.query(restore);
      assert.deepEqual((await inspect(key)).precondition_failures, [], `${label} restored`);
    };

    // Clean production-like pre-state: SQL 84 would create the fallback index.
    const clean84 = await inspect('sql84');
    assert.deepEqual(clean84.precondition_failures, []);
    assert.equal(clean84.mortgage_inspect.per_check_unique_present, false);
    assert.equal(clean84.mortgage_inspect.audit_table.present, false);
    assert.equal(clean84.function_states.return_mortgage_handling_request_to_queue, 'absent');
    // Without Cursor SQL 48 this is not the recorded staging pre-state: the committed pin would refuse it.
    assert.notEqual(clean84.live_definition_sha256, PINS.sql84.expected_live_definition_sha256);
    assert.equal(clean84.apply_preconditions_met, false);

    await refusedThenRestored('sql84', 'duplicate non-voided per-check Mortgage Ops events',
      DUPLICATE_BILLING_SQL,
      `DELETE FROM public.check_billing_events WHERE check_intake_item_id = '${BILLING_CHECK_1}' AND event_type = 'mortgage_ops_additional_check'`,
      ['no_duplicate_mortgage_ops_billing_events']);
    const dupes = async () => {
      await owner.query(DUPLICATE_BILLING_SQL);
      const receipt = await inspect('sql84');
      await owner.query(`DELETE FROM public.check_billing_events WHERE check_intake_item_id = '${BILLING_CHECK_1}' AND event_type = 'mortgage_ops_additional_check'`);
      return receipt.mortgage_inspect.billing_duplicates;
    };
    assert.deepEqual(await dupes(), { readable: true, groups: 1, extra_events: 1 });
    await refusedThenRestored('sql84', 'an invalid index holding the fallback name',
      `CREATE UNIQUE INDEX check_billing_events_one_mortgage_ops_per_check ON public.check_billing_events (check_intake_item_id) WHERE event_type = 'mortgage_ops_initial'`,
      'DROP INDEX public.check_billing_events_one_mortgage_ops_per_check',
      ['fallback_index_name_free']);
    await refusedThenRestored('sql84', 'an audit table with another column',
      'CREATE TABLE public.mortgage_ops_request_audit (id uuid PRIMARY KEY, note text)',
      'DROP TABLE public.mortgage_ops_request_audit',
      ['audit_table_columns_match']);
    await refusedThenRestored('sql84', 'another signature of return_mortgage_handling_request_to_queue',
      'CREATE FUNCTION public.return_mortgage_handling_request_to_queue(p_request_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$',
      'DROP FUNCTION public.return_mortgage_handling_request_to_queue(uuid)',
      ['no_other_signature:return_mortgage_handling_request_to_queue']);
    await refusedThenRestored('sql85', 'a third signature of adjust_mortgage_agent_compensation',
      'CREATE FUNCTION public.adjust_mortgage_agent_compensation(p uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
      'DROP FUNCTION public.adjust_mortgage_agent_compensation(uuid)',
      ['no_other_signature:adjust_mortgage_agent_compensation']);
    await refusedThenRestored('sql85', 'a batch action outside the new CHECK',
      `ALTER TABLE public.mortgage_agent_compensation_batches DROP CONSTRAINT mortgage_agent_compensation_batches_action_check;
       INSERT INTO public.mortgage_agent_compensation_batches (action) VALUES ('clawback')`,
      `DELETE FROM public.mortgage_agent_compensation_batches WHERE action = 'clawback';
       ALTER TABLE public.mortgage_agent_compensation_batches ADD CONSTRAINT mortgage_agent_compensation_batches_action_check CHECK (action IN ('approve', 'pay'))`,
      ['batch_actions_within_new_check']);
    await refusedThenRestored('sql86', 'an earn owner that differs from the completion trigger function',
      'CREATE ROLE migrator NOLOGIN; ALTER FUNCTION public.earn_mortgage_agent_compensation(uuid) OWNER TO migrator',
      `ALTER FUNCTION public.earn_mortgage_agent_compensation(uuid) OWNER TO ${OWNER}; DROP ROLE migrator`,
      ['earn_owner_safe', 'owner_is_login:earn_mortgage_agent_compensation'], admin);
    await refusedThenRestored('sql86', 'an earn owner inside checksops',
      `GRANT checksops TO ${OWNER}`,
      `REVOKE checksops FROM ${OWNER}`,
      ['earn_owner_safe'], admin);
    await refusedThenRestored('sql86', 'an anon EXECUTE grant on earn the file does not revoke',
      'CREATE ROLE anon NOLOGIN; GRANT EXECUTE ON FUNCTION public.earn_mortgage_agent_compensation(uuid) TO anon',
      'REVOKE EXECUTE ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM anon; DROP ROLE anon',
      ['acl_replaceable:earn_mortgage_agent_compensation'], admin);

    // Drift between the recorded inspect and the apply: DEPLOYMENT_COLLISION, nothing changed.
    const recorded86 = { ...PINS.sql86, expected_live_definition_sha256: (await inspect('sql86')).live_definition_sha256 };
    await owner.query('REVOKE EXECUTE ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM authenticated');
    const collision = await handlerFor(connect, { sql86Pin: recorded86 })(mortgageEvent('sql86', { pin: recorded86 }));
    assert.equal(collision.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(collision));
    assert.match(collision.message, /not the pinned pre-apply state/);
    await owner.query('GRANT EXECUTE ON FUNCTION public.earn_mortgage_agent_compensation(uuid) TO authenticated');

    // A file that also changes something unrelated rolls back.
    const before84 = await inspect('sql84');
    const recorded84 = { ...PINS.sql84, expected_live_definition_sha256: before84.live_definition_sha256 };
    const wrap = (extra) => async () => {
      const client = await connectAs(OWNER);
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql) === TEXT.sql84 ? query(`${sql}\n${extra}`, params) : query(sql, params));
      return client;
    };
    const unrelated = await handlerFor(wrap('ALTER TABLE public.mortgage_agent_compensation_entries DISABLE ROW LEVEL SECURITY;'), { sql84Pin: recorded84 })(mortgageEvent('sql84', { pin: recorded84 }));
    assert.equal(unrelated.code, CODES.UNRELATED_MUTATION, JSON.stringify(unrelated));
    assert.deepEqual(unrelated.details.unrelated_changed, ['relations_sha256']);
    const column = await handlerFor(wrap('ALTER TABLE public.check_billing_events ADD COLUMN note text;'), { sql84Pin: recorded84 })(mortgageEvent('sql84', { pin: recorded84 }));
    assert.equal(column.code, CODES.UNRELATED_MUTATION);
    assert.deepEqual(column.details.unrelated_changed, ['columns_sha256']);
    const publicGrant = await handlerFor(wrap('GRANT EXECUTE ON FUNCTION public.return_mortgage_handling_request_to_queue(uuid, text) TO PUBLIC;'), { sql84Pin: recorded84 })(mortgageEvent('sql84', { pin: recorded84 }));
    assert.equal(publicGrant.code, CODES.UNRELATED_MUTATION);
    assert.ok(publicGrant.details.failed.includes('execute_as_reviewed:return_mortgage_handling_request_to_queue'));
    assert.equal((await inspect('sql84')).live_definition_sha256, before84.live_definition_sha256);

    // A statement failing half-way: nothing of SQL 85 stays.
    const before85 = await inspect('sql85');
    const recorded85 = { ...PINS.sql85, expected_live_definition_sha256: before85.live_definition_sha256 };
    const failing = async () => {
      const client = await connectAs(OWNER);
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql) === TEXT.sql85
        ? query(String(sql).replace('(uuid, integer, text, uuid, text, text)\n  TO checksops, authenticated;', '(uuid, integer, text, uuid, text, text)\n  TO sql8486_missing_role;'), params)
        : query(sql, params));
      return client;
    };
    const result = await handlerFor(failing, { sql85Pin: recorded85 })(mortgageEvent('sql85', { pin: recorded85 }));
    assert.equal(result.code, CODES.UNRELATED_MUTATION, JSON.stringify(result));
    assert.equal((await inspect('sql85')).live_definition_sha256, before85.live_definition_sha256);

    // From the production-like pre-state each file lands on the same intended hash as from staging's.
    for (const key of KEYS) {
      const receipt = await inspect(key);
      assert.deepEqual(receipt.precondition_failures, [], key);
      const recorded = { ...PINS[key], expected_live_definition_sha256: receipt.live_definition_sha256 };
      const applied = await handlerFor(connect, { [pinKey[key]]: recorded })(mortgageEvent(key, { pin: recorded }));
      assert.equal(applied.ok, true, `${key}: ${JSON.stringify(applied)}`);
      assert.equal(applied.details.receipt.after_hash, PINS[key].intended_replacement_sha256, key);
    }
    assert.equal((await admin.query("SELECT to_regclass('public.check_billing_events_one_mortgage_ops_per_check') IS NOT NULL AS p")).rows[0].p, true);
    await owner.end();
  } finally {
    await admin.end();
    server.stop();
  }
});
