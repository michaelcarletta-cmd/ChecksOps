/**
 * SQL 165 (aws/workflows/sql/165_vendor_payee_lookup_and_payroll_vendor.sql) in the staging guarded executor, on the
 * release engine shared with SQL 90-164 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-13: pay a
 * vendor from a check or a payroll payment ("New migration" and "Record in payroll").
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 165 included); this file covers what is
 * new:
 *
 *   - the pin: staging-authorized from its read-live (wave 57), code-derived, selectable, packed, in step with the pending
 *     production pin; the pinned commit authored the bytes; predecessor SQL 141 (read only, not superseded);
 *   - the file and spec: the new member-checked SECURITY DEFINER read aws_vendor_payees_for_tenant(uuid) (STABLE,
 *     search_path public, row_security off, EXECUTE checksops); on payroll_runs the vendor_tenant_id column with its
 *     foreign key, partial index and column INSERT for checksops, stakeholder_account_id NOT NULL dropped (the engine's
 *     new altered_columns) and the one-payee CHECK; nothing else; the expected pre-state derived from the spec;
 *   - the engine's altered_columns: in the fingerprint (type, NOT NULL, default), refused unless the column is live as
 *     before or as after the file, skipped by the unrelated-catalog snapshot; no other key's fingerprint changes;
 *   - on PostgreSQL 16 (the release fixture with payroll_runs as the repository leaves it): refused before SQL 141
 *     (predecessors_applied); with SQL 141 applied as the owner the inspect reads the derived pre-state; a pending pin
 *     cannot apply; one apply through the executor reaches the intended fingerprint (the unrelated catalog unchanged),
 *     then a second apply is refused (already in place).
 * The behavior (the lookup's answers; payroll runs with exactly one payee) is
 * aws/tests/sql165-vendor-payee-lookup-and-payroll-vendor-pg.test.mjs.
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
  AUTHORIZED_SQL165_VENDOR_PAYEE_LOOKUP_AND_PAYROLL_VENDOR,
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
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseStateHash,
  releaseStateText,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { policyBlock } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-13T12:00:00.000Z';
const KEY = 'sql165';
const FN = 'aws_vendor_payees_for_tenant';
const LOOKUP = `public.${FN}(uuid)`;
const TABLE = 'public.payroll_runs';
const CONSTRAINTS = Object.freeze({
  payroll_runs_vendor_tenant_id_fkey: 'FOREIGN KEY (vendor_tenant_id) REFERENCES public.tenants(id)',
  payroll_runs_one_payee_check: 'CHECK ((num_nonnulls(stakeholder_account_id, vendor_tenant_id) = 1))',
});
const INDEX_DEF = 'CREATE INDEX payroll_runs_vendor_tenant_idx ON public.payroll_runs USING btree (vendor_tenant_id) WHERE (vendor_tenant_id IS NOT NULL)';
const ALTERED = `${TABLE}.stakeholder_account_id`;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL141 = fs.readFileSync(path.join(ROOT, PINS.sql141.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The pre-state both databases are expected to have: everything absent; stakeholder_account_id uuid NOT NULL. */
const PRE_STATE = Object.freeze({ altered_columns: { [ALTERED]: { exists: true, type: 'uuid', notnull: true, default: null } } });
const PRE = releaseStateHash(KEY, PRE_STATE);

/** SQL 141's alias table and public.payroll_runs as the repository leaves it (run as the superuser, then handed to the owner). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS public.tenant_partner_code_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_partner_code_aliases ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  stakeholder_account_id uuid NOT NULL REFERENCES public.stakeholder_accounts(id),
  amount numeric NOT NULL CHECK (amount > 0),
  speed text NOT NULL DEFAULT 'next_day',
  initiated_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payroll_runs TO checksops;
${policyBlock('12_final_select_policies.sql', 'aws_select_payroll_runs')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_payroll_runs')}`;

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
    expiry: '2026-11-13T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql165-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 165 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; predecessor SQL 141; the derived pre-state', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL165_VENDOR_PAYEE_LOOKUP_AND_PAYROLL_VENDOR, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/165_vendor_payee_lookup_and_payroll_vendor.sql');
  assert.equal(pin.migration_id, '165_vendor_payee_lookup_and_payroll_vendor');
  assert.equal(spec.choice, 'sql165-vendor-payee-lookup-and-payroll-vendor');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  assertStagingPinState(assert, KEY, pin);
  // Staging apply authorized (owner approved 2026-11-13) from staging read-live run 43506600170: already_applied false,
  // precondition_failures []. It read the derived pre-state.
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-13: staging apply (wave 57) from staging read-live run 43506600170');
  assert.equal(pin.expected_live_definition_sha256, PRE);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-165-apply.md'), 'utf8'), /\*\*Status:\*\* applied to staging \(wave 57\) and to production \(2026-11-13\); the production pin is retired/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-165-apply.md'), 'utf8'), /read-live \(2026-11-13\)\.\*\* Run 43506600170/);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  // The expected pre-state, derived from the spec: everything absent, stakeholder_account_id uuid NOT NULL.
  assert.equal(PRE, '3a6d086e37c04740397c0b6a99d558ed0a5e907c296f8a99a71ae323acdca248');
  assert.notEqual(PRE, pin.intended_replacement_sha256);
  assert.notEqual(PRE, releaseStateHash(KEY, {}));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql165-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [LOOKUP]);
  assert.deepEqual(spec.predecessors, ['sql141']);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing supersedes or follows SQL 165; SQL 141 is superseded by nothing.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes('sql141')), []);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].predecessors || []).includes('sql141')), [KEY]);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  const prod = productionPin();
  assert.equal(prod.execute, false);
  assert.match(prod.authorization, /^Applied to production on 2026-11-13; execute is false again/);
  assert.equal(prod.applied.result, 'applied');
  assert.equal(prod.expected_live_definition_sha256, PRE);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.staging_acceptance.ok, true);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, ['sql141']);
  assert.ok(prod.order_note.includes(PRE));
  assert.ok(prod.production_inspect.note.includes(PRE));
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-165-apply.md'), 'utf8');
  for (const value of [PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
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

test('reviewed file and spec: the member-checked lookup; payroll_runs vendor_tenant_id, its foreign key, index and column grant, stakeholder_account_id nullable and the one-payee CHECK; nothing else', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), [FN]);
  const fn = defs[FN];
  assert.equal(fn.security_definer, true);
  assert.equal(fn.language, 'plpgsql');
  assert.equal(fn.volatility, 's');
  assert.equal(fn.result, 'jsonb');
  assert.deepEqual([...fn.config].sort(), ['row_security=off', 'search_path=public']);
  // Member check first; reads only SQL 141's two tables and tenants; writes nothing.
  assert.match(fn.prosrc, /IF v_actor IS NULL OR _tenant_id IS NULL\s+OR NOT EXISTS \(SELECT 1 FROM public\.aws_user_tenant_ids\(\) t WHERE t = _tenant_id\) THEN\s+RETURN jsonb_build_object\('ok', false, 'error', 'forbidden'\);/);
  assert.match(fn.prosrc, /WHERE l\.tenant_id = _tenant_id AND l\.removed_at IS NULL;/);
  assert.doesNotMatch(fn.prosrc, /\b(INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE|RAISE)\b/i);
  assert.deepEqual([...new Set([...fn.prosrc.matchAll(/\bpublic\.([a-z_]+)\b/g)].map((m) => m[1]))].sort(),
    ['aws_user_tenant_ids', 'tenant_vendor_payees', 'tenants', 'vendor_tenants']);
  for (const field of ['link_id', 'vendor_tenant_id', 'vendor_name', 'partner_code_used', 'added_at', 'is_vendor', 'subscription_status', 'payable']) {
    assert.match(fn.prosrc, new RegExp(`'${field}', `), field);
  }
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').replace(/'(?:[^']|'')*'/g, "''");
  const statements = outside.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements.map((s) => s.split(' ').slice(0, 3).join(' ')), [
    'DO $body$',
    'CREATE OR REPLACE',
    'REVOKE ALL ON',
    'GRANT EXECUTE ON',
    'COMMENT ON FUNCTION',
    'ALTER TABLE public.payroll_runs',
    'DO $body$',
    'ALTER TABLE public.payroll_runs',
    'DO $body$',
    'CREATE INDEX IF',
    'GRANT INSERT (vendor_tenant_id)',
  ]);
  assert.equal(statements[2], `REVOKE ALL ON FUNCTION ${LOOKUP} FROM PUBLIC`);
  assert.equal(statements[3], `GRANT EXECUTE ON FUNCTION ${LOOKUP} TO checksops`);
  assert.equal(statements[5], `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS vendor_tenant_id uuid`);
  assert.equal(statements[7], `ALTER TABLE ${TABLE} ALTER COLUMN stakeholder_account_id DROP NOT NULL`);
  assert.equal(statements[9], `CREATE INDEX IF NOT EXISTS payroll_runs_vendor_tenant_idx ON ${TABLE} (vendor_tenant_id) WHERE vendor_tenant_id IS NOT NULL`);
  assert.equal(statements[10], `GRANT INSERT (vendor_tenant_id) ON TABLE ${TABLE} TO checksops`);
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|TRIGGER|VIEW)\b/i, /\bDROP\s+(TABLE|POLICY|TRIGGER|FUNCTION|INDEX|CONSTRAINT|COLUMN)\b/i, /\bTRUNCATE\b/i, /ROW LEVEL SECURITY/i, /\bTO\s+authenticated\b/i, /\banon\b/, /\bservice_role\b/]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  // SQL 141's objects are only read: no statement on its tables and no call to its functions.
  assert.doesNotMatch(outside, /\b(ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b[^;]*\b(vendor_tenants|tenant_vendor_payees)\b/i);
  assert.doesNotMatch(TEXT.replace(/--[^\n]*/g, ''), /\b(aws_vendor_payee_add|aws_vendor_payee_remove|aws_platform_owner_set_tenant_vendor)\b/);
  assert.match(TEXT, /Not applied by\s+-- this change/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: LOOKUP, acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(spec.definer_writes, ['public.tenants', 'public.vendor_tenants', 'public.tenant_vendor_payees']);
  assert.deepEqual(spec.added_columns.map((c) => [c.table, c.column, c.type, c.notnull, c.default, c.acl]),
    [[TABLE, 'vendor_tenant_id', 'uuid', false, null, ['checksops INSERT']]]);
  assert.deepEqual(spec.altered_columns, [{ table: TABLE, column: 'stakeholder_account_id', type: 'uuid', default: null, from_notnull: true, notnull: false }]);
  assert.deepEqual(Object.fromEntries(spec.constraints.map((c) => [c.name, c.def])), CONSTRAINTS);
  assert.ok(spec.constraints.every((c) => c.table === TABLE));
  assert.deepEqual(spec.indexes, [{ table: TABLE, name: 'payroll_runs_vendor_tenant_idx', def: INDEX_DEF }]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  for (const absent of ['policies', 'table_privileges', 'tables', 'views', 'triggers', 'column_acl', 'whole_tables']) assert.equal(spec[absent], undefined, absent);
  // The intended and pre-state renderings, as the runbook prints them.
  const intended = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(intended, /^release sql165 v1\nfunction public\.aws_vendor_payees_for_tenant\(uuid\): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=row_security=off;search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE\n/);
  assert.match(intended, /\ncolumn public\.payroll_runs\.vendor_tenant_id: uuid notnull=false default=- acl=checksops INSERT\n/);
  assert.match(intended, /\naltered column public\.payroll_runs\.stakeholder_account_id: uuid notnull=false default=-\n/);
  assert.match(intended, /\nindex public\.payroll_runs payroll_runs_vendor_tenant_idx: [0-9a-f]{64}$/);
  const pre = releaseStateText(KEY, PRE_STATE);
  assert.match(pre, /\naltered column public\.payroll_runs\.stakeholder_account_id: uuid notnull=true default=-\n/);
  assert.match(pre, /column public\.payroll_runs\.vendor_tenant_id: absent/);
  assert.equal(sha(intended), PINS[KEY].intended_replacement_sha256);
  assert.equal(sha(pre), PRE);
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-165-apply.md'), 'utf8');
  assert.ok(runbook.includes(intended), 'the runbook prints the intended fingerprint text');
  assert.ok(runbook.includes(pre), 'the runbook prints the pre-state text');
});

test('engine altered_columns: fingerprinted, refused unless live as before or as after, skipped by the unrelated snapshot; no other key changes', () => {
  const live = (over = {}) => ({ [ALTERED]: { exists: true, type: 'uuid', notnull: true, default: null, ...over } });
  const state = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    altered: { [TABLE]: { exists: true, owner_is_login: true } },
    definer: { 'public.tenants': true, 'public.vendor_tenants': true, 'public.tenant_vendor_payees': true },
    altered_columns: live(),
  };
  const failures = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...state, ...over }, TEXT);
  assert.deepEqual(failures(), []);
  assert.deepEqual(failures({ altered_columns: live({ notnull: false }) }), [], 'already nullable (a re-run)');
  for (const bad of [live({ type: 'text' }), live({ default: 'gen_random_uuid()' }), { [ALTERED]: { exists: false } }, {}]) {
    assert.ok(failures({ altered_columns: bad }).includes('altered_columns_before_or_intended'), JSON.stringify(bad));
  }
  assert.ok(failures({ predecessors_applied: false }).includes('predecessors_applied'));
  assert.ok(failures({ definer: { ...state.definer, 'public.vendor_tenants': false } }).includes('definer_can_write_relations'));
  assert.ok(failures({ altered: { [TABLE]: { exists: true, owner_is_login: false } } }).includes('altered_relations_owned_by_login'));
  // The NOT NULL change moves the fingerprint; a column grant on it does not (not the file's).
  assert.notEqual(releaseStateHash(KEY, { altered_columns: live() }), releaseStateHash(KEY, { altered_columns: live({ notnull: false }) }));
  assert.equal(releaseStateHash(KEY, { altered_columns: live() }), releaseStateHash(KEY, { altered_columns: live({ acl: ['authenticated UPDATE'] }) }));
  const scope = releaseUnrelatedScope(KEY);
  assert.ok(scope.skip_columns.includes(ALTERED));
  assert.ok(scope.skip_not_null_columns.includes(ALTERED));
  assert.ok(scope.skip_columns.includes(`${TABLE}.vendor_tenant_id`));
  assert.ok(scope.skip_indexes.includes('public.payroll_runs_vendor_tenant_idx'));
  // Only SQL 165 uses it, so every other key's fingerprint text has no altered column line.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].altered_columns || []).length), [KEY]);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    assert.doesNotMatch(releaseStateText(key, {}), /altered column/, key);
  }
});

test('PostgreSQL 16: SQL 165 through the executor: refused before SQL 141, the pre-state as derived, a pending pin cannot apply, one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql165-exec-', 59365, { extra: [SCHEMA] });
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
    const runAsOwner = async (sql) => {
      const owner = await connectAs('checksops_admin');
      try {
        await owner.query(sql);
      } finally {
        await owner.end();
      }
    };

    // Before SQL 141: refused.
    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.predecessors, { sql141: false });
    assert.ok(early.precondition_failures.includes('predecessors_applied'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);

    await runAsOwner(SQL141);
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.predecessors, { sql141: true });
    assert.equal(r.already_applied, false);
    // Everything absent, stakeholder_account_id uuid NOT NULL: the derived pre-state.
    assert.equal(r.live_definition_sha256, PRE);

    // A pending copy of the pin cannot apply (the committed pin is staging-authorized, wave 57).
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingPin(PINS[KEY]) } })(releaseEvent({ pin: pendingPin(PINS[KEY]), expected_live_definition_sha256: PRE }));
    assert.equal(pending.ok, false);

    const applied = await apply(PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.equal((await apply(PRE)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
