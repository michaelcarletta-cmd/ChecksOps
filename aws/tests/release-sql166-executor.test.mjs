/**
 * SQL 166 (aws/workflows/sql/166_mortgage_desk_set_monitoring.sql) in the staging guarded executor, on the release engine
 * shared with SQL 90-165 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-14: "Mortgage agent needs
 * to be able to change the claim from monitor to not monitored, so the tenants see that type of update."
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 166 included); this file covers what is
 * new:
 *
 *   - the pin: staging-authorized (wave 58) from staging read-live run 43623201872 (applied in staging by run 43627727453), code-derived,
 *     selectable, packed, in step with the production pin (applied 2026-11-14 from production's own pre-state, retired); the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing; nothing names it;
 *   - the file and spec: one new SECURITY DEFINER function behind SQL 122's aws_mortgage_desk_working_request (in
 *     progress only), refused without a loss draft or on a closed one, three writes (the monitoring type, the audit row,
 *     one check message); the prerequisite block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; pre- and
 *     post-conditions;
 *   - on PostgreSQL 16 (the release fixture plus helpers/sql166-desk-monitoring-schema.mjs): the absent state read back
 *     as derived; refused while a column is missing or a relation is under FORCE ROW LEVEL SECURITY; a pending pin and
 *     an unexpected pre-state cannot apply; one apply through the executor reaches the intended fingerprint, then is
 *     refused as already in place.
 * The behavior is aws/tests/sql166-mortgage-desk-set-monitoring-pg.test.mjs.
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
  AUTHORIZED_SQL166_MORTGAGE_DESK_SET_MONITORING,
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
import { deskMonitoringSchema } from './helpers/sql166-desk-monitoring-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-14T12:00:00.000Z';
const KEY = 'sql166';
const IDENTITY = 'public.aws_mortgage_desk_set_monitoring(uuid, text)';
const IDENTITIES = Object.freeze([IDENTITY]);
const RELATIONS = Object.freeze(['public.check_messages', 'public.loss_draft_audit_log', 'public.loss_draft_tracking', 'public.mortgage_handling_requests']);
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The pre-state both databases have: the function absent (everything else present). */
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
    expiry: '2026-11-14T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql166-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 166 staging-authorized from its read-live, code-derived, selectable, packed, in step with the applied and retired production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL166_MORTGAGE_DESK_SET_MONITORING, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/166_mortgage_desk_set_monitoring.sql');
  assert.equal(pin.migration_id, '166_mortgage_desk_set_monitoring');
  assert.equal(spec.choice, 'sql166-mortgage-desk-set-monitoring');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  assertStagingPinState(assert, KEY, pin);
  // Staging apply authorized (owner approved 2026-11-14) from staging read-live run 43623201872: already_applied false,
  // precondition_failures []. It read the derived pre-state (the function absent).
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-14: staging apply (wave 58) from staging read-live run 43623201872');
  assert.equal(pin.expected_live_definition_sha256, ABSENT_PRE);
  assert.equal(pin.expected_live_definition_sha256, '11a10b33e6a5a46ea98934487cd9e941ddfe6b232ca6c7d4debad8c2f033f608');
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-166-apply.md'), 'utf8'), /\*\*Status:\*\* applied in staging \(wave 58, 2026-11-14, apply run 43627727453\); staging acceptance: the staging apply under the owner's run approval \("apply SQL 166 and SQL 167 in staging"; no separate acceptance statement\); applied to production \(2026-11-14\); the production pin is retired \(`execute: false`\)\./);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-166-apply.md'), 'utf8'), /read-live \(2026-11-14\)\.\*\* Run 43623201872/);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT_PRE, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-166-apply.md'), 'utf8');
  for (const value of [ABSENT_PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql166-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [...IDENTITIES]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 166, and no other release migration touches its function.
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
  // Production pin execute-authorized (owner-approved pin change of 2026-11-14) on the staging apply from the same pre-state.
  // Its pre-state is production's own (read-only inspect SSM 6b4e6de5): the function absent, equal to the staging pin's.
  // Then applied 2026-11-14 ("apply SQL 166 and SQL 167 in production") and retired.
  assert.equal(prod.execute, false);
  assert.match(prod.authorization, /^Applied to production on 2026-11-14; execute is false again/);
  assert.equal(prod.applied.result, 'applied');
  assert.equal(prod.authorization_phrase, 'LET_MORTGAGE_DESK_SWITCH_LOSS_DRAFT_MONITORING');
  assert.equal(prod.expected_live_definition_sha256, prod.production_inspect.live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, ABSENT_PRE);
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.staging_acceptance.ok, true);
  assert.equal(prod.staging_acceptance.reference, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43627727453');
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

test('reviewed file and spec: one new DEFINER function behind SQL 122\'s gate (in progress only): refused without a loss draft or on a closed one, the escrow flag, three writes; the prerequisite block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the spec; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['aws_mortgage_desk_set_monitoring']);
  const def = defs.aws_mortgage_desk_set_monitoring;
  assert.equal(def.language, 'plpgsql');
  assert.equal(def.volatility, 'v');
  assert.equal(def.parallel, 'u');
  assert.equal(def.security_definer, true);
  assert.equal(def.result, 'jsonb');
  assert.deepEqual(def.config, ['search_path=public, pg_temp']);
  const body = def.prosrc;
  // SQL 122's gate first, in progress only; the type next.
  assert.match(body, /BEGIN\s+v_req := public\.aws_mortgage_desk_working_request\(_request_id, ARRAY\['in_progress'\]\);\s+IF v_type NOT IN \('monitored', 'not_monitored'\) THEN\s+RAISE EXCEPTION 'invalid_monitoring_type' USING ERRCODE = '22023';/);
  // The loss draft of the request's check, locked; none refused; the closed statuses refused.
  assert.match(body, /FROM public\.loss_draft_tracking ld\s+WHERE ld\.check_intake_item_id = v_req\.check_intake_item_id\s+ORDER BY ld\.id\s+LIMIT 1\s+FOR UPDATE;\s+IF NOT FOUND THEN\s+RAISE EXCEPTION 'request_has_no_loss_draft' USING ERRCODE = '22023';/);
  assert.match(body, /IF v_ld\.escrow_status IN \('endorsing', 'final_release_complete'\) THEN\s+RAISE EXCEPTION 'loss_draft_closed' USING ERRCODE = '42501';/);
  // The escrow flag never refuses: no RAISE after it.
  const afterFlag = body.slice(body.indexOf('v_recorded :='));
  assert.doesNotMatch(afterFlag, /RAISE/);
  // Unchanged: returns before any write.
  const unchanged = body.indexOf('IF v_previous = v_type THEN');
  assert.ok(unchanged > 0 && unchanged < body.indexOf('UPDATE public.loss_draft_tracking'));
  // Exactly three writes: the type, the audit row, one message on the request's check from the caller.
  assert.deepEqual([...body.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(\S+)/g)].map((m) => `${m[1]} ${m[2]}`),
    ['UPDATE public.loss_draft_tracking', 'INSERT INTO public.loss_draft_audit_log', 'INSERT INTO public.check_messages']);
  assert.match(body, /SET monitoring_type = v_type,\s+updated_at = now\(\)\s+WHERE ld\.id = v_ld\.id/);
  assert.match(body, /VALUES \(v_ld\.id, 'set_monitoring_type', auth\.uid\(\), NULL, v_body, v_old, v_new\);/);
  assert.match(body, /INSERT INTO public\.check_messages \(check_id, sender_id, body, is_deleted, created_at\)\s+VALUES \(v_req\.check_intake_item_id, auth\.uid\(\), v_body, false, clock_timestamp\(\)\)/);
  for (const key of ['escrow_status', 'monitoring_type', 'total_escrowed', 'draw_amount_released', 'holdback_amount']) {
    assert.equal([...body.matchAll(new RegExp(`'${key}', (v_ld|ld)\\.${key}`, 'g'))].length, 2, key);
  }
  assert.doesNotMatch(body, /_request_id\s*,\s*_check|check_intake_item_id = _/, 'the check is the request\'s, never a parameter');

  const spec = RELEASE_SQL_SPECS[KEY];
  // A scalar result is not stated in the spec (as SQL 164 and SQL 165); the fingerprint reads it from the file (result=jsonb).
  assert.deepEqual(spec.functions, [{ identity: IDENTITY, acl: [...ACL], revokes: [...REVOKES] }]);
  assert.deepEqual(spec.prerequisites.slice(0, 7), ['public.mortgage_handling_requests', 'public.loss_draft_tracking', 'public.loss_draft_audit_log',
    'public.check_messages', 'public.aws_mortgage_desk_working_request(uuid, text[])', 'auth.uid()', 'role checksops']);
  // Every column the file's prerequisite block checks is a spec prerequisite, and nothing else.
  const fileColumns = [...TEXT.matchAll(/\('(mortgage_handling_requests|loss_draft_tracking|loss_draft_audit_log|check_messages)', '([a-z_]+)'\)/g)].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.deepEqual(spec.prerequisites.slice(7), fileColumns);
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'dropped_triggers', 'altered_columns']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite DO block, one CREATE OR REPLACE FUNCTION, its REVOKE from PUBLIC, the role REVOKE block, the GRANT.
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.equal([...code.matchAll(/\bDO\s+\$sql166_prereq\$/g)].length, 1);
  assert.equal([...code.matchAll(/\bDO\s+\$sql166_revoke\$/g)].length, 1);
  assert.match(code, /sql166_prerequisite_missing/);
  assert.match(code, /sql166_definer_cannot_reach/);
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 1);
  assert.equal([...code.matchAll(/^GRANT\b.*$/gm)].map((m) => m[0]).join('\n'), `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`);
  assert.equal([...code.matchAll(/^REVOKE\b.*$/gm)].map((m) => m[0]).join('\n'), `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`);
  for (const forbidden of [/\bDROP\b/, /\bALTER\b/, /\bCOMMENT\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/,
    /aws_mortgage_desk_working_request\(uuid, text\[\]\)\s+(FROM|TO)/]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [...IDENTITIES]);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql166 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=${sha(body)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);

  // Pre-conditions: the function absent passes; each relation unreachable or missing refuses;
  // an existing function owned by another role, with another grant or another result refuses; the revoked roles are revocable.
  const definer = Object.fromEntries(RELATIONS.map((table) => [table, true]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {}, definer };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const fn = (acl, over = {}) => ({ functions: { [IDENTITY]: { ...releaseIntendedState(KEY, TEXT).functions[IDENTITY], owner_is_login: true, acl: [...acl], ...over } } });
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ functions: { [IDENTITY]: { exists: false } } }), []);
  for (const table of RELATIONS) {
    assert.deepEqual(pre({ definer: { ...definer, [table]: false } }), ['definer_can_write_relations'], table);
    assert.ok(pre({ prerequisites_missing: [table] }).includes('prerequisites_present'), table);
  }
  assert.deepEqual(pre(fn(ACL)), []);
  assert.deepEqual(pre(fn([...REVOKES, ...ACL])), []);
  assert.deepEqual(pre(fn([...ACL, 'sql166_plain EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn(ACL, { owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fn(ACL, { result: 'SETOF record' })), ['function_results_match']);
  // Post-conditions: the intended fingerprint with the function owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [IDENTITY]: { exists: true, owner_is_login: true } },
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: ABSENT_PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 166 through the executor: the pre-state as derived; refused while a column is missing or a relation is under FORCE ROW LEVEL SECURITY; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql166-exec-', 60566, { extra: deskMonitoringSchema() });
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
    const present = async () => (await fx.admin.query('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [IDENTITY])).rows[0].present;
    const executeAcl = async (identity) => (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [identity])).rows[0];
    const allOk = RELATIONS.map((table) => ({ name: table.replace(/^public\./, ''), ok: true }));

    // The pre-state both databases have: the function absent, every prerequisite present, every relation reachable.
    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(pre.release_sql_inspect.predecessors, {});
    assert.deepEqual(pre.release_sql_inspect.definer_writes, allOk);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, ABSENT_PRE);
    // The committed staging pin is authorized on exactly this pre-state (wave 58, read-live run 43623201872).
    assert.equal(pre.pin_executable, true);
    assert.equal(await present(), false);

    // Each relation under FORCE ROW LEVEL SECURITY (the DEFINER owner could not reach it): refused, nothing applied.
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
    await fx.admin.query('ALTER TABLE public.loss_draft_tracking RENAME COLUMN draw_stage TO draw_stage_moved');
    const missing = await inspect();
    assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.loss_draft_tracking.draw_stage'), JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER TABLE public.loss_draft_tracking RENAME COLUMN draw_stage_moved TO draw_stage');
    assert.deepEqual((await inspect()).precondition_failures, []);
    assert.equal(await present(), false);

    // A pending pin cannot apply: a pending copy of the committed pin (the committed pin is staging-authorized, wave 58),
    // the pre-state kept recorded.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT_PRE });
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }));
    assert.equal(pending.ok, false);
    assert.equal(pending.code, CODES.GUARD_APPLY_FORBIDDEN);
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
    assert.deepEqual(after.release_sql_inspect.functions.map((fn) => fn.state), ['intended']);
    assert.deepEqual(after.release_sql_inspect.function_acl, [{ name: IDENTITY.replace(/^public\./, ''), acl: [...ACL] }]);
    assert.equal(await present(), true);
    assert.deepEqual(await executeAcl(IDENTITY), { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] });
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(ABSENT_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(after.live_definition_sha256)).ok, false);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
