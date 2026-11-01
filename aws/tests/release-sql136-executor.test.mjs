/**
 * SQL 136 (aws/workflows/sql/136_money_write_restrictive_policies.sql) in the staging guarded executor, on
 * the release engine shared with SQL 90-138 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 136 included); this file
 * covers what is new:
 *
 *   - the pin: pending (no read-live yet, and none before #1498's API is live in staging), code-derived,
 *     selectable, packed, in step with the pending production pin; the pinned commit authored the bytes;
 *     no predecessor;
 *   - the spec: one new SECURITY INVOKER function (aws_money_write_allowed(), EXECUTE authenticated,
 *     checksops and the owner) and 72 RESTRICTIVE policies TO authenticated (INSERT / UPDATE / DELETE on
 *     each of the 24 money tables, never FOR ALL); the 24 tables are altered_relations; the three
 *     extra preconditions read catalog counts and fail closed on null; the expected pre-state (nothing of
 *     the file present) is derived here;
 *   - on PostgreSQL 16 (the 24 tables as the repository leaves them, owned by checksops_admin): the
 *     read-live reads the derived pre-state, read-only; FORCE RLS, an RLS-bound DEFINER writer or a
 *     SECURITY INVOKER trigger writer each refuses before any statement runs; a pending pin and drift
 *     cannot apply; one apply reaches the intended fingerprint, then is refused as already in place.
 * The behaviour of the policies is aws/tests/sql136-money-write-restrictive-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL136_MONEY_WRITE_RESTRICTIVE_POLICIES,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPreconditionFailures,
  releaseStateHash,
  releaseStateText,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { MEMBER_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { MONEY_TABLES, moneySchema } from './helpers/sql136-money-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-01T12:00:00.000Z';
const KEY = 'sql136';
const FUNCTION = 'public.aws_money_write_allowed()';
const GATE = 'public.aws_money_write_allowed()';
const ACL = Object.freeze(['authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']);
/** The expected pre-state (nothing of the file present), derived below and read back on PostgreSQL 16. */
const PRE_EXPECTED = '6b404964de5ee203e126bc3ce78395c9a9e2fbf3a1e41eb0b5ccd8fa3e3ea150';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const INTENDED = releaseIntendedState(KEY, TEXT);
const absent = () => ({
  ...INTENDED,
  functions: { [FUNCTION]: { exists: false } },
  policies: Object.fromEntries(Object.keys(INTENDED.policies).map((k) => [k, { exists: false }])),
});
const PRE = releaseStateHash(KEY, absent());

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(overrides = {}) {
  const pin = overrides.pin || PINS[KEY];
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[KEY].choice}`,
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
    one_use_id: `${KEY}-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-11-01T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql136-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 136 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL136_MONEY_WRITE_RESTRICTIVE_POLICIES, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/136_money_write_restrictive_policies.sql');
  assert.equal(pin.migration_id, '136_money_write_restrictive_policies');
  assert.equal(spec.choice, 'sql136-money-write-restrictive-policies');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-11-01, "record the SQL 136 staging pin") from staging read-live
  // run 41313668204, taken after #1498's API was live in staging: already_applied false, precondition_failures [].
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-01: staging apply (wave 34) from staging read-live run 41313668204');
  assert.equal(pin.expected_live_definition_sha256, PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, 'f8269d3e1f788d50ad0cbbb4b95829b3ee83b05cda91798c5f57491c8e5d26a7');
  assert.equal(PRE, PRE_EXPECTED);
  assert.notEqual(PRE, pin.intended_replacement_sha256);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql136-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [FUNCTION]);
  assert.deepEqual(spec.predecessors, []);
  for (const none of ['supersedes', 'runs_before', 'refuse_after', 'definer_writes', 'table_privileges', 'whole_tables']) assert.equal(spec[none], undefined, none);
  // Nothing supersedes, refuses after or depends on SQL 136; no other release key touches its function or policies.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    assert.ok(!other.functions.some((fn) => fn.identity === FUNCTION), key);
    assert.ok(!(other.policies || []).some((p) => p.name.startsWith('aws_money_write_gate_')), key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [FUNCTION]);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.ok(prod.production_inspect.note.includes(PRE));
  assert.ok(prod.order_note.includes(PRE));
  for (const text of [prod.order_note, prod.staging_acceptance.basis, prod.production_inspect.note]) assert.match(text, /#1498/);
  assert.match(prod.order_note, /MUST NOT be applied in production before #1498's API is live in production/);
  // The runbook: the STOP gate, the pre-state and intended fingerprints and texts, the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-136-apply.md'), 'utf8');
  assert.match(runbook, /## STOP: the API first/);
  assert.match(runbook, /\*\*Status:\*\* staging pin execute-authorized \(wave 34\); not applied anywhere\. The production pin is pending/);
  assert.match(runbook, /read-live \(2026-11-01\)\.\*\* Run 41313668204/);
  for (const value of [PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, INTENDED)}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, absent())}\n\`\`\``));
  let bytes = null;
  if (/^[0-9a-f]{40}$/.test(pin.commit)) {
    try {
      bytes = execFileSync('git', ['-C', ROOT, 'show', `${pin.commit}:${pin.filename}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      bytes = null;
    }
  }
  if (bytes !== null) assert.equal(sha(bytes), pin.source_sha256, 'the pinned commit carries the pinned bytes');
});

test('reviewed file and spec: one SECURITY INVOKER gate and three RESTRICTIVE policies per money table, never FOR ALL; prerequisites, altered relations and the fail-closed counts', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: FUNCTION, acl: [...ACL] }]);
  const fn = INTENDED.functions[FUNCTION];
  assert.equal(fn.language, 'sql');
  assert.equal(fn.volatility, 's');
  assert.equal(fn.security_definer, false);
  assert.equal(fn.result, 'boolean');
  assert.deepEqual(fn.config, []);
  for (const guc of ["current_setting('request.money_write', true) = '1'", "current_setting('request.financial_execution', true) = '1'",
    'public.aws_moov_onboarding_active()', 'public.aws_moov_webhook_apply_active()']) {
    assert.ok(TEXT.includes(guc), guc);
  }
  assert.equal(spec.policies.length, 72);
  for (const table of MONEY_TABLES) {
    const rows = spec.policies.filter((p) => p.table === `public.${table}`);
    assert.deepEqual(rows.map((p) => [p.name, p.cmd, p.permissive, [...p.roles], p.qual, p.with_check]), [
      [`aws_money_write_gate_insert_${table}`, 'INSERT', false, ['authenticated'], null, GATE],
      [`aws_money_write_gate_update_${table}`, 'UPDATE', false, ['authenticated'], GATE, GATE],
      [`aws_money_write_gate_delete_${table}`, 'DELETE', false, ['authenticated'], GATE, null],
    ], table);
  }
  assert.ok(spec.policies.every((p) => p.cmd !== 'ALL' && p.cmd !== 'SELECT'));
  assert.deepEqual([...spec.altered_relations], MONEY_TABLES.map((t) => `public.${t}`));
  assert.deepEqual([...spec.prerequisites], [...MONEY_TABLES.map((t) => `public.${t}`),
    'public.aws_moov_onboarding_active()', 'public.aws_moov_webhook_apply_active()', 'role checksops', 'role authenticated']);
  assert.deepEqual([...spec.extra_preconditions], ['money_tables_not_forced_rls', 'money_definer_writers_bypass_rls', 'no_invoker_trigger_money_writers']);
  assert.deepEqual(Object.keys(spec.counts), ['money_tables_forced_rls', 'money_definer_writers_without_bypass', 'money_invoker_trigger_writers', 'money_invoker_function_writers']);
  // Catalog only: every count reads pg_catalog, never a money table's rows.
  for (const [name, count] of Object.entries(spec.counts)) {
    assert.match(count.sql, /^SELECT count\(/, name);
    assert.doesNotMatch(count.sql.replace(/'public\.[a-z_]+'/g, ''), /\bFROM public\./, name);
  }
  // The file: the precondition block reads, every other statement is the function, its grants and comment, and policies.
  const statements = TEXT.replace(/--[^\n]*/g, '').replace(/\$sql136_preconditions\$[\s\S]*?\$sql136_preconditions\$/, 'DO').replace(/\$\$[\s\S]*?\$\$/, 'BODY')
    .split(';').map((s) => s.trim().split(/\s+/).slice(0, 3).join(' ')).filter(Boolean);
  assert.ok(statements.every((s) => /^(DO|CREATE OR REPLACE|COMMENT ON FUNCTION|REVOKE ALL ON|GRANT EXECUTE ON|DROP POLICY IF|CREATE POLICY aws_money_write_gate_)/.test(s)), JSON.stringify(statements.filter((s) => !/^(DO|CREATE OR REPLACE|COMMENT ON FUNCTION|REVOKE ALL ON|GRANT EXECUTE ON|DROP POLICY IF|CREATE POLICY aws_money_write_gate_)/.test(s))));
  assert.doesNotMatch(TEXT.replace(/--[^\n]*/g, '').replace(/\$sql136_preconditions\$[\s\S]*?\$sql136_preconditions\$/, ''), /\b(ALTER TABLE|INSERT INTO|DELETE FROM|TRUNCATE|DROP TABLE|DROP FUNCTION|SECURITY DEFINER|FOR ALL)\b/);
  for (const code of ['sql136_table_missing', 'sql136_function_missing', 'sql136_role_missing', 'sql136_force_rls',
    'sql136_definer_writer_cannot_bypass_rls', 'sql136_invoker_trigger_writes_money_table']) {
    assert.ok(TEXT.includes(`'${code}:`), code);
  }

  // The extra preconditions fail closed on a non-zero or unreadable (null) count.
  const live = (counts) => ({
    current_user: 'checksops_admin',
    prerequisites_missing: [],
    predecessors_applied: true,
    successors_applied: [],
    dependents: {},
    dropped_function_callers: [],
    functions: { [FUNCTION]: { exists: false } },
    altered: Object.fromEntries(MONEY_TABLES.map((t) => [`public.${t}`, { exists: true, owner_is_login: true }])),
    counts: { money_tables_forced_rls: 0, money_definer_writers_without_bypass: 0, money_invoker_trigger_writers: 0, money_invoker_function_writers: 3, ...counts },
  });
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({}), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ money_tables_forced_rls: 1 }), PINS[KEY]), ['money_tables_not_forced_rls']);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ money_definer_writers_without_bypass: 2 }), PINS[KEY]), ['money_definer_writers_bypass_rls']);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ money_invoker_trigger_writers: 1 }), PINS[KEY]), ['no_invoker_trigger_money_writers']);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ money_tables_forced_rls: null, money_invoker_trigger_writers: null }), PINS[KEY]),
    ['money_tables_not_forced_rls', 'no_invoker_trigger_money_writers']);
  const notOwned = live({});
  notOwned.altered['public.payment_transfers'] = { exists: true, owner_is_login: false };
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, notOwned, PINS[KEY]), ['altered_relations_owned_by_login']);
});

test('PostgreSQL 16: SQL 136 through the executor: the pre-state as derived, read-only; FORCE RLS, an RLS-bound DEFINER writer and an INVOKER trigger writer refuse first; a pending pin and drift cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await releaseFixture(pg, 'pg-sql136-exec-', 61365, { extra: [moneySchema({ member: MEMBER_A })] });
  const { admin, connectAs } = fx;
  try {
    const seen = [];
    const connect = async () => {
      const client = await connectAs('checksops_admin');
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const inspect = async () => {
      seen.length = 0;
      const result = await handlerFor(connect)(inspectEvent());
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      return result.details.receipt;
    };
    const apply = async (live) => {
      const pin = Object.freeze({ ...PINS[KEY], expected_live_definition_sha256: live, execute: true, authorization: 'Owner approved test fixture' });
      return handlerFor(connect, { pins: { [KEY]: pin } })(releaseEvent({ pin }));
    };
    const gates = async () => (await admin.query("SELECT count(*)::int AS n FROM pg_catalog.pg_policy WHERE polname LIKE 'aws_money_write_gate_%'")).rows[0].n;

    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, PRE, 'the live pre-state equals the derived one');
    assert.deepEqual(pre.release_sql_inspect.counts, { money_tables_forced_rls: 0, money_definer_writers_without_bypass: 0, money_invoker_trigger_writers: 0, money_invoker_function_writers: 0 });

    // Each fail-closed condition is seen read-only first and refuses the apply; nothing is created.
    await admin.query('ALTER TABLE public.payment_transfers FORCE ROW LEVEL SECURITY');
    const forced = await inspect();
    assert.deepEqual(forced.precondition_failures, ['money_tables_not_forced_rls']);
    assert.equal(forced.release_sql_inspect.counts.money_tables_forced_rls, 1);
    assert.equal((await apply(PRE)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query('ALTER TABLE public.payment_transfers NO FORCE ROW LEVEL SECURITY');
    await admin.query(`CREATE ROLE sql136_exec_plain NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE FUNCTION public.sql136_exec_plain_writer() RETURNS void LANGUAGE sql SECURITY DEFINER AS $f$ DELETE FROM public.moov_invoices WHERE false $f$;
      ALTER FUNCTION public.sql136_exec_plain_writer() OWNER TO sql136_exec_plain;`);
    const unbypassed = await inspect();
    assert.deepEqual(unbypassed.precondition_failures, ['money_definer_writers_bypass_rls']);
    assert.equal((await apply(unbypassed.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query('DROP FUNCTION public.sql136_exec_plain_writer(); DROP ROLE sql136_exec_plain;');
    await admin.query(`CREATE FUNCTION public.tg_accrue_mortgage_ops_billing() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN INSERT INTO public.check_billing_events (tenant_id) VALUES (NEW.tenant_id); RETURN NEW; END $f$;
      CREATE TRIGGER tr_accrue_mortgage_ops_billing AFTER UPDATE ON public.payment_wallets FOR EACH ROW EXECUTE FUNCTION public.tg_accrue_mortgage_ops_billing();`);
    const invoker = await inspect();
    assert.deepEqual(invoker.precondition_failures, ['no_invoker_trigger_money_writers']);
    assert.equal((await apply(invoker.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    // The same trigger function as SECURITY DEFINER owned by the table owner is no stop.
    await admin.query('ALTER FUNCTION public.tg_accrue_mortgage_ops_billing() SECURITY DEFINER; ALTER FUNCTION public.tg_accrue_mortgage_ops_billing() OWNER TO checksops_admin');
    assert.deepEqual((await inspect()).precondition_failures, []);
    await admin.query('DROP TRIGGER tr_accrue_mortgage_ops_billing ON public.payment_wallets; DROP FUNCTION public.tg_accrue_mortgage_ops_billing();');
    assert.equal(await gates(), 0);
    assert.equal((await inspect()).live_definition_sha256, PRE);

    // A pending pin cannot apply; drift (one gate policy already present by hand) and wrong recorded states refuse.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: PRE });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    await admin.query('CREATE POLICY aws_money_write_gate_delete_payroll_runs ON public.payroll_runs AS RESTRICTIVE FOR DELETE TO authenticated USING (false)');
    assert.notEqual((await inspect()).live_definition_sha256, PRE);
    assert.equal((await apply(PRE)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query('DROP POLICY aws_money_write_gate_delete_payroll_runs ON public.payroll_runs');
    assert.equal((await apply(PINS[KEY].intended_replacement_sha256)).code, CODES.INVALID_MANIFEST);
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await gates(), 0);

    // One apply on the intended fingerprint.
    const applied = await apply(PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(await gates(), 72);
    // The live renderings are the spec's (pg_get_expr with search_path pg_catalog).
    const rendered = (await admin.query(`SET search_path = pg_catalog; SELECT DISTINCT pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS q,
      pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS w FROM pg_catalog.pg_policy pol WHERE pol.polname LIKE 'aws_money_write_gate_%' ORDER BY 1, 2`))[1].rows;
    await admin.query('RESET search_path');
    assert.deepEqual(rendered, [{ q: GATE, w: GATE }, { q: GATE, w: null }, { q: null, w: GATE }]);
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
