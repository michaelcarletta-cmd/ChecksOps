/**
 * SQL 113 (aws/workflows/sql/113_payee_setup.sql) in the staging guarded executor, on the release
 * engine shared with SQL 90-112 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 113 included); this
 * file covers what is new:
 *
 *   - the pin: pending (no read-live yet), code-derived, selectable, packed, in step with the
 *     production pin; the pinned commit authored the bytes; no predecessor;
 *   - the spec: six SECURITY DEFINER functions (EXECUTE checksops and the owner), the eleven payee
 *     columns on external_payment_recipients (added_columns), the stakeholder_accounts_origin_check
 *     definition with provider_recipient (constraints) and the SELECT lines of checksops and
 *     authenticated on external_payment_recipients (table_privileges); the definer writes the
 *     three payee tables under RLS (definer_writes);
 *   - the file: a guarded prerequisite block, the column additions, the guarded origin-check
 *     replacement, the SELECT grants and the six functions with their ACLs and comments; no
 *     policy, RLS, table or other grant DDL;
 *   - on PostgreSQL 16 (the payee tables as the supabase migrations left them, restored without
 *     ACLs: helpers/sql113-payee-schema.mjs): one apply through the executor reaches the intended
 *     fingerprint, then is refused as already in place.
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
  AUTHORIZED_SQL113_PAYEE_SETUP,
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
import { PAYEE_SCHEMA, RECIPIENTS, STAKEHOLDERS, METHODS } from './helpers/sql113-payee-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-23T12:00:00.000Z';
const KEY = 'sql113';
const FUNCTIONS = Object.freeze([
  'public.aws_payee_create(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone, uuid, uuid)',
  'public.aws_payee_reissue_link(uuid, text, timestamp with time zone)',
  'public.aws_payee_disconnect(uuid)',
  'public.aws_public_payee_by_token(text)',
  'public.aws_public_payee_record(text, text, jsonb)',
  'public.aws_payee_apply_status(text, text, text)',
]);
const NAMES = Object.freeze(FUNCTIONS.map((identity) => /^public\.([a-z_]+)\(/.exec(identity)[1]));
const COLUMNS = Object.freeze([
  ['stakeholder_account_id', 'uuid'], ['provider_bank_name', 'text'], ['provider_last_four', 'text'],
  ['bank_linked_at', 'timestamp with time zone'], ['provider_bank_account_id', 'text'],
  ['tos_accepted_at', 'timestamp with time zone'], ['identity_submitted_at', 'timestamp with time zone'],
  ['bank_verified_at', 'timestamp with time zone'], ['verified_at', 'timestamp with time zone'],
  ['disconnected_at', 'timestamp with time zone'], ['setup_attempts', 'integer'],
]);
const ORIGIN_FIVE = "CHECK ((origin = ANY (ARRAY['tenant_owned'::text, 'partner_shared'::text, 'homeowner_link'::text, 'provider_connected'::text, 'provider_recipient'::text])))";
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
    expiry: '2026-10-23T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql113-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 113 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL113_PAYEE_SETUP, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/113_payee_setup.sql');
  assert.equal(pin.migration_id, '113_payee_setup');
  assert.equal(spec.choice, 'sql113-payee-setup');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-23, "Apply SQL 113 to staging") from staging
  // read-live run 40018316361: the functions and payee columns absent, so SQL 113 not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-23: staging apply (wave 14) from staging read-live run 40018316361');
  assert.equal(pin.expected_live_definition_sha256, '88787a89c85585f25c18ea31d60740a6526522377a1b0d7b02e7902fe18970c1');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql113-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [...FUNCTIONS]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 113, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces or drops one of SQL 113's functions.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...other.functions.map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.deepEqual(touched.filter((identity) => FUNCTIONS.includes(identity)), [], key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [...pin.function_identities]);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.expected_live_definition_sha256, null);
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

test('reviewed file and spec: guarded prerequisites, payee columns, the guarded origin check, SELECT grants, six SECURITY DEFINER functions EXECUTE checksops only; no policy, RLS or other grant DDL', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), [...NAMES]);
  for (const name of NAMES) {
    const fn = defs[name];
    assert.equal(fn.security_definer, true, name);
    assert.equal(fn.language, 'plpgsql', name);
    // The by-token reader is STABLE (it writes nothing); every writer is VOLATILE.
    assert.equal(fn.volatility, name === 'aws_public_payee_by_token' ? 's' : 'v', name);
    assert.equal(fn.result, 'jsonb', name);
    assert.deepEqual(fn.config, ['search_path=public'], name);
  }
  // Which tables each function writes (statement and table, in body order).
  const writes = (name) => [...defs[name].prosrc.matchAll(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(writes('aws_payee_create'), [`INSERT INTO ${STAKEHOLDERS}`, `INSERT INTO ${RECIPIENTS}`]);
  assert.deepEqual(writes('aws_payee_reissue_link'), [`UPDATE ${RECIPIENTS}`]);
  assert.deepEqual(writes('aws_payee_disconnect'), [`UPDATE ${RECIPIENTS}`, `UPDATE ${STAKEHOLDERS}`, `UPDATE ${METHODS}`]);
  assert.deepEqual(writes('aws_public_payee_by_token'), []);
  assert.deepEqual(writes('aws_public_payee_record'), [
    `UPDATE ${RECIPIENTS}`, `UPDATE ${RECIPIENTS}`, `UPDATE ${RECIPIENTS}`, `UPDATE ${METHODS}`, `INSERT INTO ${METHODS}`,
    `UPDATE ${METHODS}`, `UPDATE ${RECIPIENTS}`, `UPDATE ${METHODS}`, `UPDATE ${RECIPIENTS}`,
  ]);
  assert.deepEqual(writes('aws_payee_apply_status'), [`UPDATE ${RECIPIENTS}`, `UPDATE ${STAKEHOLDERS}`, `UPDATE ${RECIPIENTS}`, `UPDATE ${STAKEHOLDERS}`]);
  for (const name of NAMES) assert.doesNotMatch(defs[name].prosrc, /\bDELETE\b/, name);
  // Tenant-side functions check membership through aws_user_tenant_ids(); verified only after every step.
  for (const name of ['aws_payee_create', 'aws_payee_reissue_link', 'aws_payee_disconnect']) {
    assert.match(defs[name].prosrc, /public\.aws_user_tenant_ids\(\)/, name);
  }
  assert.match(defs.aws_payee_apply_status.prosrc, /rec\.tos_accepted_at IS NULL OR rec\.identity_submitted_at IS NULL\s+OR rec\.provider_bank_account_id IS NULL OR rec\.bank_verified_at IS NULL/);
  assert.match(defs.aws_public_payee_record.prosrc, /rec\.setup_attempts >= 60/);
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').replace(/'(?:[^']|'')*'/g, "''");
  const statements = outside.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.equal(statements.length, 29);
  assert.equal(statements[0], 'DO $body$');
  assert.match(statements[1], /^ALTER TABLE public\.external_payment_recipients ADD COLUMN IF NOT EXISTS stakeholder_account_id uuid,/);
  assert.deepEqual([...statements[1].matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+) ([a-z ]+?)(?:,|$| NOT NULL)/g)].map((m) => [m[1], m[2].replace(/^timestamptz$/, 'timestamp with time zone')]), COLUMNS.map(([c, t]) => [c, t]));
  assert.match(statements[1], /setup_attempts integer NOT NULL DEFAULT 0$/);
  assert.equal(statements[2], 'DO $body$');
  assert.equal(statements[3], 'GRANT SELECT ON TABLE public.external_payment_recipients TO checksops');
  assert.equal(statements[4], 'DO $body$');
  for (let i = 0; i < 6; i += 1) assert.match(statements[5 + i], new RegExp(`^CREATE OR REPLACE FUNCTION public\\.${NAMES[i]}\\(`));
  for (let i = 0; i < 6; i += 1) assert.match(statements[11 + i], new RegExp(`^REVOKE ALL ON FUNCTION public\\.${NAMES[i]}\\(.*\\) FROM PUBLIC$`));
  for (let i = 0; i < 6; i += 1) assert.match(statements[17 + i], new RegExp(`^GRANT EXECUTE ON FUNCTION public\\.${NAMES[i]}\\(.*\\) TO checksops$`));
  for (let i = 0; i < 6; i += 1) assert.match(statements[23 + i], new RegExp(`^COMMENT ON FUNCTION public\\.${NAMES[i]}\\(.*\\) IS ''$`));
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|TRIGGER|INDEX|VIEW)\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /ROW LEVEL SECURITY/i, /\banon\b/, /\bTO\s+PUBLIC\b/i, /\bGRANT\s+(INSERT|UPDATE|DELETE|ALL)\b/i]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  // The guarded blocks: the prerequisite and definer checks, the exact four-value origin check,
  // and authenticated's grant only when the role exists.
  assert.match(TEXT, /sql113_prerequisite_missing/);
  assert.match(TEXT, /sql113_definer_cannot_write/);
  assert.match(TEXT, /sql113_origin_check_unexpected/);
  assert.ok(TEXT.includes("v_def <> 'CHECK ((origin = ANY (ARRAY[''tenant_owned''::text, ''partner_shared''::text, ''homeowner_link''::text, ''provider_connected''::text])))'"));
  assert.match(TEXT, /GRANT SELECT ON TABLE public\.external_payment_recipients TO authenticated;/);
  assert.match(TEXT, /NOT APPLIED\. Apply only through the guarded SQL path/);
  assert.match(TEXT, /20260728110453/);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, FUNCTIONS.map((identity) => ({ identity, acl: ['checksops EXECUTE', 'owner EXECUTE'] })));
  assert.deepEqual(spec.added_columns, COLUMNS.map(([column, type]) => ({
    table: RECIPIENTS, column, type, notnull: column === 'setup_attempts', default: column === 'setup_attempts' ? '0' : null, acl: [],
  })));
  assert.deepEqual(spec.constraints, [{ table: STAKEHOLDERS, name: 'stakeholder_accounts_origin_check', def: ORIGIN_FIVE }]);
  assert.deepEqual(spec.table_privileges, [{ table: RECIPIENTS, grantees: ['authenticated', 'checksops'], privileges: ['SELECT'], intended: ['authenticated SELECT', 'checksops SELECT'] }]);
  assert.deepEqual(spec.altered_relations, [RECIPIENTS, STAKEHOLDERS]);
  assert.deepEqual(spec.definer_writes, [RECIPIENTS, STAKEHOLDERS, METHODS]);
  for (const field of ['policies', 'tables', 'views', 'triggers', 'indexes', 'dropped_functions', 'acl_functions', 'whole_tables', 'render', 'counts']) {
    assert.equal(spec[field], undefined, field);
  }
  // Prerequisites: the file's own list (tables, helpers, role, every column it checks) plus authenticated.
  const fileColumns = [...TEXT.slice(TEXT.indexOf("('external_payment_recipients', 'id')"), TEXT.indexOf(') AS want(tbl, col)'))
    .matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.equal(fileColumns.length, 63);
  assert.deepEqual(spec.prerequisites, [RECIPIENTS, STAKEHOLDERS, METHODS, 'public.tenants', 'public.tenant_users',
    'public.aws_user_tenant_ids()', 'auth.uid()', 'role checksops', 'role authenticated', ...fileColumns]);
  for (const column of COLUMNS.map(([c]) => c).filter((c) => c !== 'stakeholder_account_id')) {
    assert.ok(!spec.prerequisites.includes(`column ${RECIPIENTS}.${column}`), column);
  }

  const intended = releaseIntendedState(KEY, TEXT);
  const text = releaseStateText(KEY, intended);
  const lines = text.split('\n');
  assert.equal(lines.length, 1 + 6 + 11 + 1 + 1);
  assert.equal(lines[0], 'release sql113 v1');
  FUNCTIONS.forEach((identity, i) => assert.match(lines[1 + i], new RegExp(`^function ${identity.replace(/[()]/g, '\\$&')}: lang=plpgsql vol=${i === 3 ? 's' : 'v'} parallel=u secdef=true result=jsonb config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE$`)));
  COLUMNS.forEach(([column, type], i) => assert.equal(lines[7 + i], `column ${RECIPIENTS}.${column}: ${type} notnull=${column === 'setup_attempts'} default=${column === 'setup_attempts' ? sha('0') : '-'} acl=`));
  assert.equal(lines[18], `constraint ${STAKEHOLDERS} stakeholder_accounts_origin_check: ${sha(ORIGIN_FIVE)} validated=true`);
  assert.equal(lines[19], `privileges ${RECIPIENTS} SELECT: authenticated SELECT;checksops SELECT`);
  assert.equal(releaseStateHash(KEY, intended), PINS[KEY].intended_replacement_sha256);
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.acl_relations, [RECIPIENTS]);
  assert.deepEqual(scope.skip_functions, [...FUNCTIONS]);
  assert.deepEqual(scope.skip_columns, COLUMNS.map(([c]) => `${RECIPIENTS}.${c}`));
  assert.deepEqual(scope.skip_constraints, [`${STAKEHOLDERS}.stakeholder_accounts_origin_check`]);
  for (const field of ['skip_relations', 'skip_policies', 'skip_triggers', 'skip_views', 'skip_indexes']) assert.deepEqual(scope[field], [], field);

  // Pre-conditions: the definer-write and ownership checks; a payee column that already exists
  // must already be the file's column; any held subset of the SELECT lines passes.
  const owned = Object.fromEntries(spec.altered_relations.map((t) => [t, { exists: true, owner_is_login: true }]));
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    altered: owned, definer: Object.fromEntries(spec.definer_writes.map((table) => [table, true])),
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ definer: { ...base.definer, [METHODS]: false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ altered: { ...owned, [STAKEHOLDERS]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ prerequisites_missing: ['column public.payment_provider_methods.holder_name'] }), ['prerequisites_present']);
  const col = (over) => ({ [`${RECIPIENTS}.stakeholder_account_id`]: { exists: true, type: 'uuid', notnull: false, default: null, acl: [], ...over } });
  assert.deepEqual(pre({ columns: col({}) }), []);
  assert.deepEqual(pre({ columns: col({ type: 'text' }) }), ['added_columns_absent_or_intended']);
  assert.deepEqual(pre({ columns: col({ acl: ['authenticated SELECT'] }) }), ['added_columns_absent_or_intended']);
  assert.deepEqual(pre({ columns: { [`${RECIPIENTS}.setup_attempts`]: { exists: true, type: 'integer', notnull: false, default: '0', acl: [] } } }), ['added_columns_absent_or_intended']);
  const fnRow = (acl) => ({ [FUNCTIONS[0]]: { exists: true, owner_is_login: true, result: 'jsonb', acl } });
  assert.deepEqual(pre({ functions: fnRow(['PUBLIC EXECUTE', 'owner EXECUTE']) }), []);
  assert.deepEqual(pre({ functions: fnRow(['authenticated EXECUTE', 'owner EXECUTE']) }), ['function_acl_replaceable']);
  for (const held of [[], ['checksops SELECT'], ['authenticated SELECT', 'checksops SELECT']]) {
    assert.deepEqual(pre({ privileges: { [RECIPIENTS]: { exists: true, lines: held, other: ['service_role SELECT'] } } }), [], String(held));
  }
  // The origin check is the file's own guard: a three-value or a six-value live check is another
  // state (the fingerprint), never an engine precondition.
  const withCheck = (def) => releaseStateHash(KEY, { ...intended, constraints: { [`${STAKEHOLDERS} stakeholder_accounts_origin_check`]: { exists: true, def, validated: true } } });
  assert.equal(withCheck(ORIGIN_FIVE), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(withCheck(ORIGIN_FIVE.replace(", 'provider_recipient'::text", '')), PINS[KEY].intended_replacement_sha256);
  // Post-conditions: the intended fingerprint, the functions owned by the login, other grants unchanged.
  const pin = PINS[KEY];
  const fnsOwned = Object.fromEntries(FUNCTIONS.map((identity) => [identity, { owner_is_login: true }]));
  const st = (other) => ({ live_definition_sha256: pin.intended_replacement_sha256, functions: fnsOwned, altered: owned, privileges: { [RECIPIENTS]: { exists: true, lines: ['authenticated SELECT', 'checksops SELECT'], other } } });
  const before = st(['service_role SELECT']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(['service_role SELECT']), pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(['checksops INSERT', 'service_role SELECT']), pin), ['other_table_privileges_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, { ...st(['service_role SELECT']), live_definition_sha256: 'f'.repeat(64) }, pin), ['intended_state']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, { ...st(['service_role SELECT']), functions: { ...fnsOwned, [FUNCTIONS[5]]: { owner_is_login: false } } }, pin), ['functions_owned_by_login']);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [PAYEE_SCHEMA] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 113 through the executor: a pending pin cannot apply, drift refused, one apply on the intended fingerprint, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql113-exec-', 59213, async ({ admin, connectAs }) => {
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

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, {});
  assert.equal(r.already_applied, false);
  assert.deepEqual(r.release_sql_inspect.functions.map((f) => f.state), FUNCTIONS.map(() => 'absent'));
  // The supabase-era columns are already the file's; the payee state columns are absent.
  assert.deepEqual(r.release_sql_inspect.columns.map((c) => [c.name.replace(/^external_payment_recipients\./, ''), c.state]),
    COLUMNS.map(([c]) => [c, ['stakeholder_account_id', 'provider_bank_name', 'provider_last_four', 'bank_linked_at'].includes(c) ? 'intended' : 'absent']));
  assert.deepEqual(r.release_sql_inspect.constraints.map((c) => c.state), ['different']);
  assert.deepEqual(r.release_sql_inspect.table_privileges, [{ name: 'external_payment_recipients', lines: [], other_write_grants: [] }]);
  assert.deepEqual(r.release_sql_inspect.definer_writes.map((d) => d.ok), [true, true, true]);
  // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`GRANT SELECT ON TABLE ${RECIPIENTS} TO checksops`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`REVOKE SELECT ON TABLE ${RECIPIENTS} FROM checksops`);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  const check = (await admin.query("SELECT pg_catalog.pg_get_constraintdef(oid) AS d FROM pg_catalog.pg_constraint WHERE conname = 'stakeholder_accounts_origin_check'")).rows;
  assert.deepEqual(check, [{ d: ORIGIN_FIVE }]);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
