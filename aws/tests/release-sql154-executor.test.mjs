/**
 * SQL 154 (aws/workflows/sql/154_tenant_starter_package.sql) in the staging guarded executor, on the release engine
 * shared with SQL 90-152 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 154 included); this file covers what is new:
 *
 *   - the pin: staging-authorized (wave 46) from staging read-live run 43033279908, code-derived, selectable, packed, in step with the production pin (execute true on production's own pre-state, the same one staging had); the pinned commit
 *     authored the bytes; predecessor SQL 102, supersedes SQL 102 and SQL 98 (both define the tenants column guard
 *     SQL 154 replaces), with superseded_intended_sha256 derived from the files; SQL 151 (never applied) has no spec or
 *     pin;
 *   - the file and spec: SQL 151 plus the GRANT of EXECUTE on aws_starter_package_checks_used(uuid) to checksops; four
 *     functions with their ACLs and the guard with SQL 102's ACL, five columns, the CHECK, two triggers; the expected
 *     pre-state (SQL 102's guard, everything else absent) derived from SQL 102's bytes;
 *   - on PostgreSQL 16 (SQL 90-102 applied as the owner, then default privileges that give every new table to
 *     checksops and authenticated, as staging and production have, then SQL 120 and SQL 152): refused while SQL 120's
 *     and SQL 152's functions are missing; the pre-state read back as derived; a pending pin and drift cannot apply;
 *     one apply through the executor reaches the intended fingerprint (checksops can read the Checks used), then is
 *     refused as already in place; SQL 102, SQL 98, SQL 96 and SQL 93 still read applied through SQL 154 (supersedes),
 *     and only while their other objects match.
 * The behavior (included Checks, a failed deposit uses one, the setter) is aws/tests/sql154-starter-package-pg.test.mjs.
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
  AUTHORIZED_SQL154_TENANT_STARTER_PACKAGE,
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
  releaseSupersededIntendedHash,
  releaseUnrelatedScope,
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
const KEY = 'sql154';
const GUARD = 'public.aws_tenants_member_column_guard()';
const CHECKS_USED = 'public.aws_starter_package_checks_used(uuid)';
const ACLS = Object.freeze({
  [CHECKS_USED]: ['checksops EXECUTE', 'owner EXECUTE'],
  'public.aws_apply_starter_package_to_event()': ['owner EXECUTE'],
  'public.aws_platform_owner_set_tenant_starter_package(uuid, boolean, date, date, integer)': ['checksops EXECUTE', 'owner EXECUTE'],
  'public.aws_tenant_starter_package_audit_row()': ['owner EXECUTE'],
  [GUARD]: ['PUBLIC EXECUTE', 'owner EXECUTE'],
});
const FNS = Object.keys(ACLS);
const COLUMNS = Object.freeze([
  ['public.tenants', 'starter_package_enabled', 'boolean', true, 'false'],
  ['public.tenants', 'starter_package_starts_on', 'date', false, null],
  ['public.tenants', 'starter_package_maintenance_ends_on', 'date', false, null],
  ['public.tenants', 'starter_package_included_checks', 'integer', true, '250'],
  ['public.check_billing_events', 'package_included', 'boolean', true, 'false'],
]);
const GRANT = 'GRANT EXECUTE ON FUNCTION public.aws_starter_package_checks_used(uuid) TO checksops;\n';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL151 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql', '151_tenant_starter_package.sql'), 'utf8');
const SQL98 = fs.readFileSync(path.join(ROOT, PINS.sql98.filename), 'utf8');
const SQL102 = fs.readFileSync(path.join(ROOT, PINS.sql102.filename), 'utf8');
const SQL120 = fs.readFileSync(path.join(ROOT, PINS.sql120.filename), 'utf8');
const SQL152 = fs.readFileSync(path.join(ROOT, PINS.sql152.filename), 'utf8');
/** The pre-state both databases are expected to have: SQL 102's guard, everything else absent. */
const SQL102_GUARD = releaseIntendedState('sql102', SQL102).functions[GUARD];
const PRE = releaseStateHash(KEY, { functions: { [GUARD]: SQL102_GUARD } });
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const TEXTS = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, fs.readFileSync(FILES[key], 'utf8')])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(overrides = {}) {
  const key = overrides.key || KEY;
  const pin = overrides.pin || PINS[key];
  const rest = { ...overrides };
  delete rest.pin;
  delete rest.key;
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
    one_use_id: `${key}-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-11-11T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key = KEY) => releaseEvent({ key, action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql154-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// The shapes SQL 120 and SQL 152 read and write that the release fixture lacks (production's), as in
// release-sql152-executor.test.mjs.
const SQL152_SCHEMA = `
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS next_day_rate_cents integer, ADD COLUMN IF NOT EXISTS same_day_rate_cents integer;
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
ALTER TABLE public.moov_invoices ENABLE ROW LEVEL SECURITY;`;
// Staging and production give every new table grants through default privileges (SQL 117's failure).
const DEFAULT_PRIVILEGES = 'ALTER DEFAULT PRIVILEGES FOR ROLE checksops_admin IN SCHEMA public GRANT ALL ON TABLES TO checksops, authenticated;';

test('pin: SQL 154 staging-authorized from its read-live, code-derived, selectable, packed, in step with the execute-authorized production pin; predecessor SQL 102, supersedes SQL 102 and SQL 98; the derived pre-state', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL154_TENANT_STARTER_PACKAGE, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/154_tenant_starter_package.sql');
  assert.equal(pin.migration_id, '154_tenant_starter_package');
  assert.equal(spec.choice, 'sql154-tenant-starter-package');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-11-11, "Record the SQL 154 staging pin and merge it when green") from
  // staging read-live run 43033279908: already_applied false, precondition_failures []. It read the derived pre-state.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-11: staging apply (wave 46) from staging read-live run 43033279908');
  assert.equal(pin.expected_live_definition_sha256, PRE);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(PRE, pin.intended_replacement_sha256);
  // SQL 102 and SQL 98 after SQL 154: every object of their own, with the guard as SQL 154 renders it.
  assert.deepEqual(Object.keys(pin.superseded_intended_sha256), ['sql102', 'sql98']);
  assert.equal(releaseSupersededIntendedHash('sql102', SQL102, KEY, TEXT), pin.superseded_intended_sha256.sql102);
  assert.equal(releaseSupersededIntendedHash('sql98', SQL98, KEY, TEXT), pin.superseded_intended_sha256.sql98);
  assert.notEqual(pin.superseded_intended_sha256.sql102, releaseIntendedHash('sql102', SQL102));
  assert.notEqual(pin.superseded_intended_sha256.sql98, PINS.sql102.superseded_intended_sha256.sql98);
  // The runbook and the production pin name the pre-state (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-154-apply.md'), 'utf8');
  for (const value of [PRE, pin.intended_replacement_sha256, pin.source_sha256, ...Object.values(pin.superseded_intended_sha256),
    sha(releaseFunctionDefinitions(TEXT).aws_tenants_member_column_guard.prosrc), sha(releaseFunctionDefinitions(SQL102).aws_tenants_member_column_guard.prosrc)]) {
    assert.ok(runbook.includes(value), value);
  }
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, { functions: { [GUARD]: SQL102_GUARD } })}\n\`\`\``));
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 46, 2026-11-11\); staging acceptance: the staging apply under the owner's run approval \("then apply SQL 154 in staging"; no separate acceptance statement\); production pin execute-authorized; not applied to production/);
  assert.match(runbook, /read-live \(2026-11-11\)\.\*\* Run 43033279908/);
  assert.ok(runbook.includes(pin.expected_live_definition_sha256));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql154-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, ['sql102']);
  assert.deepEqual(spec.supersedes, ['sql102', 'sql98']);
  for (const absent of ['runs_before', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  // SQL 151 is never applied: no spec, no pin, not packed, not a workflow choice.
  assert.equal(RELEASE_SQL_SPECS.sql151, undefined);
  assert.equal(PINS.sql151, undefined);
  assert.equal(packed['aws/workflows/sql/' + '151_tenant_starter_package.sql'], undefined);
  assert.doesNotMatch(workflow, /- sql151-/);
  // SQL 102 and SQL 154 supersede SQL 98; only SQL 154 supersedes SQL 102; nothing supersedes, refuses after or
  // depends on SQL 154, and no refuse_after is added to SQL 102 (re-running it puts back its guard: fail closed).
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes('sql98')), ['sql102', KEY]);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes('sql102')), [KEY]);
  assert.equal(RELEASE_SQL_SPECS.sql102.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration but SQL 93, 96, 98 and 102 (the guard) touches SQL 154's functions, columns or triggers.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    for (const fn of FNS) assert.ok(!touched.includes(fn) || (fn === GUARD && ['sql93', 'sql96', 'sql98', 'sql102'].includes(key)), `${key} ${fn}`);
    assert.ok(!(other.added_columns || []).some((c) => COLUMNS.some(([table, column]) => c.table === table && c.column === column)), key);
    assert.ok(!(other.triggers || []).some((t) => ['aws_check_billing_event_starter_package', 'aws_tenant_starter_package_audit'].includes(t.name)), key);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, FNS);
  assert.deepEqual(prod.predecessors, ['sql102']);
  // Production pin execute-authorized (owner-approved pin change of 2026-11-11) on the staging apply. Its pre-state is
  // production's own (read-only inspect SSM b64a59d7), the derived one, the same pre-state staging recorded.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-11-11 /);
  assert.equal(prod.authorization_phrase, 'APPLY_TENANT_STARTER_PACKAGE');
  assert.equal(prod.expected_live_definition_sha256, prod.production_inspect.live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, PRE);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.staging_acceptance.ok, true);
  assert.ok(prod.production_inspect.note.includes(PRE));
  assert.ok(prod.order_note.includes(PRE));
  assert.ok(prod.intended_post_state.note.includes(pin.intended_replacement_sha256));
  // SQL 102's pins are as applied and retired; this change does not touch them.
  assert.equal(PINS.sql102.execute, true, 'the staging SQL 102 pin as committed');
  const sql102 = JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS.sql102.production_pin_rel), 'utf8'));
  assert.equal(sql102.execute, false);
  assert.equal(sql102.applied.result, 'applied');
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

test('reviewed file and spec: SQL 151 plus the GRANT of EXECUTE on the Checks used to checksops; four functions and the guard, five columns, the CHECK, two triggers', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  // SQL 154's statements are SQL 151's, but the one GRANT and its own labels.
  const code = (text) => text.split('\n').filter((line) => !line.startsWith('--')).join('\n');
  const normalize = (text) => code(text).replace(/sql15[14]_/g, 'sqlN_').replace(/'SQL 15[14]([: ])/g, "'SQL N$1")
    .replace('aws_failed_deposit_fee_cents() (SQL 149)', 'aws_failed_deposit_fee_cents() (SQL 152)');
  assert.equal(code(TEXT).split(GRANT).length, 2);
  assert.equal(code(SQL151).split(GRANT).length, 1);
  assert.equal(normalize(code(TEXT).replace(GRANT, '')), normalize(SQL151));
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs).sort(), FNS.map((fn) => fn.replace(/^public\.|\(.*$/g, '')).sort());
  for (const name of ['aws_starter_package_checks_used', 'aws_apply_starter_package_to_event', 'aws_platform_owner_set_tenant_starter_package', 'aws_tenant_starter_package_audit_row']) {
    assert.equal(defs[name].security_definer, true, name);
    assert.deepEqual([...defs[name].config].sort(), ['row_security=off', 'search_path=public'], name);
  }
  // The guard: SQL 102's attributes; its body SQL 102's plus the four package columns for the platform owner.
  const { prosrc_sha256: newBody, ...newAttrs } = releaseIntendedState(KEY, TEXT).functions[GUARD];
  const { prosrc_sha256: oldBody, ...oldAttrs } = SQL102_GUARD;
  assert.deepEqual(newAttrs, oldAttrs);
  assert.notEqual(newBody, oldBody);
  const body = defs.aws_tenants_member_column_guard.prosrc;
  const old = releaseFunctionDefinitions(SQL102).aws_tenants_member_column_guard.prosrc;
  const added = body.split('\n').filter((line) => !old.split('\n').includes(line)).map((line) => line.trim());
  assert.deepEqual(added, [
    "|| public.aws_tenant_profile_columns() || ARRAY['moov_environment']",
    "|| ARRAY['starter_package_enabled', 'starter_package_starts_on',",
    "'starter_package_maintenance_ends_on', 'starter_package_included_checks'];",
  ]);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, fn.acl]), Object.entries(ACLS));
  assert.deepEqual(spec.added_columns.map((c) => [c.table, c.column, c.type, c.notnull, c.default, c.acl]), COLUMNS.map((c) => [...c, []]));
  assert.deepEqual(spec.constraints.map((c) => [c.table, c.name]), [['public.tenants', 'tenants_starter_package_valid']]);
  assert.deepEqual(spec.triggers.map((t) => [t.table, t.name]), [
    ['public.check_billing_events', 'aws_check_billing_event_starter_package'], ['public.tenants', 'aws_tenant_starter_package_audit']]);
  assert.deepEqual(spec.definer_writes, ['public.tenants', 'public.tenant_pricing_audit', 'public.check_billing_events']);
  assert.deepEqual(spec.altered_relations, ['public.tenants', 'public.check_billing_events']);
  for (const name of ['public.aws_check_processing_price_cents(uuid)', 'public.aws_failed_deposit_fee_cents()', GUARD,
    'public.aws_tenant_profile_columns()', 'public.aws_tenant_has_moov_account(uuid)', 'public.aws_tenant_pricing_columns()', 'public.tenant_pricing_audit']) {
    assert.ok(spec.prerequisites.includes(name), name);
    assert.ok(TEXT.includes(name), name);
  }
  for (const kind of ['tables', 'policies', 'table_privileges', 'column_acl', 'acl_functions', 'dropped_functions', 'views', 'indexes']) assert.equal(spec[kind], undefined, kind);
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, FNS);
  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(text, /^release sql154 v1\n/);
  assert.ok(text.includes(`function ${CHECKS_USED}: lang=sql vol=s parallel=u secdef=true result=integer config=row_security=off;search_path=public prosrc=${sha(defs.aws_starter_package_checks_used.prosrc)} acl=checksops EXECUTE;owner EXECUTE\n`));
});

test('PostgreSQL 16, default privileges on: SQL 154 through the executor: refused without SQL 120 and SQL 152, the pre-state as derived, a pending pin and drift cannot apply, one apply on the intended fingerprint, then already in place; SQL 102, 98, 96 and 93 still applied through SQL 154', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql154-exec-', 59540, { extra: [...sql98To100Schema(), PAYMENT_SCHEMA, SQL152_SCHEMA] });
  const { admin, connectAs } = fx;
  try {
    const asOwner = async (texts) => {
      const owner = await connectAs('checksops_admin');
      try { for (const text of texts) await owner.query(text); } finally { await owner.end(); }
    };
    const seen = [];
    const connect = async () => {
      const client = await connectAs('checksops_admin');
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const inspect = async (key = KEY) => {
      seen.length = 0;
      const result = await handlerFor(connect)(inspectEvent(key));
      assert.equal(result.ok, true, `${key}: ${JSON.stringify(result)}`);
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      return result.details.receipt;
    };
    const apply = async (live) => {
      const pin = Object.freeze({ ...PINS[KEY], expected_live_definition_sha256: live, execute: true, authorization: 'Owner approved test fixture' });
      return handlerFor(connect, { pins: { [KEY]: pin } })(releaseEvent({ pin }));
    };
    const guardBody = async () => (await admin.query('SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure($1)', [GUARD])).rows[0]?.prosrc ?? null;

    // SQL 90-102 as the owner (SQL 29 and SQL 30 first), as both databases have them.
    await fx.applyPredecessors();
    await asOwner(['sql90', 'sql91', 'sql92', 'sql93', 'sql94', 'sql96', 'sql97', 'sql95', 'sql98', 'sql99', 'sql100', 'sql101', 'sql102'].map((key) => TEXTS[key]));
    assert.equal((await inspect('sql102')).already_applied, true);
    await admin.query(DEFAULT_PRIVILEGES);

    // SQL 120 and SQL 152 missing: their price functions are prerequisites, and the file refuses too.
    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.predecessors, { sql102: true });
    assert.deepEqual(early.release_sql_inspect.prerequisites_missing, ['public.aws_check_processing_price_cents(uuid)', 'public.aws_failed_deposit_fee_cents()']);
    assert.ok(early.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    const direct = await connectAs('checksops_admin');
    try {
      await assert.rejects(direct.query(TEXT), (e) => e.code === '55000' && /sql154_prerequisite_missing: .*SQL 120.*SQL 152/.test(e.message));
    } finally {
      await direct.end();
    }
    await asOwner([SQL120, SQL152]);
    assert.equal((await inspect('sql152')).already_applied, true);

    // SQL 102's guard, everything else absent: the derived pre-state.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(r.release_sql_inspect.predecessors, { sql102: true });
    assert.equal(r.already_applied, false);
    assert.deepEqual(r.release_sql_inspect.functions.map((row) => row.state), ['absent', 'absent', 'absent', 'absent', 'different']);
    assert.equal(r.live_definition_sha256, PRE, 'the live pre-state equals the one derived from SQL 102\'s bytes');
    // A pending pin cannot apply (pend a copy of the committed pin, the pre-state recorded).
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: PRE });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    // Drift between the recorded pre-state and the apply refuses (the guard's PUBLIC EXECUTE revoked).
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${GUARD} FROM PUBLIC`);
    assert.equal((await apply(PRE)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`GRANT EXECUTE ON FUNCTION ${GUARD} TO PUBLIC`);
    assert.equal(await guardBody(), releaseFunctionDefinitions(SQL102).aws_tenants_member_column_guard.prosrc);
    assert.equal((await inspect()).live_definition_sha256, PRE);

    const applied = await apply(PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.release_sql_inspect.functions.map((row) => row.state), ['intended', 'intended', 'intended', 'intended', 'intended']);
    assert.equal(await guardBody(), releaseFunctionDefinitions(TEXT).aws_tenants_member_column_guard.prosrc);
    // The API login can read the Checks used (SQL 154's one change from SQL 151), not run the trigger functions.
    const privs = (await admin.query(`SELECT has_function_privilege('checksops', $1, 'EXECUTE') AS used,
        has_function_privilege('checksops', 'public.aws_apply_starter_package_to_event()', 'EXECUTE') AS apply,
        has_function_privilege('checksops', 'public.aws_tenant_starter_package_audit_row()', 'EXECUTE') AS audit`, [CHECKS_USED])).rows[0];
    assert.deepEqual(privs, { used: true, apply: false, audit: false });
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.tenants WHERE starter_package_enabled')).rows[0].n, 0, 'every tenant starts off');
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(PRE)).code, CODES.UNRELATED_MUTATION);

    // SQL 102's own fingerprint has moved on (its guard is SQL 154's now), but SQL 102 still counts as applied through
    // SQL 154 (supersedes), SQL 98 through SQL 154 too (SQL 102's own partial names SQL 102's guard), and SQL 96 / SQL
    // 93 through SQL 98.
    const s102 = await inspect('sql102');
    assert.equal(s102.already_applied, false);
    assert.equal(s102.release_sql_inspect.predecessors.sql98, true);
    assert.equal((await inspect('sql98')).release_sql_inspect.predecessors.sql96, true);
    assert.equal((await inspect('sql96')).release_sql_inspect.predecessors.sql93, true);
    assert.deepEqual((await inspect()).release_sql_inspect.predecessors, { sql102: true });
    // ...only while every other SQL 102 object still matches: a drifted SQL 102 grant is not SQL 102 applied.
    await admin.query('REVOKE EXECUTE ON FUNCTION public.aws_tenant_profile_columns() FROM checksops');
    try {
      const drifted = await inspect();
      assert.equal(drifted.already_applied, true);
      assert.deepEqual(drifted.release_sql_inspect.predecessors, { sql102: false });
    } finally {
      await admin.query('GRANT EXECUTE ON FUNCTION public.aws_tenant_profile_columns() TO checksops');
    }
    // ...and every other SQL 98 object: a drifted SQL 98 grant is not SQL 98 applied.
    await admin.query('REVOKE EXECUTE ON FUNCTION public.aws_tenant_deposits_enabled(uuid) FROM authenticated');
    try {
      assert.equal((await inspect('sql102')).release_sql_inspect.predecessors.sql98, false);
    } finally {
      await admin.query('GRANT EXECUTE ON FUNCTION public.aws_tenant_deposits_enabled(uuid) TO checksops, authenticated');
    }
    assert.equal((await inspect('sql102')).release_sql_inspect.predecessors.sql98, true);
    // Re-running the reviewed bytes is a no-op on the fingerprint (idempotent).
    await asOwner([TEXT]);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
