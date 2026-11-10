/**
 * SQL 150 (aws/workflows/sql/150_external_disbursement_up_to_check_amount.sql) in the staging guarded executor, on the
 * release engine shared with SQL 90-148 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 150 included); this file covers what is
 * new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the production pin (pending too); the pinned
 *     commit authored the bytes; predecessor and supersedes SQL 147 (as SQL 138 for SQL 113), no
 *     superseded_intended_sha256 (as SQL 143 for SQL 142: SQL 147 has no object SQL 150 does not replace);
 *   - the file and spec: SQL 147's aws_record_external_disbursement(uuid, uuid, jsonb, text) only, with the same
 *     attributes, result and ACL, and SQL 147's body with the PA fee taken out of the amount available (nothing else);
 *     the prerequisite DO block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the spec's prerequisites
 *     (SQL 147's less the two PA fee columns) and the six definer relations; the expected pre-state (the function as
 *     SQL 147 left it) derived from SQL 147's bytes; the pre- and post-conditions;
 *   - on PostgreSQL 16 (the disbursement, check, transfer and stakeholder schema on the release fixture, as for SQL
 *     147): refused before SQL 147 (predecessors_applied); with SQL 147 applied as the owner the inspect reads the
 *     derived pre-state; refused while a relation is under FORCE ROW LEVEL SECURITY or a column it reads is missing; a
 *     pending pin cannot apply; drift and an unexpected pre-state refuse; one apply through the executor reaches the
 *     intended fingerprint (same oid, owner, attributes and EXECUTE ACL, SQL 150's body, no row written), then a
 *     second apply is refused (UNRELATED_MUTATION: already in place); SQL 147 still reads applied through SQL 150
 *     (supersedes), its own fingerprint the one derived from both files.
 * The behavior (up to the check amount, the PA fee not subtracted, everything else as SQL 147) is
 * aws/tests/sql150-external-disbursement-pg.test.mjs.
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
  AUTHORIZED_SQL150_EXTERNAL_DISBURSEMENT_UP_TO_CHECK_AMOUNT,
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
  releaseSupersededIntendedHash,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-10T12:00:00.000Z';
const KEY = 'sql150';
const FN = 'aws_record_external_disbursement';
const ARGS = 'uuid, uuid, jsonb, text';
const IDENTITY = `public.${FN}(${ARGS})`;
const IDENTITIES = Object.freeze([IDENTITY]);
const RELATIONS = Object.freeze(['public.disbursement_batches', 'public.disbursement_splits', 'public.check_intake_items',
  'public.payment_transfers', 'public.stakeholder_accounts', 'public.check_stakeholders']);
const TABLES = Object.freeze(RELATIONS.map((table) => table.replace(/^public\./, '')));
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL147 = fs.readFileSync(path.join(ROOT, PINS.sql147.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The pre-state both databases are expected to have (SQL 147 applied): the function as SQL 147 left it. */
const SQL147_FN = releaseIntendedState('sql147', SQL147).functions[IDENTITY];
const PRE = releaseStateHash(KEY, { functions: { [IDENTITY]: SQL147_FN } });
/** SQL 147's own fingerprint once SQL 150 replaced its function (derived from both files; not pinned). */
const SQL147_AFTER = releaseSupersededIntendedHash('sql147', SQL147, KEY, TEXT);

/** SQL 147's body with the PA fee taken out of the amount available: what SQL 150's body must be, exactly. */
const SQL147_BODY = releaseFunctionDefinitions(SQL147)[FN].prosrc;
const FEE_BLOCK = `  IF v_check.pa_fee_pct IS NOT NULL THEN
    v_fee := CASE WHEN v_check.pa_fee_pct > 0 THEN round(v_gross * v_check.pa_fee_pct / 100)::bigint ELSE 0 END;
  ELSE
    v_fee := round(COALESCE(v_check.pa_fee_amount, 0) * 100)::bigint;
  END IF;
`;
const expectedBody = () => {
  const edits = [
    ['  v_fee bigint;\n', ''],
    ['SELECT ci.id, ci.tenant_id, ci.amount, ci.pa_fee_pct, ci.pa_fee_amount INTO v_check', 'SELECT ci.id, ci.tenant_id, ci.amount INTO v_check'],
    ["  -- Available on this check, in cents (the Funds tab's rule, server side).\n",
      '  -- Available on this check, in cents: up to the check amount, less what was already paid out of it (SQL 150: the PA\n'
      + '  -- fee is not subtracted for a payment made outside ChecksOps).\n'],
    [FEE_BLOCK, ''],
    ['v_available := GREATEST(0, v_gross - v_fee - v_split_out - v_sent_out);', 'v_available := GREATEST(0, v_gross - v_split_out - v_sent_out);'],
  ];
  let body = SQL147_BODY;
  for (const [from, to] of edits) {
    assert.equal(body.split(from).length, 2, `exactly one ${JSON.stringify(from)} in SQL 147's body`);
    body = body.replace(from, to);
  }
  return body;
};

/**
 * The schema SQL 147 and SQL 150 read and write, on top of the release fixture (run as the superuser before everything
 * is handed to checksops_admin), as release-sql147-executor.test.mjs builds it: SQL 147 must apply first, so the check
 * keeps its PA fee columns (SQL 150 no longer reads them).
 */
const DISBURSEMENT_SCHEMA = `
ALTER TABLE public.check_intake_items ADD COLUMN amount numeric, ADD COLUMN pa_fee_pct numeric, ADD COLUMN pa_fee_amount numeric;
ALTER TABLE public.stakeholder_accounts ADD COLUMN nickname text;
CREATE TABLE public.disbursement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid,
  created_by uuid NOT NULL, check_amount numeric NOT NULL, available_amount numeric NOT NULL,
  reserve_held numeric NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'pending', notes text, completed_at timestamptz,
  approved_at timestamptz, approved_by uuid, approved_amount_cents bigint, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.disbursement_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL REFERENCES public.disbursement_batches(id),
  tenant_id uuid NOT NULL, stakeholder_account_id uuid, amount numeric NOT NULL, status text NOT NULL DEFAULT 'pending',
  method text NOT NULL DEFAULT 'actum', external_check_number text, recipient_name text, recipient_type text,
  external_notes text, idempotence_key text, settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_id uuid, leg_role text,
  status text NOT NULL, amount_cents bigint NOT NULL);
ALTER TABLE public.disbursement_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disbursement_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transfers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.disbursement_batches, public.disbursement_splits, public.payment_transfers TO checksops, authenticated;`;

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
    expiry: '2026-11-10T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key = KEY) => releaseEvent({ key, action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql150-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 150 pending, code-derived, selectable, packed, in step with the pending production pin; predecessor and supersedes SQL 147; the derived pre-state', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL150_EXTERNAL_DISBURSEMENT_UP_TO_CHECK_AMOUNT, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/150_external_disbursement_up_to_check_amount.sql');
  assert.equal(pin.migration_id, '150_external_disbursement_up_to_check_amount');
  assert.equal(spec.choice, 'sql150-external-disbursement-up-to-check-amount');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // The expected pre-state: SQL 147's function, derived from SQL 147's bytes (read back on PostgreSQL 16 below). It is
  // neither the intended state, nor "the function absent", nor SQL 147's own intended fingerprint (another key's text).
  assert.notEqual(PRE, pin.intended_replacement_sha256);
  assert.notEqual(PRE, releaseStateHash(KEY, {}));
  assert.notEqual(PRE, PINS.sql147.intended_replacement_sha256);
  assert.equal(releaseIntendedHash('sql147', SQL147), PINS.sql147.intended_replacement_sha256);
  // SQL 147 after SQL 150: its one function as SQL 150 renders it. Not pinned (superseded_intended_sha256): SQL 150's
  // fingerprint already fixes it, since SQL 147 has no other object.
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.deepEqual(RELEASE_SQL_SPECS.sql147.functions.map((fn) => fn.identity), [...IDENTITIES]);
  for (const kind of ['tables', 'policies', 'views', 'indexes', 'triggers', 'added_columns', 'column_acl', 'acl_functions', 'dropped_functions', 'table_privileges']) {
    assert.equal(RELEASE_SQL_SPECS.sql147[kind], undefined, `SQL 147 has no ${kind}`);
  }
  assert.notEqual(SQL147_AFTER, PINS.sql147.intended_replacement_sha256);
  assert.equal(SQL147_AFTER, releaseStateHash('sql147', { functions: { [IDENTITY]: releaseIntendedState(KEY, TEXT).functions[IDENTITY] } }));
  // The runbook and the production pin name the expected pre-state (derived here), the intended fingerprint, the source,
  // both bodies and both state texts.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-150-apply.md'), 'utf8');
  for (const value of [PRE, pin.intended_replacement_sha256, pin.source_sha256, sha(releaseFunctionDefinitions(TEXT)[FN].prosrc), sha(SQL147_BODY)]) {
    assert.ok(runbook.includes(value), value);
  }
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, { functions: { [IDENTITY]: SQL147_FN } })}\n\`\`\``));
  assert.match(runbook, /\*\*Status:\*\* not applied anywhere/);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql150-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [...IDENTITIES]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual([...pin.function_identities], [...PINS.sql147.function_identities]);
  assert.deepEqual(spec.predecessors, ['sql147']);
  assert.deepEqual(spec.supersedes, ['sql147']);
  for (const absent of ['runs_before', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  // Only SQL 150 supersedes SQL 147; nothing supersedes, refuses after or depends on SQL 150.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes('sql147')), [KEY]);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration but SQL 147 creates, replaces, drops or re-grants the function.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY && k !== 'sql147')) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.ok(!touched.includes(IDENTITY), key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [...IDENTITIES]);
  assert.deepEqual(prod.predecessors, ['sql147']);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.ok(prod.production_inspect.note.includes(PRE));
  assert.ok(prod.order_note.includes(PRE));
  assert.ok(prod.intended_post_state.note.includes(pin.intended_replacement_sha256));
  // SQL 147's pins are as applied and retired; this change does not touch them.
  assert.equal(PINS.sql147.execute, true, 'the staging SQL 147 pin as committed');
  const sql147 = JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS.sql147.production_pin_rel), 'utf8'));
  assert.equal(sql147.execute, false);
  assert.equal(sql147.applied.result, 'applied');
  assert.equal(sql147.applied.receipt.after_hash, PINS.sql147.intended_replacement_sha256);
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

test('reviewed file and spec: SQL 147\'s function only, same attributes, result and ACL, SQL 147\'s body with the PA fee taken out of the amount available; the prerequisite block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the spec; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), [FN]);
  const def = defs[FN];
  // Same attributes, result and ACL as SQL 147; another body.
  const ours = releaseIntendedState(KEY, TEXT).functions[IDENTITY];
  const { prosrc_sha256: newBody, ...newAttrs } = ours;
  const { prosrc_sha256: oldBody, ...oldAttrs } = SQL147_FN;
  assert.deepEqual(newAttrs, oldAttrs);
  assert.notEqual(newBody, oldBody);
  assert.equal(def.language, 'plpgsql');
  assert.equal(def.volatility, 'v');
  assert.equal(def.parallel, 'u');
  assert.equal(def.security_definer, true);
  assert.equal(def.result, 'jsonb');
  assert.deepEqual(def.config, ['search_path=public, pg_temp']);
  assert.deepEqual(ours.acl, [...ACL]);
  // The body is SQL 147's with exactly these edits: no v_fee, the check read without its PA fee columns, the comment,
  // no fee block and no fee term in the amount available. Nothing else differs.
  assert.equal(def.prosrc, expectedBody());
  const strip = (text) => text.replace(/--[^\n]*/g, '');
  const body = strip(def.prosrc);
  assert.doesNotMatch(body, /pa_fee|v_fee/);
  assert.match(body, /v_available := GREATEST\(0, v_gross - v_split_out - v_sent_out\);/);
  assert.match(body, /IF v_total > v_available THEN\s+RAISE EXCEPTION 'external_disbursement_exceeds_available: available_cents=%', v_available\s+USING ERRCODE = 'P0001';/);
  assert.match(body, /BEGIN\s+IF v_uid IS NULL OR _tenant_id IS NULL OR NOT COALESCE\(public\.aws_can_write_tenant\(_tenant_id\), false\) THEN\s+RAISE EXCEPTION 'external_disbursement_forbidden'\s+USING ERRCODE = '42501';/);
  assert.equal([...body.matchAll(/FOR UPDATE/g)].length, 1);
  assert.deepEqual([...body.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.[a-z_]+)?/gi)].map((m) => m[0].trim()),
    ['INSERT INTO public.disbursement_batches', 'INSERT INTO public.disbursement_splits']);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, IDENTITIES.map((identity) => ({ identity, acl: [...ACL], revokes: [...REVOKES] })));
  assert.deepEqual(spec.functions, RELEASE_SQL_SPECS.sql147.functions);
  assert.deepEqual(spec.prerequisites.slice(0, 9), [...RELATIONS, 'public.aws_can_write_tenant(uuid)', 'auth.uid()', 'role checksops']);
  // The file's prerequisite block names the same objects, and every column it checks is a spec prerequisite, and nothing
  // else: SQL 147's list less the two PA fee columns.
  const fileObjects = [...TEXT.matchAll(/^\s+\('([^']+)', (?:pg_catalog\.to_reg|\(SELECT r\.oid)/gm)].map((m) => m[1]);
  assert.deepEqual(fileObjects, spec.prerequisites.slice(0, 9));
  const fileColumns = [...TEXT.matchAll(new RegExp(`\\('(${TABLES.join('|')})', '([a-z_]+)'\\)`, 'g'))].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.equal(fileColumns.length, 40);
  assert.deepEqual(spec.prerequisites.slice(9), fileColumns);
  assert.deepEqual(spec.prerequisites, RELEASE_SQL_SPECS.sql147.prerequisites.filter((name) => !/\.pa_fee_(pct|amount)$/.test(name)));
  assert.equal(RELEASE_SQL_SPECS.sql147.prerequisites.length - spec.prerequisites.length, 2);
  assert.ok(!spec.prerequisites.includes(IDENTITY), 'the file does not require the function (it installs it where SQL 147 never ran)');
  assert.deepEqual(spec.predecessors, ['sql147']);
  assert.deepEqual(spec.supersedes, ['sql147']);
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'dropped_triggers',
    'constraints', 'extra_preconditions']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite DO block, one CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC, the role REVOKE block, the GRANT;
  // outside the body, the file is SQL 147's with sql147 renamed sql150 and the PA fee columns dropped from the check.
  const code = strip(TEXT);
  assert.equal([...code.matchAll(/\bDO\s+\$sql150_prereq\$/g)].length, 1);
  assert.equal([...code.matchAll(/\bDO\s+\$sql150_revoke\$/g)].length, 1);
  assert.match(code, /sql150_prerequisite_missing/);
  assert.match(code, /sql150_definer_cannot_write/);
  assert.doesNotMatch(code, /sql147/);
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 1);
  assert.equal([...code.matchAll(/^GRANT\b.*$/gm)].map((m) => m[0]).join('\n'), `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`);
  assert.equal([...code.matchAll(/^REVOKE\b.*$/gm)].map((m) => m[0]).join('\n'), `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`);
  const outside = (text, key) => strip(text).replace(strip(releaseFunctionDefinitions(text)[FN].prosrc), '').replaceAll(key, 'sqlNNN')
    .split('\n').map((line) => line.trimEnd()).filter(Boolean).join('\n');
  assert.equal(outside(TEXT, 'sql150').replaceAll('SQL 150', 'SQL NNN'),
    outside(SQL147, 'sql147').replaceAll('SQL 147', 'SQL NNN')
      .replace("      ('check_intake_items', 'amount'), ('check_intake_items', 'pa_fee_pct'),\n      ('check_intake_items', 'pa_fee_amount'),", "      ('check_intake_items', 'amount'),"));
  const outsideBodies = code.replace(strip(def.prosrc), '');
  for (const forbidden of [/\bDROP\b/, /\bALTER\b/, /\bCOMMENT\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/, /\bPOLICY\b/]) {
    assert.doesNotMatch(outsideBodies, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [...IDENTITIES]);
  assert.deepEqual(scope.skip_views, []);

  assert.deepEqual(releaseStateText(KEY, releaseIntendedState(KEY, TEXT)).split('\n'), [
    'release sql150 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=${sha(def.prosrc)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);
  assert.deepEqual(releaseStateText(KEY, { functions: { [IDENTITY]: SQL147_FN } }).split('\n'), [
    'release sql150 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=${sha(SQL147_BODY)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);

  // Pre-conditions: SQL 147's function passes; SQL 147 not applied, a relation unreachable or missing refuses; the
  // function owned by another role, with another grant or another result refuses; the revoked roles are revocable.
  const definer = Object.fromEntries(RELATIONS.map((table) => [table, true]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, definer };
  const fn = (acl, over = {}) => ({ functions: { [IDENTITY]: { ...SQL147_FN, owner_is_login: true, acl: [...acl], ...over } } });
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...fn(ACL), ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ predecessors_applied: false }), ['predecessors_applied']);
  for (const table of RELATIONS) {
    assert.deepEqual(pre({ definer: { ...definer, [table]: false } }), ['definer_can_write_relations'], table);
    assert.ok(pre({ prerequisites_missing: [table] }).includes('prerequisites_present'), table);
  }
  assert.ok(pre({ prerequisites_missing: ['public.aws_can_write_tenant(uuid)'] }).includes('prerequisites_present'));
  assert.deepEqual(pre(fn([...REVOKES, ...ACL])), []);
  assert.deepEqual(pre(fn([...ACL, 'sql150_plain EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn(ACL, { owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fn(ACL, { result: 'SETOF record' })), ['function_results_match']);
  // Post-conditions: the intended fingerprint with the function owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [IDENTITY]: { exists: true, owner_is_login: true } },
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 150 through the executor: refused before SQL 147; the pre-state as derived; refused under FORCE ROW LEVEL SECURITY or with a column missing; a pending pin, drift and an unexpected pre-state cannot apply; one apply on the intended fingerprint, then refused; SQL 147 still applied through SQL 150', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql150-exec-', 61500, { extra: [DISBURSEMENT_SCHEMA] });
  const { admin, connectAs } = fx;
  try {
    const asOwner = async (sql) => {
      const owner = await connectAs('checksops_admin');
      try { await owner.query(sql); } finally { await owner.end(); }
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
    const proc = async () => (await admin.query(`SELECT p.oid::int AS oid, p.prosrc, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
        p.proconfig, p.provolatile,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure($1)`, [IDENTITY])).rows[0] ?? null;
    const body = async () => (await proc())?.prosrc ?? null;
    const rows = async () => (await admin.query('SELECT (SELECT count(*) FROM public.disbursement_batches)::int + (SELECT count(*) FROM public.disbursement_splits)::int AS n')).rows[0].n;
    const allOk = TABLES.map((name) => ({ name, ok: true }));
    const sql150Body = releaseFunctionDefinitions(TEXT)[FN].prosrc;

    // Before SQL 147: refused on the predecessor (the file itself would install the function; the engine does not let
    // it, since both databases are expected to carry SQL 147). Nothing applied.
    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.predecessors, { sql147: false });
    assert.deepEqual(early.precondition_failures, ['predecessors_applied'], JSON.stringify(early.release_sql_inspect));
    assert.equal(early.live_definition_sha256, releaseStateHash(KEY, {}));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await body(), null);

    // SQL 147 as the owner: the pre-state both databases are expected to have.
    await asOwner(SQL147);
    assert.equal((await inspect('sql147')).already_applied, true);
    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(pre.release_sql_inspect.predecessors, { sql147: true });
    assert.deepEqual(pre.release_sql_inspect.definer_writes, allOk);
    assert.equal(pre.already_applied, false);
    assert.deepEqual(pre.release_sql_inspect.functions.map((row) => row.state), ['different']);
    assert.equal(pre.live_definition_sha256, PRE, 'the live pre-state equals the one derived from SQL 147\'s bytes');
    assert.equal(await body(), SQL147_BODY);
    const before = await proc();
    assert.deepEqual({ ...before, oid: undefined, prosrc: undefined }, {
      oid: undefined, prosrc: undefined, owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], provolatile: 'v', execute: ['checksops', 'checksops_admin'],
    });

    // Any relation under FORCE ROW LEVEL SECURITY (the DEFINER owner would be filtered): refused, nothing applied.
    for (const table of RELATIONS) {
      await admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      const forced = await inspect();
      assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], `${table}: ${JSON.stringify(forced.release_sql_inspect)}`);
      assert.deepEqual(forced.release_sql_inspect.definer_writes, allOk.map((row) => (row.name === table.replace(/^public\./, '') ? { ...row, ok: false } : row)), table);
      assert.equal((await apply(PRE)).code, CODES.DEPLOYMENT_COLLISION, table);
      assert.equal(await body(), SQL147_BODY, table);
      await admin.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    }
    assert.deepEqual((await inspect()).precondition_failures, []);

    // A column it reads missing: refused, nothing applied.
    await admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN leg_role TO leg_role_moved');
    const missing = await inspect();
    assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.payment_transfers.leg_role'), JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN leg_role_moved TO leg_role');
    assert.deepEqual((await inspect()).precondition_failures, []);
    assert.equal(await body(), SQL147_BODY);

    // A pending pin cannot apply (pend a copy of the committed pin, the pre-state recorded).
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: PRE });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    assert.equal(await body(), SQL147_BODY);
    // Drift between the recorded pre-state and the apply refuses (an extra EXECUTE grant); so does SQL 147's function
    // owned by another role (SQL 147 then no longer reads applied either). A pin recording the intended state or an
    // unknown hash as the pre-state is refused too.
    await admin.query(`GRANT EXECUTE ON FUNCTION ${IDENTITY} TO PUBLIC`);
    assert.equal((await apply(PRE)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${IDENTITY} FROM PUBLIC`);
    await admin.query(`ALTER FUNCTION ${IDENTITY} OWNER TO checksops`);
    try {
      const foreign = await inspect();
      assert.ok(foreign.precondition_failures.includes('functions_owned_by_login'), JSON.stringify(foreign.precondition_failures));
      assert.equal((await apply(PRE)).code, CODES.DEPLOYMENT_COLLISION);
    } finally {
      // Back to SQL 147's owner; the owner change dropped checksops's own EXECUTE entry (it was the owner's), so it is
      // granted again, as SQL 147 left it. The inspect below must read the derived pre-state again.
      await admin.query(`ALTER FUNCTION ${IDENTITY} OWNER TO checksops_admin`);
      await admin.query(`GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops`);
    }
    assert.equal((await apply(PINS[KEY].intended_replacement_sha256)).code, CODES.INVALID_MANIFEST);
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await body(), SQL147_BODY);
    assert.equal((await inspect()).live_definition_sha256, PRE);
    assert.deepEqual((await inspect()).precondition_failures, []);

    // One apply on the intended fingerprint: SQL 150's body; the same function (oid), owner, attributes and ACL.
    const applied = await apply(PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.functions.map((row) => row.state), ['intended']);
    assert.deepEqual(await proc(), { ...before, prosrc: sql150Body });
    assert.equal(await rows(), 0, 'no row written');
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);

    // SQL 147's own fingerprint has moved on (its function is SQL 150's now), to the one derived from both files, but
    // SQL 147 still counts as applied through SQL 150 (supersedes).
    const sql147 = await inspect('sql147');
    assert.equal(sql147.already_applied, false);
    assert.equal(sql147.live_definition_sha256, SQL147_AFTER);
    assert.deepEqual((await inspect()).release_sql_inspect.predecessors, { sql147: true });
  } finally {
    await fx.close();
  }
});
