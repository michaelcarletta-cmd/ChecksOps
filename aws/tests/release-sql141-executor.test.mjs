/**
 * SQL 141 (aws/workflows/sql/141_permanent_vendor_payees.sql) in the staging guarded executor, on the
 * release engine shared with SQL 90-140 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 141 included); this file
 * covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 56), code-derived, selectable, packed, in step with the
 *     production pin (pending); the pinned commit authored the bytes; no predecessor;
 *   - the spec: the three SECURITY DEFINER functions as the engine parses them (EXECUTE checksops and the
 *     owner), the two SELECT policies, the two new tables (columns, constraints, indexes, RLS on and not
 *     forced, ACL exactly SELECT for checksops and authenticated), definer_writes the two relations the
 *     file's own sql141_definer_cannot_read rule names; the expected pre-state (every object absent) is
 *     derived here; the pre- and post-conditions;
 *   - the file: the fail-closed prerequisite block, no change to public.tenants or any existing object;
 *   - on PostgreSQL 16 (the release fixture plus tenant_partner_code_aliases, with default privileges that
 *     grant every new table to checksops and authenticated, as on the restored databases): the read-live
 *     reads the derived pre-state; a pending pin cannot apply; drift refuses; one apply through the
 *     executor reaches the intended fingerprint (the default-privilege grants revoked), then is refused
 *     as already in place.
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
  AUTHORIZED_SQL141_PERMANENT_VENDOR_PAYEES,
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
  releaseSharedPostconditionFailures,
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-04T13:00:00.000Z';
const KEY = 'sql141';
const VENDORS = 'public.vendor_tenants';
const PAYEES = 'public.tenant_vendor_payees';
const TABLES = Object.freeze([VENDORS, PAYEES]);
const FUNCTIONS = Object.freeze([
  'public.aws_vendor_payee_add(uuid, text)',
  'public.aws_vendor_payee_remove(uuid, uuid)',
  'public.aws_platform_owner_set_tenant_vendor(uuid, boolean)',
]);
const POLICIES = Object.freeze([[VENDORS, 'aws_select_vendor_tenants'], [PAYEES, 'aws_select_tenant_vendor_payees']]);
/** Expected pre-state (every object absent), derived below and read back on PostgreSQL 16. */
const PRE_ABSENT = '16522f0a99f22410a73e4a80e10e48a10a08162171345d72e0f72bc47338982f';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
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
    expiry: '2026-11-04T14:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql141-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 141 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL141_PERMANENT_VENDOR_PAYEES, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/141_permanent_vendor_payees.sql');
  assert.equal(pin.migration_id, '141_permanent_vendor_payees');
  assert.equal(spec.choice, 'sql141-permanent-vendor-payees');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  assertStagingPinState(assert, KEY, pin);
  // Staging apply authorized (owner approved 2026-11-13) from staging read-live run 43474483441: already_applied false,
  // precondition_failures []. It read the derived pre-state (every object absent).
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-13: staging apply (wave 56) from staging read-live run 43474483441');
  assert.equal(pin.expected_live_definition_sha256, PRE_ABSENT);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-141-apply.md'), 'utf8'), /\*\*Status:\*\* applied to staging \(wave 56\) and to production \(2026-11-13\); the production pin is retired/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-141-apply.md'), 'utf8'), /read-live \(2026-11-13\)\.\*\* Run 43474483441/);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '4d50013eb0b30808a2a13a97b4a1700b33a833a943bbad865627b77aaf836729');
  assert.notEqual(PRE_ABSENT, pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql141-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FUNCTIONS);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), FUNCTIONS);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 141, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates the tables, the policies or the functions.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => key !== KEY && ((RELEASE_SQL_SPECS[key].tables || []).some((t) => TABLES.includes(t.name))
    || RELEASE_SQL_SPECS[key].functions.some((fn) => FUNCTIONS.includes(fn.identity))
    || (RELEASE_SQL_SPECS[key].policies || []).some((p) => TABLES.includes(p.table)))), []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, FUNCTIONS);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.match(prod.authorization, /^Applied to production on 2026-11-13; execute is false again/);
  assert.equal(prod.applied.result, 'applied');
  assert.equal(prod.expected_live_definition_sha256, PRE_ABSENT);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.staging_acceptance.ok, true);
  assert.ok(prod.production_inspect.note.includes(PRE_ABSENT));
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

test('reviewed file and spec: three DEFINER functions as parsed, two SELECT policies, two new tables; the derived pre-state; pre- and post-conditions', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const code = TEXT.replace(/--[^\n]*/g, '');
  assert.ok(code.trimStart().startsWith('DO $sql141_prereq$'));
  for (const raise of ['sql141_prerequisite_missing', 'sql141_definer_cannot_read']) assert.match(code, new RegExp(`RAISE EXCEPTION '${raise}:`), raise);
  assert.match(code, /CREATE TABLE IF NOT EXISTS public\.vendor_tenants \(/);
  assert.match(code, /CREATE TABLE IF NOT EXISTS public\.tenant_vendor_payees \(/);
  // No statement changes public.tenants or any existing object; nothing to anon, PUBLIC (but revokes) or service_role.
  assert.doesNotMatch(code, /ALTER TABLE public\.tenants\b|ON (TABLE )?public\.tenants\b|CREATE TRIGGER|DROP (TABLE|FUNCTION|TRIGGER)\b/i);
  assert.doesNotMatch(code, /\bTO\s+(anon|PUBLIC|service_role)\b|\banon\b|\bservice_role\b/i);
  assert.deepEqual([...code.matchAll(/^GRANT [^;]+;/gm)].map((m) => m[0].replace(/\s+/g, ' ')), [
    'GRANT SELECT ON TABLE public.vendor_tenants TO checksops, authenticated;',
    'GRANT SELECT ON TABLE public.tenant_vendor_payees TO checksops, authenticated;',
    'GRANT EXECUTE ON FUNCTION public.aws_vendor_payee_add(uuid, text) TO checksops;',
    'GRANT EXECUTE ON FUNCTION public.aws_vendor_payee_remove(uuid, uuid) TO checksops;',
    'GRANT EXECUTE ON FUNCTION public.aws_platform_owner_set_tenant_vendor(uuid, boolean) TO checksops;',
  ]);
  assert.match(TEXT, /A new migration, not an edit to any earlier file/);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs).sort(), FUNCTIONS.map((f) => /^public\.([a-z0-9_]+)\(/.exec(f)[1]).sort());
  const intended = releaseIntendedState(KEY, TEXT);
  for (const identity of FUNCTIONS) {
    const fn = intended.functions[identity];
    assert.equal(fn.language, 'plpgsql', identity);
    assert.equal(fn.volatility, 'v', identity);
    assert.equal(fn.security_definer, true, identity);
    assert.equal(fn.result, 'jsonb', identity);
    assert.deepEqual(fn.config, ['row_security=off', 'search_path=public'], identity);
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], identity);
  }
  const qual = '((tenant_id IN ( SELECT public.aws_user_tenant_ids() AS aws_user_tenant_ids)) OR public.is_platform_owner())';
  assert.deepEqual(spec.policies.map((p) => [p.table, p.name, p.cmd, [...p.roles], p.permissive, p.qual, p.with_check]),
    POLICIES.map(([table, name]) => [table, name, 'SELECT', ['authenticated'], true, qual, null]));
  assert.deepEqual(spec.tables.map((t) => t.name), TABLES);
  for (const t of TABLES) {
    assert.equal(intended.tables[t].rls, true, t);
    assert.equal(intended.tables[t].forced, false, t);
    assert.deepEqual(intended.tables[t].acl, ['authenticated SELECT', 'checksops SELECT'], t);
    assert.deepEqual(intended.tables[t].triggers, [], t);
    assert.deepEqual(intended.tables[t].policies, POLICIES.filter(([table]) => table === t).map(([, name]) => name), t);
  }
  assert.deepEqual(intended.tables[VENDORS].columns.map((c) => c.name), ['tenant_id', 'created_at', 'created_by']);
  assert.deepEqual(intended.tables[PAYEES].columns.map((c) => c.name), ['id', 'tenant_id', 'vendor_tenant_id', 'partner_code_used', 'added_by', 'created_at', 'removed_at', 'removed_by']);
  assert.deepEqual(intended.tables[PAYEES].indexes.map((i) => i.name), ['tenant_vendor_payees_live_pair_key', 'tenant_vendor_payees_pkey', 'tenant_vendor_payees_vendor_idx']);
  assert.deepEqual(intended.tables[PAYEES].constraints.map((c) => c.name), ['tenant_vendor_payees_not_self', 'tenant_vendor_payees_pkey', 'tenant_vendor_payees_tenant_id_fkey', 'tenant_vendor_payees_vendor_tenant_id_fkey']);
  // The prerequisites are the file's prerequisite block; definer_writes its sql141_definer_cannot_read rule.
  assert.deepEqual(spec.prerequisites, [
    'public.tenants', 'public.tenant_users', 'public.tenant_partner_code_aliases', 'auth.uid()', 'public.aws_user_tenant_ids()',
    'public.is_platform_owner()', 'role checksops', 'role authenticated',
    ...['tenants.id', 'tenants.name', 'tenants.partner_code', 'tenants.subscription_status', 'tenant_users.tenant_id', 'tenant_users.user_id',
      'tenant_partner_code_aliases.tenant_id', 'tenant_partner_code_aliases.code'].map((c) => `column public.${c}`),
  ]);
  assert.deepEqual(spec.definer_writes, ['public.tenants', 'public.tenant_partner_code_aliases']);
  assert.match(code, /t\.oid IN \('public\.tenants'::regclass, 'public\.tenant_partner_code_aliases'::regclass\)/);
  for (const absent of ['altered_relations', 'table_privileges', 'column_acl', 'added_columns', 'constraints', 'triggers', 'whole_tables', 'render']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The expected pre-state: every object absent.
  assert.equal(releaseStateText(KEY, {}), [
    'release sql141 v1',
    ...FUNCTIONS.map((f) => `function ${f}: absent`),
    ...POLICIES.map(([table, name]) => `policy ${table} ${name}: absent`),
    ...TABLES.map((t) => `table ${t}: absent`),
  ].join('\n'));
  assert.equal(releaseStateHash(KEY, {}), PRE_ABSENT);
  // Unrelated snapshot: only the new tables, their policies and the three functions are skipped.
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_relations, TABLES);
  assert.deepEqual(scope.skip_functions, FUNCTIONS);
  assert.deepEqual(scope.skip_policies, POLICIES.map(([table, name]) => `${table}.${name}`));
  for (const field of ['acl_relations', 'skip_columns', 'skip_constraints', 'skip_triggers', 'skip_views', 'skip_indexes', 'skip_not_null_columns']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: absent objects pass; a table of another shape refuses; the prerequisites and the
  // definer read rule are required.
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], definer: Object.fromEntries(spec.definer_writes.map((t) => [t, true])) };
  const absent = { functions: Object.fromEntries(FUNCTIONS.map((f) => [f, { exists: false }])), tables: Object.fromEntries(TABLES.map((t) => [t, { exists: false }])) };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...absent, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.ok(pre({ tables: { ...absent.tables, [PAYEES]: { ...intended.tables[PAYEES], columns: intended.tables[PAYEES].columns.slice(1) } } }).includes('created_tables_absent_or_intended'));
  assert.ok(pre({ tables: { ...absent.tables, [VENDORS]: { ...intended.tables[VENDORS], acl: ['authenticated SELECT', 'checksops INSERT', 'checksops SELECT'] } } }).includes('created_tables_absent_or_intended'));
  assert.ok(pre({ prerequisites_missing: ['public.tenant_partner_code_aliases'] }).includes('prerequisites_present'));
  assert.ok(pre({ definer: { ...base.definer, 'public.tenant_partner_code_aliases': false } }).includes('definer_can_write_relations'));
  assert.ok(pre({ functions: { ...absent.functions, [FUNCTIONS[0]]: { exists: true, owner_is_login: false, result: 'jsonb', acl: [] } } }).includes('functions_owned_by_login'));
  assert.ok(pre({ functions: { ...absent.functions, [FUNCTIONS[0]]: { exists: true, owner_is_login: true, result: 'jsonb', acl: ['authenticated EXECUTE'] } } }).includes('function_acl_replaceable'));
  // The intended objects are the intended state; nothing is another state.
  assert.equal(releaseStateHash(KEY, intended), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, absent), PINS[KEY].intended_replacement_sha256);
  const pin = PINS[KEY];
  // Post-conditions: the intended fingerprint, the tables and functions owned by the login.
  const owned = {
    functions: Object.fromEntries(FUNCTIONS.map((f) => [f, { exists: true, owner_is_login: true }])),
    tables: Object.fromEntries(TABLES.map((t) => [t, { exists: true, owner_is_login: true }])),
  };
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, { ...owned, live_definition_sha256: pin.intended_replacement_sha256 }, pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, { ...owned, live_definition_sha256: 'f'.repeat(64) }, pin), ['intended_state']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, { ...owned, tables: { ...owned.tables, [PAYEES]: { exists: true, owner_is_login: false } }, live_definition_sha256: pin.intended_replacement_sha256 }, pin), ['created_tables_owned_by_login']);
});

/** tenant_partner_code_aliases (not in the release fixture) and the restore's default privileges on new tables. */
const ALIASES = `
CREATE TABLE IF NOT EXISTS public.tenant_partner_code_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_partner_code_aliases ENABLE ROW LEVEL SECURITY;
ALTER DEFAULT PRIVILEGES FOR ROLE checksops_admin IN SCHEMA public GRANT ALL ON TABLES TO checksops, authenticated;`;

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
  const fx = await releaseFixture(pg, prefix, port, { extra: [ALIASES] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 141 through the executor: the derived pre-state, a pending pin cannot apply, drift refused, one apply on the intended fingerprint, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql141-exec-', 60341, async ({ admin, connectAs }) => {
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
  const present = async () => (await admin.query("SELECT to_regclass('public.vendor_tenants') IS NOT NULL AS v, to_regclass('public.tenant_vendor_payees') IS NOT NULL AS p")).rows[0];

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, {});
  assert.equal(r.already_applied, false);
  assert.equal(r.live_definition_sha256, PRE_ABSENT);
  assert.deepEqual(await present(), { v: false, p: false });
  // A pending pin cannot apply (a pending copy of the pin; the committed pin is staging-authorized, wave 56).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  assert.equal(pendingPin(PINS[KEY]).execute, false);
  // Drift between the recorded pre-state and the apply refuses.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query("CREATE FUNCTION public.aws_vendor_payee_remove(uuid, uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$");
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await owner.query('DROP FUNCTION public.aws_vendor_payee_remove(uuid, uuid)');
  } finally {
    await owner.end();
  }

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  assert.deepEqual(await present(), { v: true, p: true });
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  // The default-privilege grants of a new table are revoked: only the owner and SELECT for checksops and authenticated.
  for (const table of TABLES) {
    const acl = (await admin.query(`SELECT array_agg(pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type) AS acl
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE c.oid = $1::regclass AND a.grantee <> c.relowner`, [table])).rows[0].acl;
    assert.deepEqual([...acl].sort(), ['authenticated SELECT', 'checksops SELECT'], table);
  }
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
