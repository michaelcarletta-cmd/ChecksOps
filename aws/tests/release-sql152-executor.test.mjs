/**
 * SQL 152 (aws/workflows/sql/152_invoice_and_failed_deposit_fees.sql) in the staging guarded executor, on the release
 * engine shared with SQL 90-150 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 152 included); this file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor; SQL 149 (never applied) has no spec or pin;
 *   - the file and spec: SQL 149 plus SQL 118's revoke of every non-owner grant on the new table; the one-row table
 *     with no grant to anyone, five owner-only functions, two triggers, the partial unique index, four columns;
 *   - on PostgreSQL 16, with default privileges that give every new table to checksops and authenticated (as staging
 *     and production have, SQL 117's failure): refused while SQL 120 is missing; the pre-state read back as everything
 *     absent; a pending pin cannot apply; one apply through the executor reaches the intended fingerprint (the new
 *     table keeps no grant), then is refused as already in place. SQL 149 under the same default privileges does not
 *     reach the fingerprint (why it is never applied).
 * The behavior (invoice and failed deposit events) is aws/tests/sql152-usage-fees-pg.test.mjs.
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
  AUTHORIZED_SQL152_INVOICE_AND_FAILED_DEPOSIT_FEES,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSqlExecutableText,
  releaseStateHash,
  releaseStateText,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';
import { PAYMENT_SCHEMA } from './helpers/sql109-payment-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-11T12:00:00.000Z';
const KEY = 'sql152';
const FNS = [
  'public.aws_usage_fee_launched_at()',
  'public.aws_invoice_fee_cents()',
  'public.aws_failed_deposit_fee_cents()',
  'public.aws_record_invoice_fee()',
  'public.aws_record_failed_deposit_fee()',
];
const TABLE = 'public.tenant_usage_fee_launch';
const COLUMNS = ['invoice_fee_count', 'invoice_fee_amount_cents', 'failed_deposit_count', 'failed_deposit_amount_cents'];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL149 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/149_invoice_and_failed_deposit_fees.sql'), 'utf8');
const SQL120 = fs.readFileSync(path.join(ROOT, PINS.sql120.filename), 'utf8');
// The expected pre-state in both environments: none of SQL 152's objects present.
const PRE = releaseStateHash(KEY, {});
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

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
    expiry: '2026-11-11T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql152-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// The shapes SQL 120 and SQL 152 read and write that the release fixture lacks (production's), and the default
// privileges staging and production give every new table (SQL 117's failure: the table keeps them unless revoked).
const SQL152_SCHEMA = `
ALTER TABLE public.tenants ADD COLUMN next_day_rate_cents integer, ADD COLUMN same_day_rate_cents integer;
ALTER TABLE public.check_billing_events ADD COLUMN payment_transfer_id uuid, ADD COLUMN billed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN invoice_id uuid, ADD COLUMN claim_id uuid, ADD COLUMN source_kind text, ADD COLUMN source_id uuid,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT check_billing_events_check_event_unique UNIQUE (check_intake_item_id, event_type);
ALTER TABLE public.check_billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transfers ADD COLUMN speed text NOT NULL DEFAULT 'standard', ADD COLUMN requested_speed text;
CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, tenant_id uuid,
  status text NOT NULL DEFAULT 'pending', submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.checkalt_deposits ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.moov_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft',
  sent_at timestamptz, claim_id uuid, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.moov_invoices ENABLE ROW LEVEL SECURITY;
INSERT INTO public.check_billing_config (price_per_check_cents) VALUES (300);
CREATE FUNCTION public.aws_check_billing_default_price_cents() RETURNS integer LANGUAGE sql STABLE
  SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT c.price_per_check_cents FROM public.check_billing_config c WHERE c.active = true ORDER BY c.created_at DESC LIMIT 1 $$;
CREATE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path = public AS $$ SELECT true $$;
ALTER DEFAULT PRIVILEGES FOR ROLE checksops_admin IN SCHEMA public GRANT ALL ON TABLES TO checksops, authenticated;`;

test('pin: SQL 152 pending, code-derived, selectable, packed, in step with the pending production pin; no predecessor; the derived pre-state', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL152_INVOICE_AND_FAILED_DEPOSIT_FEES, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/152_invoice_and_failed_deposit_fees.sql');
  assert.equal(pin.migration_id, '152_invoice_and_failed_deposit_fees');
  assert.equal(spec.choice, 'sql152-invoice-and-failed-deposit-fees');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(PRE, pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  // The runbook and the production pin name the pre-state (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-152-apply.md'), 'utf8');
  for (const value of [PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.match(runbook, /\*\*Status:\*\* not applied anywhere/);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql152-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  // SQL 149 is never applied: no spec, no pin, not packed, not a workflow choice.
  assert.equal(RELEASE_SQL_SPECS.sql149, undefined);
  assert.equal(PINS.sql149, undefined);
  assert.equal(packed['aws/workflows/sql/149_invoice_and_failed_deposit_fees.sql'], undefined);
  assert.doesNotMatch(workflow, /- sql149-/);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces, drops or re-grants SQL 152's functions, table, columns or triggers.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    for (const fn of FNS) assert.ok(!touched.includes(fn), `${key} ${fn}`);
    assert.ok(!(other.tables || []).some((t) => t.name === TABLE), key);
    assert.ok(!(other.added_columns || []).some((c) => COLUMNS.includes(c.column) && c.table === 'public.tenant_maintenance_payments'), key);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, FNS);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.authorization_phrase, 'APPLY_INVOICE_AND_FAILED_DEPOSIT_FEES');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.equal(prod.staging_acceptance.ok, false);
  assert.ok(prod.production_inspect.note.includes(PRE));
  assert.ok(prod.order_note.includes(PRE));
  assert.ok(prod.intended_post_state.note.includes(pin.intended_replacement_sha256));
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

test('reviewed file and spec: SQL 149 plus the revoke of every non-owner grant; the table with no grant, five owner-only functions, two triggers, the partial unique index, four columns', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  // SQL 152's statements are SQL 149's, but the revoke block and its own labels.
  const code = (text) => text.split('\n').filter((line) => !line.startsWith('--')).join('\n');
  const normalize = (text) => code(text).replace(/sql1(49|52)_/g, 'sqlN_').replace(/'SQL 1(49|52): /g, "'SQL N: ");
  const revoke = /DO \$sql152_table_acl\$[\s\S]*?\$sql152_table_acl\$;\n/;
  assert.match(TEXT, revoke);
  assert.equal(normalize(TEXT.replace(revoke, '')), normalize(SQL149.replace('REVOKE ALL ON TABLE public.tenant_usage_fee_launch FROM PUBLIC;\n', '')));
  // The revoke block is SQL 118's, for this table.
  const sql118 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/118_platform_owner_tenant_lifecycle.sql'), 'utf8');
  const block118 = sql118.match(/DO \$sql118_table_acl\$[\s\S]*?\$sql118_table_acl\$;\n/)[0];
  assert.equal(TEXT.match(revoke)[0], block118.replace(/sql118/g, 'sql152').replace(/tenant_deactivations/g, 'tenant_usage_fee_launch'));
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs).sort(), FNS.map((fn) => fn.replace(/^public\.|\(.*$/g, '')).sort());
  for (const name of ['aws_record_invoice_fee', 'aws_record_failed_deposit_fee']) {
    assert.equal(defs[name].security_definer, true, name);
    assert.equal(defs[name].result, 'trigger', name);
    // They write only check_billing_events.
    assert.deepEqual([...new Set([...defs[name].prosrc.matchAll(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => m[1]))],
      ['public.check_billing_events'], name);
  }
  assert.match(defs.aws_invoice_fee_cents.prosrc, /SELECT 30\b/);
  assert.match(defs.aws_failed_deposit_fee_cents.prosrc, /SELECT 200\b/);
  const spec = RELEASE_SQL_SPECS[KEY];
  // The launch time function's result is stated as the catalog reads it (the file says RETURNS timestamptz).
  assert.deepEqual(spec.functions, FNS.map((identity) => ({
    identity, acl: ['owner EXECUTE'], ...(identity === 'public.aws_usage_fee_launched_at()' ? { result: 'timestamp with time zone' } : {}),
  })));
  assert.match(TEXT, /aws_usage_fee_launched_at\(\)\nRETURNS timestamptz\n/);
  assert.deepEqual(spec.tables.map((t) => [t.name, t.rls, t.forced, t.acl]), [[TABLE, true, false, []]]);
  assert.deepEqual(spec.added_columns.map((c) => [c.table, c.column, c.type, c.notnull, c.default, c.acl]),
    COLUMNS.map((column) => ['public.tenant_maintenance_payments', column, 'integer', true, '0', []]));
  assert.deepEqual(spec.indexes.map((i) => [i.table, i.name]), [['public.check_billing_events', 'check_billing_events_usage_source_uidx']]);
  assert.deepEqual(spec.triggers.map((t) => [t.table, t.name]), [
    ['public.moov_invoices', 'aws_moov_invoice_fee'], ['public.checkalt_deposits', 'aws_checkalt_deposit_failed_fee']]);
  assert.deepEqual(spec.definer_writes, ['public.check_billing_events']);
  assert.ok(spec.prerequisites.includes('public.aws_record_checkalt_billing_event()'));
  for (const kind of ['policies', 'table_privileges', 'column_acl', 'acl_functions', 'dropped_functions', 'views']) assert.equal(spec[kind], undefined, kind);
  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(text, /^release sql152 v1\n/);
  assert.match(text, /\ntable public\.tenant_usage_fee_launch acl: \n/);
});

test('PostgreSQL 16, default privileges on: SQL 152 through the executor: refused without SQL 120, everything absent read back, a pending pin cannot apply, one apply on the intended fingerprint (no grant on the new table), then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql152-exec-', 59520, { extra: [...sql98To100Schema(), PAYMENT_SCHEMA, SQL152_SCHEMA] });
  const { connectAs } = fx;
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

    // SQL 120 missing: its trigger function is a prerequisite.
    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.prerequisites_missing, ['public.aws_record_checkalt_billing_event()']);
    assert.ok(early.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    const owner = await connectAs('checksops_admin');
    try {
      await owner.query(SQL120);
    } finally {
      await owner.end();
    }

    // Everything absent: the derived pre-state.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, PRE);
    // A pending pin cannot apply.
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.equal((await fx.admin.query(`SELECT to_regclass('${TABLE}') AS t`)).rows[0].t, null);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    // The default-privilege grants on the new table are gone; one launch row; no usage event written.
    const acl = (await fx.admin.query(`SELECT count(*)::int AS n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid = '${TABLE}'::regclass AND a.grantee <> c.relowner`)).rows[0].n;
    assert.equal(acl, 0);
    assert.equal((await fx.admin.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n, 1);
    assert.equal((await fx.admin.query(`SELECT count(*)::int AS n FROM public.check_billing_events WHERE event_type IN ('invoice_sent', 'failed_deposit')`)).rows[0].n, 0);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});

test('PostgreSQL 16, default privileges on: SQL 149 leaves the default-privilege grants on its table, so it never reaches SQL 152\'s fingerprint', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql149-acl-', 59530, { extra: [...sql98To100Schema(), PAYMENT_SCHEMA, SQL152_SCHEMA] });
  try {
    const owner = await fx.connectAs('checksops_admin');
    try {
      await owner.query(SQL120);
      await owner.query(SQL149);
    } finally {
      await owner.end();
    }
    const grantees = (await fx.admin.query(`SELECT DISTINCT a.grantee::regrole::text AS g FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid = '${TABLE}'::regclass AND a.grantee <> c.relowner ORDER BY 1`)).rows.map((row) => row.g);
    assert.deepEqual(grantees, ['authenticated', 'checksops']);
    const connect = async () => fx.connectAs('checksops_admin');
    const result = await handlerFor(connect)(inspectEvent());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(result.details.receipt.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.equal(result.details.receipt.already_applied, false);
  } finally {
    await fx.close();
  }
});
