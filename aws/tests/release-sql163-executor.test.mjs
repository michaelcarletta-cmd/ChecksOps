/**
 * SQL 163 (aws/workflows/sql/163_mortgage_desk_check_timeline_homeowner_link.sql) in the staging guarded executor, on the
 * release engine shared with SQL 90-162 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-12: the
 * Mortgage Desk agent sees the request's check and the homeowner timeline, and sends the homeowner link; 2026-11-13
 * "Start the desk fixes". release-sql90-97-executor.test.mjs runs what every release key shares (SQL 163 included);
 * this file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing; nothing names it;
 *   - the file and spec: three new SECURITY DEFINER functions behind SQL 124's aws_mortgage_desk_readable_request (the
 *     check's display fields only, the timeline note only, the link for the homeowner on file); the prerequisite block,
 *     the REVOKEs and GRANT EXECUTE TO checksops, nothing else; pre- and post-conditions;
 *   - on PostgreSQL 16 (the release fixture plus helpers/sql163-desk-schema.mjs): the absent state read back as derived;
 *     refused while a column is missing or a relation is under FORCE ROW LEVEL SECURITY; a pending pin and an
 *     unexpected pre-state cannot apply; one apply through the executor reaches the intended fingerprint, then is
 *     refused as already in place.
 * The behavior is aws/tests/sql163-mortgage-desk-check-timeline-homeowner-link-pg.test.mjs.
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
  AUTHORIZED_SQL163_MORTGAGE_DESK_CHECK_TIMELINE_HOMEOWNER_LINK,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  RELEASE_STAGING_SQL_KEYS,
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
import { deskSchema } from './helpers/sql163-desk-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-13T12:00:00.000Z';
const KEY = 'sql163';
const IDENTITIES = Object.freeze([
  'public.aws_mortgage_desk_request_check(uuid)',
  'public.aws_mortgage_desk_homeowner_timeline(uuid)',
  'public.aws_mortgage_desk_homeowner_link(uuid, text)',
]);
const RELATIONS = Object.freeze(['public.check_intake_items', 'public.claims', 'public.homeowner_ledger_events', 'public.homeowner_ledger_tokens', 'public.mortgage_handling_requests']);
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const RESULTS = Object.freeze({
  'public.aws_mortgage_desk_request_check(uuid)': 'TABLE(check_id uuid, claim_id uuid, amount numeric, check_number text, carrier_name text, payee_line text, payee_address text, property_address text, issue_date text, detected_claim_number text, front_image_path text, back_image_path text, status text, check_stage text, funds_type text)',
  'public.aws_mortgage_desk_homeowner_timeline(uuid)': 'TABLE(event_id uuid, event_type text, occurred_at timestamp with time zone, actor_label text, note text, amount numeric, from_desk boolean)',
  'public.aws_mortgage_desk_homeowner_link(uuid, text)': 'TABLE(token text, homeowner_email text, homeowner_name text, tenant_id uuid, reused boolean)',
});
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The pre-state both databases have: the three functions absent (everything else present). */
const ABSENT_PRE = releaseStateHash(KEY, {});

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
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql163-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 163 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL163_MORTGAGE_DESK_CHECK_TIMELINE_HOMEOWNER_LINK, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/163_mortgage_desk_check_timeline_homeowner_link.sql');
  assert.equal(pin.migration_id, '163_mortgage_desk_check_timeline_homeowner_link');
  assert.equal(spec.choice, 'sql163-mortgage-desk-check-timeline-homeowner-link');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  assertStagingPinState(assert, KEY, pin);
  // Staging apply authorized (owner approved 2026-11-13) from staging read-live run 43355976887: already_applied false,
  // precondition_failures []. It read the derived pre-state (the three functions absent).
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-13: staging apply (wave 54) from staging read-live run 43355976887');
  assert.equal(pin.expected_live_definition_sha256, ABSENT_PRE);
  assert.equal(pin.expected_live_definition_sha256, '23d41c1086f3f15412a5d374e056eaaf1bef7f428d81b0ffbdda666a5250de87');
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-163-apply.md'), 'utf8'), /\*\*Status:\*\* applied to staging \(wave 54\) and to production \(2026-11-13\); the production pin is retired/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-163-apply.md'), 'utf8'), /read-live \(2026-11-13\)\.\*\* Run 43355976887/);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT_PRE, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-163-apply.md'), 'utf8');
  for (const value of [ABSENT_PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql163-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [...IDENTITIES]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 163, and no other release migration touches its objects.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    for (const identity of IDENTITIES) assert.ok(!touched.includes(identity), `${key} ${identity}`);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [...IDENTITIES]);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.match(prod.authorization, /^Applied to production on 2026-11-13; execute is false again/);
  assert.equal(prod.applied.result, 'applied');
  assert.equal(prod.authorization_phrase, 'SHOW_MORTGAGE_DESK_AGENTS_CHECK_TIMELINE_AND_HOMEOWNER_LINK');
  assert.equal(prod.expected_live_definition_sha256, ABSENT_PRE);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.staging_acceptance.ok, true);
  assert.ok(prod.production_inspect.note.includes(ABSENT_PRE));
  assert.ok(prod.order_note.includes(ABSENT_PRE));
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

test('reviewed file and spec: three new DEFINER functions behind SQL 124\'s gate: the check\'s display fields, the timeline note, the link for the homeowner on file; the prerequisite block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the spec; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['aws_mortgage_desk_request_check', 'aws_mortgage_desk_homeowner_timeline', 'aws_mortgage_desk_homeowner_link']);
  for (const [name, volatility] of [['aws_mortgage_desk_request_check', 's'], ['aws_mortgage_desk_homeowner_timeline', 's'], ['aws_mortgage_desk_homeowner_link', 'v']]) {
    const def = defs[name];
    assert.equal(def.language, 'plpgsql', name);
    assert.equal(def.volatility, volatility, name);
    assert.equal(def.parallel, 'u', name);
    assert.equal(def.security_definer, true, name);
    assert.equal(def.result, 'table', name);
    assert.deepEqual(def.config, ['search_path=public, pg_temp'], name);
    // Every function starts with SQL 124's gate.
    assert.match(def.prosrc, /BEGIN\s+v_req := public\.aws_mortgage_desk_readable_request\(_request_id\);/, name);
  }
  const checkBody = defs.aws_mortgage_desk_request_check.prosrc;
  assert.match(checkBody, /FROM public\.check_intake_items ci\s+WHERE ci\.id = v_req\.check_intake_item_id\s+LIMIT 1;/);
  assert.doesNotMatch(checkBody, /routing_number|account_number|ocr|raw_|tenant_id/, 'the check\'s display fields only');
  assert.doesNotMatch(checkBody, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  const timelineBody = defs.aws_mortgage_desk_homeowner_timeline.prosrc;
  assert.match(timelineBody, /IF v_req\.claim_id IS NULL THEN\s+RETURN;/);
  assert.match(timelineBody, /FROM public\.homeowner_ledger_events e\s+WHERE e\.claim_id = v_req\.claim_id\s+AND e\.tenant_id = v_req\.tenant_id\s+ORDER BY e\.occurred_at DESC, e\.id DESC\s+LIMIT 200;/);
  assert.match(timelineBody, /\(e\.payload_json ->> 'note'\)::text/);
  assert.doesNotMatch(timelineBody, /e\.payload_json(?! (->>|\?) )/, 'never the whole payload');
  assert.doesNotMatch(timelineBody, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  const linkBody = defs.aws_mortgage_desk_homeowner_link.prosrc;
  assert.match(linkBody, /RAISE EXCEPTION 'request_has_no_claim' USING ERRCODE = '22023';/);
  assert.match(linkBody, /RAISE EXCEPTION 'claim_not_in_tenant' USING ERRCODE = '42501';/);
  assert.match(linkBody, /RAISE EXCEPTION 'no_homeowner_email' USING ERRCODE = '22023';/);
  assert.match(linkBody, /IF _new_token IS NULL OR _new_token !~ '\^\[0-9a-f\]\{48\}\$' THEN\s+RAISE EXCEPTION 'invalid_token' USING ERRCODE = '22023';/);
  // The address is the request's or the claim's, never a parameter; the only write is one token row.
  assert.match(linkBody, /COALESCE\(NULLIF\(btrim\(v_req\.homeowner_email\), ''\), c\.policyholder_email\)/);
  assert.deepEqual([...linkBody.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(\S+)/g)].map((m) => `${m[1]} ${m[2]}`), ['INSERT INTO public.homeowner_ledger_tokens']);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, IDENTITIES.map((identity) => ({ identity, result: RESULTS[identity], acl: [...ACL], revokes: [...REVOKES] })));
  assert.deepEqual(spec.prerequisites.slice(0, 8), ['public.mortgage_handling_requests', 'public.check_intake_items', 'public.claims',
    'public.homeowner_ledger_events', 'public.homeowner_ledger_tokens', 'public.aws_mortgage_desk_readable_request(uuid)', 'auth.uid()', 'role checksops']);
  // Every column the file's prerequisite block checks is a spec prerequisite, and nothing else.
  const fileColumns = [...TEXT.matchAll(/\('(mortgage_handling_requests|check_intake_items|claims|homeowner_ledger_events|homeowner_ledger_tokens)', '([a-z_]+)'\)/g)].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.deepEqual(spec.prerequisites.slice(8), fileColumns);
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'dropped_triggers']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite DO block, three CREATE OR REPLACE FUNCTIONs, their REVOKEs from PUBLIC, the role REVOKE block, the GRANTs.
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.equal([...code.matchAll(/\bDO\s+\$sql163_prereq\$/g)].length, 1);
  assert.equal([...code.matchAll(/\bDO\s+\$sql163_revoke\$/g)].length, 1);
  assert.match(code, /sql163_prerequisite_missing/);
  assert.match(code, /sql163_definer_cannot_reach/);
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 3);
  assert.equal([...code.matchAll(/^GRANT\b.*$/gm)].map((m) => m[0]).join('\n'), IDENTITIES.map((identity) => `GRANT EXECUTE ON FUNCTION ${identity} TO checksops;`).join('\n'));
  assert.equal([...code.matchAll(/^REVOKE\b.*$/gm)].map((m) => m[0]).join('\n'), IDENTITIES.map((identity) => `REVOKE ALL ON FUNCTION ${identity} FROM PUBLIC;`).join('\n'));
  for (const forbidden of [/\bDROP\b/, /\bALTER\b/, /\bCOMMENT\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/,
    /aws_mortgage_desk_readable_request\(uuid\)\s+(FROM|TO)/]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [...IDENTITIES]);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  const vol = { 'public.aws_mortgage_desk_request_check(uuid)': 's', 'public.aws_mortgage_desk_homeowner_timeline(uuid)': 's', 'public.aws_mortgage_desk_homeowner_link(uuid, text)': 'v' };
  const src = { 'public.aws_mortgage_desk_request_check(uuid)': defs.aws_mortgage_desk_request_check.prosrc,
    'public.aws_mortgage_desk_homeowner_timeline(uuid)': defs.aws_mortgage_desk_homeowner_timeline.prosrc,
    'public.aws_mortgage_desk_homeowner_link(uuid, text)': defs.aws_mortgage_desk_homeowner_link.prosrc };
  assert.deepEqual(text.split('\n'), [
    'release sql163 v1',
    ...IDENTITIES.map((identity) => `function ${identity}: lang=plpgsql vol=${vol[identity]} parallel=u secdef=true result=${RESULTS[identity]} config=search_path=public, pg_temp prosrc=${sha(src[identity])} acl=checksops EXECUTE;owner EXECUTE`),
  ]);

  // Pre-conditions: the functions absent pass; either relation unreachable or missing refuses;
  // an existing function owned by another role, with another grant or another result refuses; the revoked roles are revocable.
  const definer = Object.fromEntries(RELATIONS.map((table) => [table, true]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {}, definer };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const fn = (acl, over = {}) => ({ functions: Object.fromEntries(IDENTITIES.map((identity) => [identity, { ...releaseIntendedState(KEY, TEXT).functions[identity], owner_is_login: true, acl: [...acl], ...over }])) });
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ functions: Object.fromEntries(IDENTITIES.map((identity) => [identity, { exists: false }])) }), []);
  for (const table of RELATIONS) {
    assert.deepEqual(pre({ definer: { ...definer, [table]: false } }), ['definer_can_write_relations'], table);
    assert.ok(pre({ prerequisites_missing: [table] }).includes('prerequisites_present'), table);
  }
  assert.deepEqual(pre(fn(ACL)), []);
  assert.deepEqual(pre(fn([...REVOKES, ...ACL])), []);
  assert.deepEqual(pre(fn([...ACL, 'sql163_plain EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn(ACL, { owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fn(ACL, { result: 'SETOF record' })), ['function_results_match']);
  // Post-conditions: the intended fingerprint with the function owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: Object.fromEntries(IDENTITIES.map((identity) => [identity, { exists: true, owner_is_login: true }])),
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: ABSENT_PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 163 through the executor: the pre-state as derived; refused while a column is missing or a relation is under FORCE ROW LEVEL SECURITY; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql163-exec-', 60563, { extra: deskSchema() });
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
    const present = async () => (await fx.admin.query('SELECT bool_or(pg_catalog.to_regprocedure(f) IS NOT NULL) AS present FROM unnest($1::text[]) f', [IDENTITIES])).rows[0].present;
    const executeAcl = async (identity) => (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [identity])).rows[0];
    const allOk = RELATIONS.map((table) => ({ name: table.replace(/^public\./, ''), ok: true }));

    // The pre-state both databases have: the functions absent, every prerequisite present, every relation reachable.
    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(pre.release_sql_inspect.predecessors, {});
    assert.deepEqual(pre.release_sql_inspect.definer_writes, allOk);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, ABSENT_PRE);
    assert.equal(await present(), false);

    // Either relation under FORCE ROW LEVEL SECURITY (the DEFINER owner could not read it): refused, nothing applied.
    for (const table of RELATIONS) {
      await fx.admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      const forced = await inspect();
      assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], `${table}: ${JSON.stringify(forced.release_sql_inspect)}`);
      assert.deepEqual(forced.release_sql_inspect.definer_writes, allOk.map((row) => (row.name === table.replace(/^public\./, '') ? { ...row, ok: false } : row)), table);
      assert.equal((await apply(ABSENT_PRE)).code, CODES.DEPLOYMENT_COLLISION, table);
      assert.equal(await present(), false, table);
      await fx.admin.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    }
    assert.deepEqual((await inspect()).precondition_failures, []);

    // A column it reads missing: refused, nothing applied.
    await fx.admin.query('ALTER TABLE public.homeowner_ledger_tokens RENAME COLUMN revoked_at TO revoked_moved');
    const missing = await inspect();
    assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.homeowner_ledger_tokens.revoked_at'), JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER TABLE public.homeowner_ledger_tokens RENAME COLUMN revoked_moved TO revoked_at');
    assert.deepEqual((await inspect()).precondition_failures, []);
    assert.equal(await present(), false);

    // A pending pin cannot apply (pend a copy of the committed pin, the pre-state kept recorded).
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT_PRE });
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }));
    assert.equal(pending.ok, false);
    assert.equal(await present(), false);

    // An unexpected pre-state: a pin recording the intended state as the pre-state is not a valid authorization
    // package; a pin recording a hash the database does not show refuses on the live state. Nothing applied either way.
    const onIntended = await apply(PINS[KEY].intended_replacement_sha256);
    assert.equal(onIntended.ok, false, JSON.stringify(onIntended));
    assert.equal(onIntended.code, CODES.INVALID_MANIFEST);
    assert.equal(await present(), false);
    const unknown = await apply('f'.repeat(64));
    assert.equal(unknown.ok, false, JSON.stringify(unknown));
    assert.equal(unknown.code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await present(), false);
    assert.equal((await inspect()).live_definition_sha256, ABSENT_PRE);

    // One apply on the intended fingerprint: the function exists, owned by the login, EXECUTE for checksops and the owner.
    const applied = await apply(ABSENT_PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.functions.map((fn) => fn.state), ['intended', 'intended', 'intended']);
    assert.deepEqual(after.release_sql_inspect.function_acl, IDENTITIES.map((identity) => ({ name: identity.replace(/^public\./, ''), acl: [...ACL] })));
    assert.equal(await present(), true);
    for (const identity of IDENTITIES) {
      assert.deepEqual(await executeAcl(identity), { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] }, identity);
    }
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(ABSENT_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(after.live_definition_sha256)).ok, false);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
