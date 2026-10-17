/**
 * SQL 98, SQL 99 and SQL 100 (aws/workflows/sql/98_tenant_fee_collection.sql,
 * 99_mortgage_desk_completion_messages.sql, 100_mortgage_desk_live_access.sql) in the staging
 * guarded executor, on the release engine shared with SQL 90-97
 * (scripts/deployment-guard/lib/release-sql-state.mjs). release-sql90-97-executor.test.mjs
 * covers what every release key shares (pins allowlisted, refusals before connecting, the
 * reviewed-file and forbidden-statement checks, the read-only fake-client inspect); this file
 * covers what is new:
 *
 *   - the pins: pending, code-derived, selectable and packed; the reconciled SQL 98 / SQL 99
 *     pins keep their recorded bytes; predecessors 98 -> 96, 99 -> 90, 100 -> 90; SQL 98
 *     supersedes SQL 96 and SQL 96 refuses after SQL 98;
 *   - SQL 100's fingerprint carries ACL grantors and policy comment hashes (render), and
 *     nothing else's does;
 *   - on PostgreSQL 16 (SQL 29 / 30 / 90-97 applied first, a non-superuser checksops_admin
 *     owning everything): predecessors refuse; SQL 98's duplicate-period, duplicate-event and
 *     inactive-config refusals, its take-over of a pre-existing platform_billing_destination
 *     (other policies dropped, PUBLIC / authenticated / checksops privileges reset) and the same
 *     fingerprint whether or not a unique index already covers check_billing_events; SQL 99's
 *     check_messages write rule; SQL 100's other-grantor refusal; each applies once through the
 *     executor on the intended fingerprint.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL98_TENANT_FEE_COLLECTION,
  FEE_COLLECTION_PENDING_SQL_PINS,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_SPECS,
  readReleaseSqlState,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseSqlReport,
  releaseStateHash,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { MEMBER_A, TENANT_A, TENANT_B, pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-17T12:00:00.000Z';
const KEYS = Object.freeze(['sql98', 'sql99', 'sql100']);
const BEFORE = Object.freeze(['sql90', 'sql91', 'sql92', 'sql93', 'sql94', 'sql96', 'sql97', 'sql95']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const ALL = Object.keys(PINS);
const TEXT = Object.freeze(Object.fromEntries(ALL.map((key) => [key, fs.readFileSync(path.join(ROOT, PINS[key].filename), 'utf8')])));
const FILES = Object.freeze(Object.fromEntries(ALL.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = (key) => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[key].production_pin_rel), 'utf8'));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(key, overrides = {}) {
  const pin = overrides.pin || PINS[key];
  const oneUse = `${key}-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[key].choice}`,
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
    expiry: '2026-10-17T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key) => releaseEvent(key, { action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql98100-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pins: SQL 98-100 pending and code-derived, selectable, packed, in step with the production pins; the predecessors and the SQL 96 / SQL 98 rule', () => {
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  const choices = { sql98: 'sql98-tenant-fee-collection', sql99: 'sql99-mortgage-desk-completion-messages', sql100: 'sql100-mortgage-desk-live-access' };
  for (const key of KEYS) {
    const pin = PINS[key];
    const spec = RELEASE_SQL_SPECS[key];
    assert.equal(spec.choice, choices[key]);
    assert.equal(sha(TEXT[key]), pin.source_sha256, key);
    assert.equal(pin.execute, false, key);
    assert.equal(pin.authorization, 'pending', key);
    assert.equal(pin.expected_live_definition_sha256, null, key);
    assert.equal(releaseIntendedHash(key, TEXT[key]), pin.intended_replacement_sha256, key);
    assert.equal(MIGRATIONS[spec.choice], pin, key);
    assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`, key);
    assert.match(workflow, new RegExp(`- ${spec.choice}\\n`), key);
    assert.deepEqual(spec.functions.map((fn) => fn.identity), [...pin.function_identities], key);
    const prod = productionPin(key);
    assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256, key);
    assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256, key);
    assert.equal(prod.staging_pin_commit, pin.commit, key);
    assert.equal(prod.source_sha256, pin.source_sha256, key);
    assert.equal(prod.execute, false, key);
    assert.equal(prod.authorization, 'pending', key);
  }
  assert.match(workflow, /node --test aws\/tests\/release-sql98-100-executor\.test\.mjs/);
  // The fee collection map keeps naming the same SQL 98 pin.
  assert.equal(FEE_COLLECTION_PENDING_SQL_PINS.sql98, PINS.sql98);
  assert.equal(AUTHORIZED_SQL98_TENANT_FEE_COLLECTION, PINS.sql98);
  // Order: 98 after 96 (and SQL 98 supersedes SQL 96's guard), 99 and 100 after 90.
  assert.deepEqual(RELEASE_SQL_SPECS.sql98.predecessors, ['sql96']);
  assert.deepEqual(RELEASE_SQL_SPECS.sql98.supersedes, ['sql96']);
  assert.deepEqual(RELEASE_SQL_SPECS.sql96.refuse_after, [{ key: 'sql98', object: 'public.aws_platform_owner_set_tenant_deposits_enabled(uuid, boolean)' }]);
  assert.deepEqual(RELEASE_SQL_SPECS.sql99.predecessors, ['sql90']);
  assert.deepEqual(RELEASE_SQL_SPECS.sql100.predecessors, ['sql90']);
  assert.match(TEXT.sql98, /to_regprocedure\('public\.aws_platform_owner_set_tenant_pricing\(uuid, jsonb\)'\) IS NULL/);
  // SQL 100 alone is production_noop with grantors and policy comments in its fingerprint.
  assert.deepEqual(Object.keys(RELEASE_SQL_SPECS).filter((key) => RELEASE_SQL_SPECS[key].production_noop === true), ['sql100']);
  assert.deepEqual(RELEASE_SQL_SPECS.sql100.render, { grantors: true, policy_comments: true });
  assert.deepEqual(Object.keys(RELEASE_SQL_SPECS).filter((key) => RELEASE_SQL_SPECS[key].render), ['sql100']);
});

test('reviewed files: SQL 98-100 parse as reviewed; SQL 100 bodies are production\'s; the unrelated scope skips the new indexes', () => {
  for (const key of KEYS) assert.equal(releaseSqlExecutableText(key, TEXT[key]), TEXT[key], key);
  // The prosrc sha256 the 2026-10-17 production inspect recorded (EXECUTE'd body included).
  const defs = releaseFunctionDefinitions(TEXT.sql100);
  assert.equal(sha(defs.aws_is_mortgage_ops_agent.prosrc), '787bad580adace93c661f60d4486e6623fbd4c6004c8e42b38e3bb9c0ff957ba');
  assert.equal(sha(defs.aws_mortgage_agent_queue_visible.prosrc), 'b9f70c8b1421f264b4537d4eac9e7ad18f81281648a33197b55aa826ff6b6711');
  assert.equal(sha(defs.aws_is_active_mortgage_agent.prosrc), '2bba15b20b7e43c60fadf7032e834ec1937183af865d14ab1985a5bdd4f12117');
  for (const fn of Object.values(defs)) assert.deepEqual(fn.config, ['row_security=off', 'search_path=public']);
  assert.deepEqual(releaseUnrelatedScope('sql98').skip_indexes, ['public.tenant_maintenance_payments_tenant_period_uidx', 'public.check_billing_events_check_event_uidx']);
  assert.deepEqual(releaseUnrelatedScope('sql90').skip_indexes, []);
  // SQL 98's guard is SQL 96's plus deposits_enabled for the platform owner: a different body.
  assert.notEqual(sha(releaseFunctionDefinitions(TEXT.sql98).aws_tenants_member_column_guard.prosrc),
    sha(releaseFunctionDefinitions(TEXT.sql96).aws_tenants_member_column_guard.prosrc));
});

const PINS_TABLE_ACL = ['checksops DELETE grantor=owner', 'checksops INSERT grantor=owner', 'checksops SELECT grantor=owner'];

test('SQL 100 fingerprint: a grantor or a policy comment is another state; specs without render are unchanged by either', () => {
  const intended = releaseIntendedState('sql100', TEXT.sql100);
  const base = releaseStateHash('sql100', intended);
  assert.equal(base, PINS.sql100.intended_replacement_sha256);
  const commented = structuredClone(intended);
  commented.policies['public.mortgage_handling_requests aws_select_mortgage_handling_requests'].comment_sha256 = 'c'.repeat(64);
  assert.notEqual(releaseStateHash('sql100', commented), base);
  const otherGrantor = structuredClone(intended);
  otherGrantor.columns['public.mortgage_handling_requests.status'].acl = ['checksops UPDATE grantor=checksops'];
  assert.notEqual(releaseStateHash('sql100', otherGrantor), base);
  const fnGrant = structuredClone(intended);
  fnGrant.functions['public.aws_is_mortgage_ops_agent()'].acl.push('PUBLIC EXECUTE grantor=owner');
  assert.notEqual(releaseStateHash('sql100', fnGrant), base);
  // The whole table: RLS off or forced, another policy, a grant to any other role or on an unlisted column.
  const W = 'public.mortgage_handling_requests';
  assert.deepEqual(intended.whole[W], { exists: true, rls: true, forced: false, other_policies: [], acl: [...PINS_TABLE_ACL], other_column_acl: [] });
  for (const change of [
    (w) => { w.rls = false; },
    (w) => { w.forced = true; },
    (w) => { w.other_policies.push('policy public.mortgage_handling_requests zz_open: cmd=SELECT'); },
    (w) => { w.acl.push('PUBLIC SELECT grantor=owner'); },
    (w) => { w.other_column_acl.push('tenant_id authenticated UPDATE grantor=owner'); },
  ]) {
    const wider = structuredClone(intended);
    change(wider.whole[W]);
    assert.notEqual(releaseStateHash('sql100', wider), base);
  }
  // SQL 98 drops and recreates policies too, but its fingerprint (like SQL 90-97's) has no comment term.
  const s98 = releaseIntendedState('sql98', TEXT.sql98);
  const s98c = structuredClone(s98);
  s98c.policies['public.platform_billing_audit aws_select_platform_billing_audit'].comment_sha256 = 'c'.repeat(64);
  assert.equal(releaseStateHash('sql98', s98c), releaseStateHash('sql98', s98));
  // A covering unique index is part of SQL 98's state; whether SQL 98 or an earlier index made it is not.
  const uncovered = structuredClone(s98);
  uncovered.covers['public.check_billing_events check_event'].covered = false;
  assert.notEqual(releaseStateHash('sql98', uncovered), releaseStateHash('sql98', s98));
});

async function withPg(t, prefix, port, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra: sql98To100Schema() });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 98, SQL 99 and SQL 100 through the executor: predecessors, refusals, take-over, one apply each on the intended fingerprint', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql98100-exec-', 59100, async ({ admin, connectAs, applyPredecessors }) => {
  const seen = [];
  const connect = async () => {
    const client = await connectAs('checksops_admin');
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const inspect = async (key) => {
    seen.length = 0;
    const result = await handlerFor(connect)(inspectEvent(key));
    assert.equal(result.ok, true, `${key}: ${JSON.stringify(result)}`);
    assert.equal(seen[0], 'BEGIN READ ONLY', key);
    assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), `${key}: ${JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text)))}`);
    assert.doesNotMatch(JSON.stringify(result), /example\.invalid|checksopsadmin@|Private/, key);
    return result.details.receipt;
  };
  // An execute-authorized, owner-approved copy of the staging pin (test only).
  const apply = async (key, live) => {
    const pin = Object.freeze({ ...PINS[key], expected_live_definition_sha256: live, execute: true, authorization: 'Owner approved test fixture' });
    return handlerFor(connect, { pins: { [key]: pin } })(releaseEvent(key, { pin }));
  };
  const asOwner = async (fn) => {
    const c = await connectAs('checksops_admin');
    try { return await fn(c); } finally { await c.end(); }
  };
  /** The state and shared precondition failures of `key` with `setup` applied, rolled back after. */
  const whatIf = async (key, setup) => {
    await admin.query('BEGIN');
    try {
      for (const sql of [].concat(setup)) await admin.query(sql);
      const state = (await readReleaseSqlState(admin, key)).details;
      return { state, failures: releaseSharedPreconditionFailures(key, state, TEXT[key]) };
    } finally {
      await admin.query('ROLLBACK');
    }
  };

  // Before SQL 90 / SQL 96: refused on predecessors.
  for (const [key, missing] of [['sql98', 'sql96'], ['sql99', 'sql90'], ['sql100', 'sql90']]) {
    const r = await inspect(key);
    assert.equal(r.release_sql_inspect.predecessors[missing], false, key);
    assert.ok(r.precondition_failures.includes('predecessors_applied'), key);
    assert.equal(r.apply_preconditions_met, false, key);
    const refused = await apply(key, r.live_definition_sha256);
    assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, key);
    assert.ok(refused.details.failed.includes('predecessors_applied'), key);
  }
  await applyPredecessors();
  await asOwner(async (c) => { for (const key of BEFORE) await c.query(TEXT[key]); });

  // --- SQL 98 -------------------------------------------------------------------------
  // Refusals before it runs: duplicate tenant periods, duplicated check events with no covering
  // unique index, check_billing_config rows none of which is active.
  await admin.query(`INSERT INTO public.tenant_maintenance_payments (tenant_id, billing_period) VALUES ($1, '2026-10'), ($1, '2026-10')`, [TENANT_A]);
  let r98 = await inspect('sql98');
  assert.equal(r98.release_sql_inspect.counts.duplicate_billing_periods, 1);
  assert.ok(r98.precondition_failures.includes('no_duplicate_billing_periods'));
  assert.equal((await apply('sql98', r98.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query('DELETE FROM public.tenant_maintenance_payments');
  const dupEvents = `INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, unit_price_cents) VALUES
    ('${TENANT_A}', '55555555-5555-4555-8555-555555555555', 300), ('${TENANT_A}', '55555555-5555-4555-8555-555555555555', 300)`;
  const dup = await whatIf('sql98', dupEvents);
  assert.equal(dup.state.counts.check_billing_event_duplicates, 1);
  assert.ok(dup.failures.includes('unique_covered_or_no_duplicates'));
  const inactive = await whatIf('sql98', 'INSERT INTO public.check_billing_config (price_per_check_cents, active) VALUES (250, false)');
  assert.ok(inactive.failures.includes('check_billing_config_active_or_empty'));
  // A pre-existing platform_billing_destination with an unknown grantee is not taken over.
  const DEST = `CREATE TABLE public.platform_billing_destination (
      environment text PRIMARY KEY CHECK (environment IN ('sandbox', 'production')),
      moov_account_id text NOT NULL, moov_payment_method_id text NOT NULL, label text NOT NULL DEFAULT 'ChecksOps merchant',
      verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE public.platform_billing_destination OWNER TO checksops_admin`;
  const foreign = await whatIf('sql98', [DEST, 'CREATE ROLE zz_billing_reader NOLOGIN', 'GRANT SELECT ON public.platform_billing_destination TO zz_billing_reader']);
  assert.ok(foreign.failures.includes('created_tables_absent_or_intended'));
  // whatIf reads as the test superuser, so owner_is_login is false there; the inspect (as checksops_admin) checks it below.
  const takeoverOf = (state) => {
    const { owner_is_login: _o, ...rest } = releaseSqlReport('sql98', state, TEXT.sql98).tables.find((x) => x.name === 'platform_billing_destination').takeover;
    return rest;
  };
  assert.deepEqual(takeoverOf(foreign.state), { shape_differs: [], unexpected_triggers: [], unexpected_acl_grantees: ['zz_billing_reader'], unexpected_column_acl_grantees: [] });
  const otherShape = await whatIf('sql98', [DEST, 'ALTER TABLE public.platform_billing_destination ADD COLUMN notes text']);
  assert.ok(otherShape.failures.includes('created_tables_absent_or_intended'));
  assert.deepEqual(takeoverOf(otherShape.state).shape_differs, ['column notes']);
  const extraTrigger = await whatIf('sql98', [DEST, `CREATE FUNCTION public.zz_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
    'CREATE TRIGGER zz_touch BEFORE UPDATE ON public.platform_billing_destination FOR EACH ROW EXECUTE FUNCTION public.zz_touch()']);
  assert.ok(extraTrigger.failures.includes('created_tables_absent_or_intended'));
  assert.deepEqual(takeoverOf(extraTrigger.state).unexpected_triggers, ['zz_touch']);
  // A pre-existing one of the reviewed shape, with an extra permissive policy and wider grants, is taken over,
  // but only while it holds no row (a row would become the fee destination unreviewed and unaudited).
  await admin.query(DEST);
  await admin.query(`ALTER TABLE public.platform_billing_destination ENABLE ROW LEVEL SECURITY;
    CREATE POLICY legacy_read_platform_billing_destination ON public.platform_billing_destination FOR SELECT TO authenticated USING (true);
    GRANT SELECT ON public.platform_billing_destination TO PUBLIC;
    GRANT INSERT, UPDATE, DELETE ON public.platform_billing_destination TO authenticated;
    INSERT INTO public.platform_billing_destination (environment, moov_account_id, moov_payment_method_id) VALUES ('sandbox', 'acct_unreviewed', 'pm_unreviewed')`);
  r98 = await inspect('sql98');
  assert.equal(r98.release_sql_inspect.counts.platform_billing_destination_rows, 1);
  // Counts only (never the ids): which environment, whether on the reviewed platform account, verified.
  const destCounts = (counts) => Object.fromEntries(Object.entries(counts).filter(([k]) => k.startsWith('platform_billing_destination_')));
  assert.deepEqual(destCounts(r98.release_sql_inspect.counts), {
    platform_billing_destination_rows: 1, platform_billing_destination_production_rows: 0, platform_billing_destination_sandbox_rows: 1,
    platform_billing_destination_reviewed_account_rows: 0, platform_billing_destination_production_reviewed_account_rows: 0,
    platform_billing_destination_payment_method_rows: 1, platform_billing_destination_verified_rows: 0,
  });
  assert.doesNotMatch(JSON.stringify(r98), /acct_unreviewed|pm_unreviewed/);
  const reviewed = await whatIf('sql98', `INSERT INTO public.platform_billing_destination (environment, moov_account_id, moov_payment_method_id, verified_at)
    VALUES ('production', '41cb5d67-4911-4bef-aad5-d8ee9c582208', 'pm_reviewed', now())`);
  assert.deepEqual(destCounts(reviewed.state.counts), {
    platform_billing_destination_rows: 2, platform_billing_destination_production_rows: 1, platform_billing_destination_sandbox_rows: 1,
    platform_billing_destination_reviewed_account_rows: 1, platform_billing_destination_production_reviewed_account_rows: 1,
    platform_billing_destination_payment_method_rows: 2, platform_billing_destination_verified_rows: 1,
  });
  assert.ok(reviewed.failures.includes('platform_billing_destination_absent_or_empty'));
  assert.deepEqual(r98.precondition_failures, ['platform_billing_destination_absent_or_empty'], JSON.stringify(r98.release_sql_inspect));
  const withRow = await apply('sql98', r98.live_definition_sha256);
  assert.equal(withRow.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(withRow.details.failed.includes('platform_billing_destination_absent_or_empty'));
  await admin.query('DELETE FROM public.platform_billing_destination');
  r98 = await inspect('sql98');
  assert.deepEqual(r98.precondition_failures, [], JSON.stringify(r98.release_sql_inspect));
  assert.deepEqual(r98.release_sql_inspect.unique_covers, [{ name: 'check_billing_events check_event', columns: ['check_intake_item_id', 'event_type'], covered: false }]);
  assert.deepEqual(r98.release_sql_inspect.counts, { duplicate_billing_periods: 0, check_billing_event_duplicates: 0, check_billing_config_rows: 0, check_billing_config_active_rows: 0, platform_billing_destination_rows: 0, platform_billing_destination_production_rows: 0, platform_billing_destination_sandbox_rows: 0, platform_billing_destination_reviewed_account_rows: 0, platform_billing_destination_production_reviewed_account_rows: 0, platform_billing_destination_payment_method_rows: 0, platform_billing_destination_verified_rows: 0 });
  assert.equal(r98.release_sql_inspect.tables.find((x) => x.name === 'platform_billing_destination').state, 'different');
  assert.deepEqual(r98.release_sql_inspect.tables.find((x) => x.name === 'platform_billing_destination').takeover,
    { owner_is_login: true, shape_differs: [], unexpected_triggers: [], unexpected_acl_grantees: [], unexpected_column_acl_grantees: [] });
  // The same fingerprint when an earlier unique index already covers the pair (SQL 98 then adds none).
  await admin.query('BEGIN');
  try {
    await admin.query('CREATE UNIQUE INDEX zz_events_unique ON public.check_billing_events (check_intake_item_id, event_type, tenant_id)');
    await admin.query('SET LOCAL ROLE checksops_admin');
    await admin.query(TEXT.sql98);
    await admin.query('RESET ROLE');
    const covered = (await readReleaseSqlState(admin, 'sql98')).details;
    assert.equal(covered.live_definition_sha256, PINS.sql98.intended_replacement_sha256);
    assert.equal((await admin.query("SELECT to_regclass('public.check_billing_events_check_event_uidx') IS NULL AS absent")).rows[0].absent, true);
  } finally {
    await admin.query('ROLLBACK');
  }
  const applied98 = await apply('sql98', r98.live_definition_sha256);
  assert.equal(applied98.ok, true, JSON.stringify(applied98));
  assert.equal(applied98.details.receipt.after_hash, PINS.sql98.intended_replacement_sha256);
  const after98 = await inspect('sql98');
  assert.equal(after98.already_applied, true);
  assert.equal((await apply('sql98', r98.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  // The take-over: only SQL 98's two policies; PUBLIC and authenticated reset; checksops SELECT, INSERT, UPDATE.
  const dest = (await admin.query(`SELECT (SELECT array_agg(polname::text ORDER BY polname) FROM pg_policy WHERE polrelid = 'public.platform_billing_destination'::regclass) AS policies,
      has_table_privilege('authenticated', 'public.platform_billing_destination', 'INSERT') AS auth_insert,
      (SELECT count(*)::int FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = 'public.platform_billing_destination'::regclass)) a WHERE a.grantee = 0) AS public_entries`)).rows[0];
  assert.deepEqual(dest.policies, ['aws_select_platform_billing_destination', 'aws_write_platform_billing_destination']);
  assert.equal(dest.auth_insert, false);
  assert.equal(dest.public_entries, 0);
  // The seed row (no config row existed) and the deposits switch.
  assert.deepEqual((await admin.query('SELECT price_per_check_cents, active FROM public.check_billing_config')).rows, [{ price_per_check_cents: 300, active: true }]);
  assert.equal((await admin.query('SELECT public.aws_tenant_deposits_enabled($1::uuid) AS on', [TENANT_B])).rows[0].on, true);
  // SQL 96 now refuses (re-running it would put back its guard); SQL 93 still refuses after SQL 96.
  const r96 = await inspect('sql96');
  assert.deepEqual(r96.release_sql_inspect.successors_applied, ['sql98']);
  assert.ok(r96.precondition_failures.includes('successors_not_applied'));
  assert.ok((await inspect('sql93')).precondition_failures.includes('successors_not_applied'));
  // A member may not change deposits_enabled (SQL 98's guard).
  const member = await connectAs('checksops');
  try {
    await member.query('BEGIN');
    await member.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_A]);
    await assert.rejects(member.query('UPDATE public.tenants SET deposits_enabled = false WHERE id = $1', [TENANT_A]), (error) => error.code === '42501');
  } finally {
    await member.query('ROLLBACK').catch(() => {});
    await member.end();
  }

  // --- SQL 99 -------------------------------------------------------------------------
  await admin.query('ALTER TABLE public.check_messages FORCE ROW LEVEL SECURITY');
  let r99 = await inspect('sql99');
  assert.ok(r99.precondition_failures.includes('definer_can_write_relations'));
  assert.deepEqual(r99.release_sql_inspect.definer_writes, [{ name: 'check_messages', ok: false }]);
  assert.equal((await apply('sql99', r99.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query('ALTER TABLE public.check_messages NO FORCE ROW LEVEL SECURITY');
  r99 = await inspect('sql99');
  assert.deepEqual(r99.precondition_failures, [], JSON.stringify(r99.release_sql_inspect));
  assert.deepEqual(r99.release_sql_inspect.predecessors, { sql90: true });
  const applied99 = await apply('sql99', r99.live_definition_sha256);
  assert.equal(applied99.ok, true, JSON.stringify(applied99));
  assert.equal(applied99.details.receipt.after_hash, PINS.sql99.intended_replacement_sha256);
  assert.equal((await inspect('sql99')).already_applied, true);
  assert.equal((await apply('sql99', r99.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);

  // --- SQL 100 ------------------------------------------------------------------------
  // The repository's state (12, 24, SQL 50): not production's, so staging applies it.
  let r100 = await inspect('sql100');
  assert.deepEqual(r100.precondition_failures, [], JSON.stringify(r100.release_sql_inspect));
  assert.equal(r100.already_applied, false);
  assert.ok(r100.release_sql_inspect.policies.some((p) => p.name === 'mortgage_handling_requests aws_write_mortgage_handling_requests' && p.state === 'present'));
  // A column grant by another grantor cannot be revoked by the owner's REVOKE: refused.
  const grantor = await whatIf('sql100', [
    'GRANT UPDATE (status) ON public.mortgage_handling_requests TO checksops WITH GRANT OPTION',
    'SET LOCAL ROLE checksops',
    'GRANT UPDATE (note) ON public.mortgage_handling_requests TO authenticated',
    'RESET ROLE',
  ]);
  assert.ok(grantor.failures.includes('column_acl_replaceable'), JSON.stringify(grantor.failures));
  // A policy comment is part of the fingerprint.
  const commented = await whatIf('sql100', "COMMENT ON POLICY aws_select_mortgage_handling_requests ON public.mortgage_handling_requests IS 'note'");
  assert.notEqual(commented.state.live_definition_sha256, r100.live_definition_sha256);
  const pre100 = r100.live_definition_sha256;
  const applied100 = await apply('sql100', pre100);
  assert.equal(applied100.ok, true, JSON.stringify(applied100));
  assert.equal(applied100.details.receipt.after_hash, PINS.sql100.intended_replacement_sha256);
  r100 = await inspect('sql100');
  assert.equal(r100.already_applied, true);
  assert.ok(r100.release_sql_inspect.functions.every((row) => row.state === 'intended'), JSON.stringify(r100.release_sql_inspect.functions));
  assert.deepEqual(r100.release_sql_inspect.policy_comments.map((p) => p.present), [false, false, true, false, false]);
  assert.equal((await apply('sql100', pre100)).code, CODES.UNRELATED_MUTATION);
  // Likewise a helper EXECUTE grant by another grantor (the owner's REVOKE leaves it): refused (helpers exist now).
  const fnGrantor = await whatIf('sql100', [
    'GRANT EXECUTE ON FUNCTION public.aws_is_mortgage_ops_agent() TO checksops WITH GRANT OPTION',
    'SET LOCAL ROLE checksops',
    'GRANT EXECUTE ON FUNCTION public.aws_is_mortgage_ops_agent() TO PUBLIC',
    'RESET ROLE',
  ]);
  assert.ok(fnGrantor.failures.includes('function_acl_replaceable'), JSON.stringify(fnGrantor.failures));
  // Access the file does not describe is another state, not "already applied" (no precondition names it).
  for (const wider of [
    'CREATE POLICY zz_open_read ON public.mortgage_handling_requests FOR SELECT TO authenticated USING (true)',
    'ALTER TABLE public.mortgage_handling_requests DISABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.mortgage_handling_requests FORCE ROW LEVEL SECURITY',
    'GRANT SELECT ON public.mortgage_handling_requests TO PUBLIC',
    'GRANT SELECT ON public.mortgage_handling_requests TO authenticated',
    'GRANT UPDATE (tenant_id) ON public.mortgage_handling_requests TO authenticated',
  ]) {
    const probe = await whatIf('sql100', wider);
    assert.notEqual(probe.state.live_definition_sha256, PINS.sql100.intended_replacement_sha256, wider);
  }
  // Re-running the file on the state it produced changes nothing (as on production).
  await asOwner((c) => c.query(TEXT.sql100));
  assert.equal((await inspect('sql100')).live_definition_sha256, PINS.sql100.intended_replacement_sha256);
  for (const key of KEYS) assert.equal((await inspect(key)).already_applied, true, key);
}));
