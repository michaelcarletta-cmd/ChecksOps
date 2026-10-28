/**
 * SQL 122 (aws/workflows/sql/122_mortgage_desk_return_to_tenant.sql) in the staging guarded executor,
 * on the release engine shared with SQL 90-121 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 122 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 21), code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor;
 *   - the file and spec: the column mortgage_handling_requests.return_emailed_at and six SECURITY
 *     DEFINER functions (search_path public), five with EXECUTE for checksops and the owner, the
 *     internal working-request check for the owner only; the four row-type results as PostgreSQL
 *     renders them; no policy, table grant, trigger or other column; the tables each function
 *     writes; the ownership, definer-write, column and ACL pre-conditions refuse;
 *   - on PostgreSQL 16: refused while SQL 100's aws_is_mortgage_ops_agent() is missing; refused
 *     while return_emailed_at exists with another type; a pending pin cannot apply; one apply
 *     through the executor reaches the intended fingerprint, then is refused as already in place.
 * The behavior (the assigned agent returns notes, documents and shipping to the tenant; everyone
 * else refused; the email claim once) is aws/tests/sql122-mortgage-desk-return-pg.test.mjs.
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
  AUTHORIZED_SQL122_MORTGAGE_DESK_RETURN_TO_TENANT,
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
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-27T12:00:00.000Z';
const KEY = 'sql122';
const WORKING = 'public.aws_mortgage_desk_working_request(uuid, text[])';
const POST = 'public.aws_mortgage_desk_post_message(uuid, text)';
const ATTACH = 'public.aws_mortgage_desk_attach_file(uuid, text, text, text, bigint, text, text)';
const SHIPPING = 'public.aws_mortgage_desk_update_shipping(uuid, jsonb)';
const TIMELINE = 'public.aws_mortgage_desk_completion_timeline(uuid)';
const EMAIL = 'public.aws_mortgage_desk_return_email_claim(uuid)';
const FNS = [WORKING, POST, ATTACH, SHIPPING, TIMELINE, EMAIL];
const WRITES = ['public.check_messages', 'public.check_files', 'public.mortgage_handling_requests', 'public.homeowner_ledger_events'];
const COLUMN = 'public.mortgage_handling_requests.return_emailed_at';
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
    expiry: '2026-10-27T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql122-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// The columns SQL 122 reads or writes beyond the release fixture and SQL 98-100's extra schema
// (check_files, homeowner_ledger_events and mortgage_handling_requests as the restored database
// has them). SQL 100's aws_is_mortgage_ops_agent() is added only after the first inspect (the
// prerequisite refusal).
const DESK_SCHEMA = `
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE public.check_intake_items ADD COLUMN IF NOT EXISTS check_number text;
ALTER TABLE public.check_files
  ADD COLUMN file_name text, ADD COLUMN file_type text, ADD COLUMN file_size bigint, ADD COLUMN category text NOT NULL DEFAULT 'other',
  ADD COLUMN source text NOT NULL DEFAULT 'manual', ADD COLUMN uploaded_by uuid, ADD COLUMN description text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.homeowner_ledger_events
  ADD COLUMN check_id uuid, ADD COLUMN event_type text NOT NULL DEFAULT 'note', ADD COLUMN occurred_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN actor_label text, ADD COLUMN payload_json jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN created_by uuid;
ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN requested_by uuid, ADD COLUMN mail_to_name text, ADD COLUMN mail_to_address text, ADD COLUMN shipping_label_path text,
  ADD COLUMN shipping_label_name text, ADD COLUMN shipping_label_carrier text, ADD COLUMN shipping_label_tracking text,
  ADD COLUMN shipping_label_uploaded_at timestamptz, ADD COLUMN shipping_label_uploaded_by uuid,
  ADD COLUMN check_sent_date timestamptz, ADD COLUMN check_received_back_date timestamptz;
ALTER TABLE public.homeowner_ledger_events ENABLE ROW LEVEL SECURITY;`;
const AGENT_HELPER = `
CREATE FUNCTION public.aws_is_mortgage_ops_agent() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT public.has_role(auth.uid(), 'mortgage_agent'::public.app_role) $$;
ALTER FUNCTION public.aws_is_mortgage_ops_agent() OWNER TO checksops_admin;`;

test('pin: SQL 122 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL122_MORTGAGE_DESK_RETURN_TO_TENANT, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/122_mortgage_desk_return_to_tenant.sql');
  assert.equal(pin.migration_id, '122_mortgage_desk_return_to_tenant');
  assert.equal(spec.choice, 'sql122-mortgage-desk-return-to-tenant');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-27) from staging read-live run 40588288300: the
  // six functions and return_emailed_at absent, so SQL 122 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-27: staging apply (wave 21) from staging read-live run 40588288300');
  assert.equal(pin.expected_live_definition_sha256, 'e13856d7a75483b5785b6e791fd83fbe9da9a1b09f6c819480cee54388a62609');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent (a database without SQL 122) has a fingerprint of its own.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql122-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  // Production pin execute-authorized (owner-approved pin change of 2026-10-27) on the staging apply. Its
  // pre-state is production's own (read-only inspect SSM d21ea074), the same as staging's.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-27 /);
  assert.equal(prod.expected_live_definition_sha256, 'e13856d7a75483b5785b6e791fd83fbe9da9a1b09f6c819480cee54388a62609');
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, prod.intended_replacement_sha256);
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

test('reviewed file and spec: one added column and six definer functions (five for checksops, one owner-only), the row-type results; no policy, grant, trigger or other column; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), [
    'aws_mortgage_desk_working_request', 'aws_mortgage_desk_post_message', 'aws_mortgage_desk_attach_file',
    'aws_mortgage_desk_update_shipping', 'aws_mortgage_desk_completion_timeline', 'aws_mortgage_desk_return_email_claim',
  ]);
  for (const [name, fn] of Object.entries(defs)) {
    assert.equal(fn.security_definer, true, name);
    assert.equal(fn.language, 'plpgsql', name);
    assert.equal(fn.volatility, 'v', name);
    assert.deepEqual(fn.config, ['search_path=public'], name);
    // No row_security setting: SQL 99's mirror triggers keep running as they do today.
    assert.doesNotMatch(fn.prosrc, /row_security/i, name);
  }
  // Every caller goes through the working-request check first; the tenant and check come from the request.
  for (const name of ['aws_mortgage_desk_post_message', 'aws_mortgage_desk_attach_file', 'aws_mortgage_desk_update_shipping']) {
    assert.match(defs[name].prosrc, /v_req := public\.aws_mortgage_desk_working_request\(_request_id, ARRAY\['in_progress'\]\);/, name);
  }
  for (const name of ['aws_mortgage_desk_completion_timeline', 'aws_mortgage_desk_return_email_claim']) {
    assert.match(defs[name].prosrc, /v_req := public\.aws_mortgage_desk_working_request\(_request_id, ARRAY\['completed'\]\);/, name);
  }
  const working = defs.aws_mortgage_desk_working_request.prosrc;
  assert.match(working, /FROM public\.mortgage_handling_requests WHERE id = _request_id FOR UPDATE;/);
  assert.match(working, /v_req\.assigned_employee_id IS DISTINCT FROM v_uid\s+OR NOT COALESCE\(public\.aws_is_mortgage_ops_agent\(\), false\)/);
  assert.match(working, /NOT COALESCE\(public\.is_platform_owner\(\), false\)/);
  // The tables each function writes.
  const writes = (body) => [...new Set([...body.matchAll(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => m[1]))];
  assert.deepEqual(writes(working), []);
  assert.deepEqual(writes(defs.aws_mortgage_desk_post_message.prosrc), ['public.check_messages']);
  assert.deepEqual(writes(defs.aws_mortgage_desk_attach_file.prosrc), ['public.check_files']);
  assert.deepEqual(writes(defs.aws_mortgage_desk_update_shipping.prosrc), ['public.mortgage_handling_requests']);
  assert.deepEqual(writes(defs.aws_mortgage_desk_completion_timeline.prosrc), ['public.homeowner_ledger_events']);
  assert.deepEqual(writes(defs.aws_mortgage_desk_return_email_claim.prosrc), ['public.mortgage_handling_requests']);
  assert.match(defs.aws_mortgage_desk_return_email_claim.prosrc, /UPDATE public\.mortgage_handling_requests SET return_emailed_at = now\(\) WHERE id = v_req\.id;/);
  // A document path is confined to the request's own check.
  assert.match(defs.aws_mortgage_desk_attach_file.prosrc, /v_prefix := 'checks\/' \|\| v_req\.check_intake_item_id::text \|\| '\/mortgage-ops\/';/);

  const spec = RELEASE_SQL_SPECS[KEY];
  const forChecksops = ['checksops EXECUTE', 'owner EXECUTE'];
  assert.deepEqual(spec.functions, [
    { identity: WORKING, acl: ['owner EXECUTE'], result: 'public.mortgage_handling_requests' },
    { identity: POST, acl: forChecksops, result: 'public.check_messages' },
    { identity: ATTACH, acl: forChecksops, result: 'public.check_files' },
    { identity: SHIPPING, acl: forChecksops, result: 'public.mortgage_handling_requests' },
    { identity: TIMELINE, acl: forChecksops },
    { identity: EMAIL, acl: forChecksops },
  ]);
  // The row-type results are the file's RETURNS, qualified as pg_get_function_result prints them.
  for (const fn of spec.functions.filter((f) => f.result)) {
    const name = fn.identity.replace(/^public\.|\(.*$/g, '');
    assert.equal(fn.result, `public.${defs[name].result}`, name);
  }
  assert.equal(defs.aws_mortgage_desk_completion_timeline.result, 'uuid');
  assert.equal(defs.aws_mortgage_desk_return_email_claim.result, 'jsonb');
  // The file's ACL statements: PUBLIC revoked from all six, checksops granted on five only.
  const code = TEXT.replace(/--[^\n]*/g, '');
  for (const identity of FNS) {
    const sig = identity.replace(/^public\./, '').replace(/[()[\]]/g, (c) => `\\${c}`);
    assert.match(code, new RegExp(`REVOKE ALL ON FUNCTION public\\.${sig} FROM PUBLIC;`), identity);
  }
  const grants = [...code.matchAll(/\bGRANT\s+EXECUTE ON FUNCTION public\.([a-z_]+)\([^)]*\) TO checksops;/g)].map((m) => m[1]);
  assert.deepEqual(grants, ['aws_mortgage_desk_post_message', 'aws_mortgage_desk_attach_file', 'aws_mortgage_desk_update_shipping',
    'aws_mortgage_desk_completion_timeline', 'aws_mortgage_desk_return_email_claim']);
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, 5);
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /ALTER TABLE[^;]*ROW LEVEL SECURITY/i,
    /\bauthenticated\b/i, /\banon\b/i, /\bDELETE\s+FROM\b/i, /\bALTER\s+FUNCTION\b/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.deepEqual([...code.matchAll(/\bALTER TABLE\s+([a-z_.]+)/g)].map((m) => m[1]), ['public.mortgage_handling_requests']);
  assert.match(code, /ALTER TABLE public\.mortgage_handling_requests\s+ADD COLUMN IF NOT EXISTS return_emailed_at timestamptz;/);
  assert.deepEqual(spec.added_columns, [{
    table: 'public.mortgage_handling_requests', column: 'return_emailed_at', type: 'timestamp with time zone', notnull: false, default: null, acl: [],
  }]);
  assert.deepEqual(spec.definer_writes, WRITES);
  assert.deepEqual(spec.altered_relations, ['public.mortgage_handling_requests']);
  for (const prerequisite of ['public.aws_is_mortgage_ops_agent()', 'public.is_platform_owner()', 'auth.uid()', 'role checksops',
    ...WRITES, 'column public.mortgage_handling_requests.requested_by', 'column public.check_files.source',
    'column public.identity_accounts.email', 'column public.homeowner_ledger_events.payload_json']) {
    assert.ok(spec.prerequisites.includes(prerequisite), prerequisite);
  }
  // Every table and column the file's own prerequisite block names is a spec prerequisite.
  const prereqBlock = TEXT.slice(TEXT.indexOf('DO $sql122_prereq$'), TEXT.indexOf('$sql122_prereq$;'));
  const fileColumns = [...prereqBlock.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.ok(fileColumns.length > 50);
  assert.deepEqual(fileColumns.filter((c) => !spec.prerequisites.includes(c)), []);
  assert.equal(spec.prerequisites.filter((p) => p.startsWith('column ')).length, fileColumns.length);
  for (const absent of ['tables', 'policies', 'column_acl', 'indexes', 'unique_covers', 'dropped_functions', 'whole_tables', 'counts',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop']) {
    assert.equal(spec[absent], undefined, absent);
  }

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(text, /^release sql122 v1\n/);
  assert.match(text, /\nfunction public\.aws_mortgage_desk_working_request\(uuid, text\[\]\): lang=plpgsql vol=v parallel=u secdef=true result=public\.mortgage_handling_requests config=search_path=public prosrc=[0-9a-f]{64} acl=owner EXECUTE\n/);
  assert.match(text, /\nfunction public\.aws_mortgage_desk_post_message\(uuid, text\): lang=plpgsql vol=v parallel=u secdef=true result=public\.check_messages config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE\n/);
  assert.match(text, /\ncolumn public\.mortgage_handling_requests\.return_emailed_at: timestamp with time zone notnull=false default=- acl=$/);

  // Pre-conditions: ownership, definer writes, an existing column or function ACL the file would not fix.
  const want = releaseIntendedState(KEY, TEXT);
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    altered: { 'public.mortgage_handling_requests': { exists: true, owner_is_login: true } },
    definer: Object.fromEntries(WRITES.map((t) => [t, true])),
    functions: {},
    columns: { [COLUMN]: { exists: false } },
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ prerequisites_missing: ['public.aws_is_mortgage_ops_agent()'] }), ['prerequisites_present']);
  assert.deepEqual(pre({ definer: { ...base.definer, 'public.homeowner_ledger_events': false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ altered: { 'public.mortgage_handling_requests': { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ columns: { [COLUMN]: { ...want.columns[COLUMN] } } }), []);
  assert.deepEqual(pre({ columns: { [COLUMN]: { ...want.columns[COLUMN], type: 'text' } } }), ['added_columns_absent_or_intended']);
  assert.deepEqual(pre({ columns: { [COLUMN]: { ...want.columns[COLUMN], acl: ['authenticated SELECT'] } } }), ['added_columns_absent_or_intended']);
  const live = (identity, over = {}) => ({ ...want.functions[identity], owner_is_login: true, ...over });
  assert.deepEqual(pre({ functions: { [POST]: live(POST, { acl: ['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'] }) } }), []);
  assert.deepEqual(pre({ functions: { [POST]: live(POST, { acl: ['authenticated EXECUTE', 'owner EXECUTE'] }) } }), ['function_acl_replaceable']);
  assert.deepEqual(pre({ functions: { [WORKING]: live(WORKING, { acl: ['checksops EXECUTE', 'owner EXECUTE'] }) } }), ['function_acl_replaceable']);
  assert.deepEqual(pre({ functions: { [POST]: live(POST, { owner_is_login: false }) } }), ['functions_owned_by_login']);
  assert.deepEqual(pre({ functions: { [ATTACH]: live(ATTACH, { result: 'check_files' }) } }), ['function_results_match']);
  // Post-conditions: the intended fingerprint with every function owned by the login.
  const after = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: Object.fromEntries(FNS.map((identity) => [identity, { exists: true, owner_is_login: true }])),
    ...over,
  });
  const before = { altered: { 'public.mortgage_handling_requests': { exists: true, owner_is_login: true } } };
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, after({ altered: before.altered }), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, after({ altered: before.altered, live_definition_sha256: 'f'.repeat(64) }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 122 through the executor: refused without SQL 100\'s agent helper and with another return_emailed_at, a pending pin cannot apply, one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql122-exec-', 59530, { extra: [...sql98To100Schema(), DESK_SCHEMA] });
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
    const owner = async (sql) => {
      const client = await connectAs('checksops_admin');
      try {
        return await client.query(sql);
      } finally {
        await client.end();
      }
    };
    const fnCount = async () => (await fx.admin.query(
      "SELECT count(*)::int AS n FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'aws\\_mortgage\\_desk\\_%'",
    )).rows[0].n;

    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.prerequisites_missing, ['public.aws_is_mortgage_ops_agent()']);
    assert.ok(early.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query(AGENT_HELPER);

    // return_emailed_at already there with another type: refused, nothing applied.
    await owner('ALTER TABLE public.mortgage_handling_requests ADD COLUMN return_emailed_at text');
    const other = await inspect();
    assert.deepEqual(other.precondition_failures, ['added_columns_absent_or_intended'], JSON.stringify(other.release_sql_inspect));
    assert.equal((await apply(other.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await fnCount(), 0);
    await owner('ALTER TABLE public.mortgage_handling_requests DROP COLUMN return_emailed_at');

    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.equal(r.already_applied, false);
    assert.notEqual(r.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(r.release_sql_inspect.definer_writes, WRITES.map((table) => ({ name: table.replace(/^public\./, ''), ok: true })));
    // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.equal(await fnCount(), 0);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    const acl = (await fx.admin.query(`SELECT p.proname, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
        has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'aws\\_mortgage\\_desk\\_%'
        AND p.proname NOT IN ('aws_mortgage_desk_completion_messages', 'aws_mortgage_desk_appended_note') ORDER BY 1`)).rows;
    assert.deepEqual(acl.map((row) => [row.proname, row.owner, row.prosecdef, row.checksops, row.authenticated]), [
      ['aws_mortgage_desk_attach_file', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_completion_timeline', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_post_message', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_return_email_claim', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_update_shipping', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_working_request', 'checksops_admin', true, false, false],
    ]);
    const column = (await fx.admin.query(`SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, a.attacl
      FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.mortgage_handling_requests'::regclass AND a.attname = 'return_emailed_at'`)).rows;
    assert.deepEqual(column, [{ type: 'timestamp with time zone', attnotnull: false, attacl: null }]);
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
