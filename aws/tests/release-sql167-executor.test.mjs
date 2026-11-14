/**
 * SQL 167 (aws/workflows/sql/167_claim_ledger_relink_check.sql) in the staging guarded executor, on the release engine
 * shared with SQL 90-165 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-14: "Need to be able to
 * change/correct claim number once edited for ledger to link to existing claim."
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 167 included); this file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing; nothing names it;
 *   - the file and spec: one new SECURITY DEFINER function, public.claim_ledger_relink_check(uuid, uuid, text, text,
 *     uuid), with SQL 43's lock rule, SQL 44's same-tenant match copied exactly, the guarded move of the check, its loss
 *     draft and signature rows and one audit row; the prerequisite block, the REVOKEs and GRANT EXECUTE TO checksops,
 *     nothing else; pre- and post-conditions;
 *   - on PostgreSQL 16 (the release fixture plus the columns and tables SQL 167 reads and SQL 41's ocr_claim_number_key):
 *     the absent state read back as derived; refused while a column is missing or a relation is under FORCE ROW LEVEL
 *     SECURITY; a pending pin and an unexpected pre-state cannot apply; one apply through the executor reaches the
 *     intended fingerprint, then is refused as already in place.
 * The behavior is aws/tests/sql167-claim-ledger-relink-check-pg.test.mjs.
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
  AUTHORIZED_SQL167_CLAIM_LEDGER_RELINK_CHECK,
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
import { sliceFrom } from './helpers/sql145-collection-leg-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-14T12:00:00.000Z';
const KEY = 'sql167';
const IDENTITY = 'public.claim_ledger_relink_check(uuid, uuid, text, text, uuid)';
const RELATIONS = Object.freeze(['public.check_intake_items', 'public.claims', 'public.loss_draft_tracking', 'public.signature_requests',
  'public.check_audit_log', 'public.claim_settlements']);
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const SQL44 = fs.readFileSync(path.join(ROOT, 'aws/write-path/sql/44_claim_ledger_link_or_create.sql'), 'utf8');
const SQL43 = fs.readFileSync(path.join(ROOT, 'aws/write-path/sql/43_review_save_detected_claim_number.sql'), 'utf8');

/** The pre-state both databases have: the function absent (everything else present). */
const ABSENT_PRE = releaseStateHash(KEY, { functions: { [IDENTITY]: { exists: false } } });

/** What SQL 167 reads on top of the release fixture, in the production shape, and SQL 41's key function (as the superuser). */
const RELINK_SCHEMA = `
CREATE TYPE public.check_stage AS ENUM ('intake', 'review', 'deposited', 'voided', 'returned');
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS check_stage public.check_stage,
  ADD COLUMN IF NOT EXISTS deposited_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS claim_number text UNIQUE, ADD COLUMN IF NOT EXISTS policyholder_name text;
ALTER TABLE public.loss_draft_tracking ADD COLUMN IF NOT EXISTS check_intake_item_id uuid;
ALTER TABLE public.signature_requests ADD COLUMN IF NOT EXISTS check_intake_item_id uuid;
CREATE TABLE IF NOT EXISTS public.check_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, event_type text NOT NULL, event_description text,
  event_data jsonb DEFAULT '{}'::jsonb, actor_id uuid, created_at timestamptz DEFAULT clock_timestamp(), tenant_id uuid);
CREATE TABLE IF NOT EXISTS public.claim_settlements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL, total_settlement numeric);
${sliceFrom('aws/write-path/sql/41_ocr_detected_claim_number.sql', 'CREATE OR REPLACE FUNCTION public.ocr_claim_number_key(p_value text)', '$$;')}
`;

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
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql167-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 167 pending, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL167_CLAIM_LEDGER_RELINK_CHECK, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/167_claim_ledger_relink_check.sql');
  assert.equal(pin.migration_id, '167_claim_ledger_relink_check');
  assert.equal(spec.choice, 'sql167-claim-ledger-relink-check');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT_PRE, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-167-apply.md'), 'utf8');
  for (const value of [ABSENT_PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql167-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [IDENTITY]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 167, and no other release migration touches its objects.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.ok(!touched.includes(IDENTITY), `${key} ${IDENTITY}`);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [IDENTITY]);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.authorization_phrase, 'RELINK_CHECK_TO_CORRECTED_EXISTING_CLAIM');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.equal(prod.staging_acceptance.ok, false);
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

test('reviewed file and spec: one new DEFINER function with SQL 43\'s lock rule, SQL 44\'s same-tenant match, the guarded move and one audit row; the prerequisite block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the spec; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['claim_ledger_relink_check']);
  const def = defs.claim_ledger_relink_check;
  assert.equal(def.language, 'plpgsql');
  assert.equal(def.volatility, 'v');
  assert.equal(def.parallel, 'u');
  assert.equal(def.security_definer, true);
  assert.equal(def.result, 'jsonb');
  assert.deepEqual(def.config, ['row_security=off', 'search_path=public']);
  const body = def.prosrc.replace(/--[^\n]*/g, '');
  // SQL 44's same-tenant match, copied exactly: its three counts and its target SELECT are in this body byte for byte.
  const sql44Body = releaseFunctionDefinitions(SQL44).claim_ledger_link_or_create.prosrc;
  const sql44Block = (start, end) => {
    const from = sql44Body.indexOf(start);
    const to = sql44Body.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return sql44Body.slice(from, to + end.length);
  };
  for (const block of [
    sql44Block('  SELECT count(*)\n    INTO v_same_count', '    );\n'),
    sql44Block('  SELECT count(*)\n    INTO v_ambiguous_own', '    );\n'),
    sql44Block('  SELECT count(*)\n    INTO v_other_count', '    );\n'),
    sql44Block('  IF COALESCE(v_same_count, 0) = 1 THEN', '  END IF;\n'),
  ]) assert.ok(def.prosrc.includes(block), block.slice(0, 60));
  assert.match(body, /IF COALESCE\(v_same_count, 0\) > 1 OR COALESCE\(v_ambiguous_own, 0\) > 0 THEN\s+RETURN jsonb_build_object\('ok', false, 'persisted', false, 'code', 'ambiguous'\);/);
  assert.match(body, /IF COALESCE\(v_other_count, 0\) > 0 THEN\s+RETURN jsonb_build_object\('ok', false, 'persisted', false, 'code', 'cross_tenant'\);/);
  // SQL 43's lock rule, word for word, on the locked row and again on the UPDATE.
  assert.ok(SQL43.includes("IF v_deposited IS NOT NULL OR COALESCE(v_stage, '') IN ('deposited', 'voided', 'returned') THEN"));
  assert.ok(SQL43.includes("     AND deposited_at IS NULL\n     AND COALESCE(check_stage::text, '') NOT IN ('deposited', 'voided', 'returned')"));
  assert.match(body, /FROM public\.check_intake_items\s+WHERE id = p_check_id\s+FOR UPDATE;/);
  assert.match(body, /IF v_deposited IS NOT NULL OR COALESCE\(v_stage, ''\) IN \('deposited', 'voided', 'returned'\) THEN\s+RETURN jsonb_build_object\('ok', false, 'persisted', false, 'code', 'locked'\);/);
  // The move: this check only, guarded on the claim it read and on the lock rule; its loss draft and signature rows on
  // the old claim; one audit row. Never a claims, settlement or payout write; never a DELETE.
  assert.match(body, /UPDATE public\.check_intake_items\s+SET claim_id = v_same_id,\s+updated_at = now\(\)\s+WHERE id = p_check_id\s+AND tenant_id IS NOT DISTINCT FROM p_tenant_id\s+AND claim_id = v_old\s+AND deposited_at IS NULL\s+AND COALESCE\(check_stage::text, ''\) NOT IN \('deposited', 'voided', 'returned'\)/);
  assert.match(body, /UPDATE public\.loss_draft_tracking\s+SET claim_id = v_same_id\s+WHERE check_intake_item_id = p_check_id\s+AND claim_id = v_old;/);
  assert.match(body, /UPDATE public\.signature_requests\s+SET claim_id = v_same_id\s+WHERE check_intake_item_id = p_check_id\s+AND claim_id = v_old;/);
  assert.match(body, /INSERT INTO public\.check_audit_log \(check_id, tenant_id, actor_id, event_type, event_description, event_data\)/);
  assert.deepEqual([...body.matchAll(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+public\.([a-z_]+)/g)].map((m) => `${m[1]} ${m[2]}`),
    ['UPDATE check_intake_items', 'UPDATE loss_draft_tracking', 'UPDATE signature_requests', 'INSERT INTO check_audit_log']);
  assert.doesNotMatch(body, /\bDELETE\b|\bINSERT INTO public\.claims\b|payout|payment_transfers/);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: IDENTITY, acl: [...ACL], revokes: [...REVOKES] }]);
  assert.deepEqual(spec.prerequisites.slice(0, 8), [...RELATIONS, 'public.ocr_claim_number_key(text)', 'role checksops']);
  // Every column the file's prerequisite block checks is a spec prerequisite, and nothing else.
  const fileColumns = [...TEXT.matchAll(/\('(check_intake_items|claims|loss_draft_tracking|signature_requests|check_audit_log|claim_settlements)', '([a-z_]+)'\)/g)]
    .map((m) => `column public.${m[1]}.${m[2]}`);
  assert.deepEqual(spec.prerequisites.slice(8), fileColumns);
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_columns', 'altered_relations',
    'dropped_triggers', 'constraints']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite DO block, one CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC, the role REVOKE block, the GRANT.
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
  assert.equal([...code.matchAll(/\bDO\s+\$sql167_prereq\$/g)].length, 1);
  assert.equal([...code.matchAll(/\bDO\s+\$sql167_revoke\$/g)].length, 1);
  assert.match(code, /sql167_prerequisite_missing/);
  assert.match(code, /sql167_definer_cannot_reach/);
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 1);
  assert.equal([...code.matchAll(/^GRANT\b.*$/gm)].map((m) => m[0]).join('\n'), `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`);
  assert.equal([...code.matchAll(/^REVOKE\b.*$/gm)].map((m) => m[0]).join('\n'), `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`);
  for (const forbidden of [/\bDROP\b/, /\bALTER\b/, /\bCOMMENT\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/,
    /claim_ledger_link_or_create|review_save_detected_claim_number|ocr_persist_detected_claim_number/]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [IDENTITY]);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql167 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=row_security=off;search_path=public prosrc=${sha(def.prosrc)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);

  // Pre-conditions: the function absent passes; any relation unreachable or missing refuses;
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
  assert.deepEqual(pre(fn([...ACL, 'sql167_plain EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn(ACL, { owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fn(ACL, { result: 'json' })), ['function_results_match']);
  // Post-conditions: the intended fingerprint with the function owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [IDENTITY]: { exists: true, owner_is_login: true } },
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: ABSENT_PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 167 through the executor: the pre-state as derived; refused while a column is missing or a relation is under FORCE ROW LEVEL SECURITY; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql167-exec-', 62770, { extra: [RELINK_SCHEMA] });
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
    const executeAcl = async () => (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
    const allOk = RELATIONS.map((table) => ({ name: table.replace(/^public\./, ''), ok: true }));

    // The pre-state both databases have: the function absent, every prerequisite present, every relation reachable.
    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(pre.release_sql_inspect.predecessors, {});
    assert.deepEqual(pre.release_sql_inspect.definer_writes, allOk);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, ABSENT_PRE);
    assert.equal(await present(), false);

    // Any relation under FORCE ROW LEVEL SECURITY (the DEFINER owner could not reach it): refused, nothing applied.
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
    await fx.admin.query('ALTER TABLE public.check_audit_log RENAME COLUMN event_data TO event_data_moved');
    const missing = await inspect();
    assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.check_audit_log.event_data'), JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER TABLE public.check_audit_log RENAME COLUMN event_data_moved TO event_data');
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
    assert.deepEqual(after.release_sql_inspect.functions.map((fn) => fn.state), ['intended']);
    assert.deepEqual(after.release_sql_inspect.function_acl, [{ name: 'claim_ledger_relink_check(uuid, uuid, text, text, uuid)', acl: [...ACL] }]);
    assert.equal(await present(), true);
    assert.deepEqual(await executeAcl(), { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public', 'row_security=off'], execute: ['checksops', 'checksops_admin'] });
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(ABSENT_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(after.live_definition_sha256)).ok, false);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
