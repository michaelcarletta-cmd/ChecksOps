/**
 * SQL 174 (aws/workflows/sql/174_checkalt_reset_stranded_attempt.sql) in the staging guarded executor, on the release
 * engine shared with SQL 90-173 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-24: "start step 3"
 * (clear the one Check Alt deposit attempt stranded before the provider sign-in). release-sql90-97-executor.test.mjs
 * runs what every release key shares (SQL 174 included); this file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing; nothing names it;
 *   - the file and spec: one owner-only SECURITY DEFINER function (search_path public, pg_temp; row_security off) with
 *     the stranded-attempt rule and the queued_before_http reset, called once for the minute 2026-11-24 19:58 UTC; the
 *     declared counts (the same rule, aggregate only) and the per-environment precondition
 *     checkalt_stranded_attempt_in_window (staging 0, production 1); the absent and intended states derived;
 *   - the reset row, as the API's own functions (checkalt-idempotency.mjs) read it, is claimable again;
 *   - on PostgreSQL 16 through the executor: the absent state read back as derived; a stranded attempt in the window
 *     makes staging refuse (staging must hold none); a pending pin and drift cannot apply; one apply on the zero-row
 *     path reaches the intended fingerprint and writes no row, then is refused as already in place; a drifted grant is
 *     not intended; a re-run of the bytes keeps the fingerprint.
 * The one-row reset and its near misses are aws/tests/sql174-checkalt-reset-stranded-attempt-pg.test.mjs.
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
  AUTHORIZED_SQL174_CHECKALT_RESET_STRANDED_ATTEMPT,
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
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseStateHash,
  releaseStateText,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import {
  pickBlockingDeposit,
  rowHasProviderHttpAttempt,
  shouldBlockNewProcessPost,
  shouldReconcileInsteadOfPost,
} from '../functions/api/providers/production/checkalt-idempotency.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-24T21:00:00.000Z';
const KEY = 'sql174';
const FN = 'public.aws_checkalt_reset_stranded_attempt(timestamp with time zone, timestamp with time zone)';
const FNS = [FN];
const ACL = ['owner EXECUTE'];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
/** The function absent: the pre-state both databases are expected to have. */
const ABSENT = releaseStateHash(KEY, {});
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

// public.checkalt_deposits with the columns SQL 65 and the Supabase migrations leave (RLS on, the API login may write
// it), as the restored database has it.
const CHECKALT_DEPOSITS = `
CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid REFERENCES public.check_intake_items(id),
  tenant_id uuid, checkalt_reference text, status text NOT NULL DEFAULT 'pending', amount numeric, amount_cents bigint,
  idempotency_key text, provider_http_attempted_at timestamptz, failure_class text, last_error text,
  last_status_payload jsonb, submitted_by uuid, submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.checkalt_deposits ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON TABLE public.checkalt_deposits TO checksops;`;
const EXTRA = [CHECKALT_DEPOSITS];

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
    expiry: '2026-11-24T22:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql174-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 174 pending, code-derived, selectable, packed, in step with the pending production pin; no predecessor; the derived pre-state', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL174_CHECKALT_RESET_STRANDED_ATTEMPT, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/174_checkalt_reset_stranded_attempt.sql');
  assert.equal(pin.migration_id, '174_checkalt_reset_stranded_attempt');
  assert.equal(spec.choice, 'sql174-checkalt-reset-stranded-attempt');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-174-apply.md'), 'utf8');
  for (const value of [ABSENT, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.match(runbook, /Staging\s+wave 66 when approved \(wave 65 is SQL 173's, also pending; wave 64, SQL 172, is the highest applied\)/);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  // The executor package carries the engine and the specs (the new precondition rides the routine package refresh).
  assert.equal(packed['scripts/deployment-guard/lib/release-sql-state.mjs'], 'lib/release-sql-state.mjs');
  assert.equal(packed['scripts/deployment-guard/lib/release-sql-specs.mjs'], 'lib/release-sql-specs.mjs');
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql174-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual(spec.functions.map((f) => f.identity), FNS);
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only', 'production_noop']) assert.equal(spec[absent], undefined, absent);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    assert.ok(!(RELEASE_SQL_SPECS[key].functions || []).some((f) => f.identity === FN), key);
    assert.ok(!(RELEASE_SQL_SPECS[key].extra_preconditions || []).includes('checkalt_stranded_attempt_in_window'), key);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [...pin.function_identities]);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.authorization_phrase, 'RESET_STRANDED_CHECKALT_ATTEMPT');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.equal(prod.staging_acceptance.ok, false);
  assert.ok(prod.production_inspect.note.includes(ABSENT));
  assert.ok(prod.order_note.includes(ABSENT));
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

test('reviewed file and spec: one owner-only SECURITY DEFINER function with the stranded-attempt rule and the queued reset, called once for one minute; the counts and the per-environment precondition', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['aws_checkalt_reset_stranded_attempt']);
  const fn = defs.aws_checkalt_reset_stranded_attempt;
  assert.equal(fn.security_definer, true);
  assert.equal(fn.language, 'plpgsql');
  assert.equal(fn.volatility, 'v');
  assert.equal(fn.result, 'integer');
  assert.deepEqual([...fn.config].sort(), ['row_security=off', 'search_path=public, pg_temp']);
  // The rule, in the count (locked) and again in the UPDATE.
  const rule = [
    /d\.checkalt_reference IS NULL/, /d\.status = 'submitting'/,
    /d\.provider_http_attempted_at >= p_window_start AND d\.provider_http_attempted_at < p_window_end/,
    /d\.created_at >= p_window_start AND d\.created_at < p_window_end/, /d\.failure_class IS NULL/, /d\.last_error IS NULL/,
    /d\.last_status_payload->>'phase' = 'submitting'/, /c\.deposited_at IS NULL/,
    /NOT EXISTS \(\s+SELECT 1 FROM public\.checkalt_deposits o\s+WHERE o\.check_intake_item_id = d\.check_intake_item_id AND o\.id <> d\.id\)/,
  ];
  const [count, update] = fn.prosrc.split(/\n  UPDATE public\.checkalt_deposits d\n/);
  assert.ok(update, 'one UPDATE');
  for (const re of rule) {
    assert.match(count, re, String(re));
    assert.match(update, re, String(re));
  }
  assert.match(count, /FOR UPDATE OF d\s+\) AS stranded;/);
  assert.match(count, /IF v_matches > 1 THEN\s+RAISE EXCEPTION 'sql174_ambiguous_stranded_attempts: % rows match; nothing changed', v_matches USING ERRCODE = '55000';/);
  assert.match(count, /IF v_matches = 0 THEN[\s\S]*RETURN 0;\s+END IF;/);
  assert.match(count, /OR p_window_end - p_window_start > interval '1 hour' THEN\s+RAISE EXCEPTION 'sql174_invalid_window/);
  // The reset: the state insertQueuedDeposit leaves, plus the audit object; nothing else set.
  assert.match(update, /^\s+SET status = 'queued',\n\s+provider_http_attempted_at = NULL,\n\s+last_status_payload = COALESCE\(d\.last_status_payload, '\{\}'::jsonb\)\n\s+\|\| '\{"phase": "queued_before_http", "provider_http_attempted": false\}'::jsonb\n\s+\|\| jsonb_build_object\('stranded_reset', jsonb_build_object\(\n\s+'reason', 'pre_provider_sign_in_504', 'migration', '174', 'at', now\(\)\)\),\n\s+updated_at = now\(\)\n\s+WHERE /);
  assert.match(update, /GET DIAGNOSTICS v_reset = ROW_COUNT;\s+IF v_reset <> 1 THEN\s+RAISE EXCEPTION 'sql174_ambiguous_stranded_attempts/);
  // insertQueuedDeposit writes the same phase and flag (checkalt-idempotency.mjs).
  const idem = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-idempotency.mjs'), 'utf8');
  assert.match(idem, /\$1::uuid, \$2::uuid, \$3, \$4, 'queued', \$5::uuid, \$6, \$7::jsonb/);
  assert.match(idem, /phase: 'queued_before_http',[\s\S]{0,120}provider_http_attempted: false,/);
  assert.match(idem, /WHERE id = \$1::uuid\s+AND provider_http_attempted_at IS NULL\s+AND checkalt_reference IS NULL\s+AND status IN \('queued', 'pending', 'submitting'\)/);
  // Writes only checkalt_deposits; reads check_intake_items.
  assert.deepEqual([...fn.prosrc.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.\w+)/gi)].map((m) => m[1]), ['public.checkalt_deposits']);
  // The one call, for the one minute.
  assert.match(TEXT, /v_reset := public\.aws_checkalt_reset_stranded_attempt\('2026-11-24 19:58:00\+00'::timestamptz, '2026-11-24 19:59:00\+00'::timestamptz\);/);
  // EXECUTE: PUBLIC and the app roles revoked; no GRANT anywhere.
  assert.match(TEXT, /REVOKE ALL ON FUNCTION public\.aws_checkalt_reset_stranded_attempt\(timestamptz, timestamptz\) FROM PUBLIC;/);
  assert.match(TEXT, /FOREACH v_grantee IN ARRAY ARRAY\['anon', 'authenticated', 'service_role', 'checksops'\] LOOP/);
  assert.doesNotMatch(TEXT.replace(/--[^\n]*/g, ''), /\bGRANT\b/);
  for (const code55000 of ['sql174_prerequisite_missing', 'sql174_definer_cannot_read', 'sql174_ambiguous_stranded_attempts']) {
    assert.match(TEXT, new RegExp(`RAISE EXCEPTION '${code55000}`), code55000);
  }
  assert.match(TEXT, /NOT APPLIED\. Apply only through the guarded SQL path/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: FN, acl: ACL }]);
  for (const name of spec.prerequisites) assert.ok(TEXT.includes(name.replace(/^column public\.(\w+)\.(\w+)$/, "('$1', '$2')")), name);
  assert.deepEqual(spec.definer_writes, ['public.checkalt_deposits', 'public.check_intake_items']);
  assert.deepEqual(spec.extra_preconditions, ['checkalt_stranded_attempt_in_window']);
  // The declared count is the function's rule for the file's minute (aggregate only).
  const stranded = spec.counts.checkalt_stranded_attempts_in_window.sql;
  for (const re of [/d\.checkalt_reference IS NULL AND d\.status = 'submitting'/, /d\.failure_class IS NULL AND d\.last_error IS NULL AND d\.last_status_payload->>'phase' = 'submitting'/,
    /c\.deposited_at IS NULL/, /NOT EXISTS \(SELECT 1 FROM public\.checkalt_deposits o WHERE o\.check_intake_item_id = d\.check_intake_item_id AND o\.id <> d\.id\)/,
    /d\.provider_http_attempted_at >= '2026-11-24 19:58:00\+00'::timestamptz AND d\.provider_http_attempted_at < '2026-11-24 19:59:00\+00'::timestamptz/]) {
    assert.match(stranded, re, String(re));
  }
  for (const kind of ['tables', 'policies', 'table_privileges', 'column_acl', 'acl_functions', 'dropped_functions', 'views', 'indexes', 'added_columns', 'constraints', 'triggers', 'altered_relations', 'render', 'dropped_policies']) {
    assert.equal(spec[kind], undefined, kind);
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, FNS);
  for (const field of ['skip_relations', 'skip_columns', 'skip_constraints', 'skip_not_null_columns', 'skip_policies', 'skip_triggers', 'skip_views', 'skip_indexes']) {
    assert.deepEqual(scope[field], [], field);
  }
  const intended = releaseIntendedState(KEY, TEXT);
  assert.equal(intended.functions[FN].result, 'integer');
  assert.deepEqual(intended.functions[FN].acl, ACL);
  const text = releaseStateText(KEY, intended);
  assert.equal(text.split('\n').length, 2);
  assert.match(text, /^release sql174 v1\nfunction public\.aws_checkalt_reset_stranded_attempt\(timestamp with time zone, timestamp with time zone\): lang=plpgsql vol=v parallel=u secdef=true result=integer config=row_security=off;search_path=public, pg_temp prosrc=[0-9a-f]{64} acl=owner EXECUTE$/);
  assert.equal(sha(text), PINS[KEY].intended_replacement_sha256);
  assert.equal(releaseStateText(KEY, {}), `release sql174 v1\nfunction ${FN}: absent`);
  // Pre-conditions: staging requires no stranded attempt in the window, production exactly one; an unreadable count
  // refuses in both.
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    definer: { 'public.checkalt_deposits': true, 'public.check_intake_items': true },
  };
  const pre = (over = {}, environment = 'staging') => releaseSharedPreconditionFailures(KEY, { ...base, counts: { checkalt_stranded_attempts_in_window: 0 }, ...over }, TEXT, { environment });
  const n = (value) => ({ counts: { checkalt_stranded_attempts_in_window: value } });
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre(n(1)), ['checkalt_stranded_attempt_in_window']);
  assert.deepEqual(pre(n(null)), ['checkalt_stranded_attempt_in_window']);
  assert.deepEqual(pre(n(1), 'production'), []);
  for (const value of [0, 2, null]) assert.deepEqual(pre(n(value), 'production'), ['checkalt_stranded_attempt_in_window'], String(value));
  assert.deepEqual(pre({ counts: undefined }), ['checkalt_stranded_attempt_in_window']);
  assert.deepEqual(pre({ prerequisites_missing: ['column public.checkalt_deposits.failure_class'] }), ['prerequisites_present']);
  assert.deepEqual(pre({ definer: { ...base.definer, 'public.checkalt_deposits': false } }), ['definer_can_write_relations']);
  const fnRow = (over) => ({ functions: { [FN]: { ...intended.functions[FN], owner_is_login: true, ...over } } });
  assert.deepEqual(pre(fnRow({})), []);
  assert.deepEqual(pre(fnRow({ owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fnRow({ acl: [...ACL, 'checksops EXECUTE'] })), ['function_acl_replaceable']);
  assert.deepEqual(pre(fnRow({ acl: [...ACL, 'PUBLIC EXECUTE'] })), []);
  assert.deepEqual(pre(fnRow({ result: 'boolean' })), ['function_results_match']);
});

test('the reset row is claimable again: the API\'s own checks (checkalt-idempotency.mjs) on the stranded row and on the row the file leaves', () => {
  const base = {
    id: 'd0000000-0000-4000-8000-000000000001', tenant_id: 't', check_intake_item_id: 'c', checkalt_reference: null,
    amount_cents: 100, idempotency_key: 'k'.repeat(64), failure_class: null, last_error: null,
  };
  // What insertQueuedDeposit then markHttpAttempted left (the stranded row).
  const stranded = {
    ...base, status: 'submitting', provider_http_attempted_at: '2026-11-24T19:58:53Z',
    last_status_payload: { phase: 'submitting', scale: 'integer_cents', amount_cents: 100, provider_http_attempted: true },
  };
  assert.equal(rowHasProviderHttpAttempt(stranded), true);
  assert.equal(shouldReconcileInsteadOfPost(stranded), true);
  assert.equal(pickBlockingDeposit([stranded]), stranded);
  // What SQL 174 leaves: the same payload merged with the reset keys (jsonb ||: right side wins).
  const reset = {
    ...base, status: 'queued', provider_http_attempted_at: null,
    last_status_payload: {
      ...stranded.last_status_payload, phase: 'queued_before_http', provider_http_attempted: false,
      stranded_reset: { reason: 'pre_provider_sign_in_504', migration: '174', at: '2026-11-25T00:00:00Z' },
    },
  };
  assert.equal(rowHasProviderHttpAttempt(reset), false);
  assert.equal(shouldReconcileInsteadOfPost(reset), false);
  assert.equal(shouldBlockNewProcessPost(reset), false);
  assert.equal(pickBlockingDeposit([reset]), null);
  // Resetting only the column would not be enough: the payload flag alone still blocks.
  const columnOnly = { ...stranded, status: 'queued', provider_http_attempted_at: null };
  assert.equal(rowHasProviderHttpAttempt(columnOnly), true);
  assert.equal(shouldReconcileInsteadOfPost(columnOnly), true);
});

test('PostgreSQL 16: SQL 174 through the executor: the absent state as derived, a stranded attempt in the window refuses on staging, a pending pin and drift cannot apply, one apply on the zero-row path writes no row, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql174-exec-', 61174, { extra: EXTRA });
  const { admin, connectAs } = fx;
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
    const asOwner = async (text) => {
      const owner = await connectAs('checksops_admin');
      try { await owner.query(text); } finally { await owner.end(); }
    };
    const rows = async () => (await admin.query(
      `SELECT id, status, provider_http_attempted_at, last_status_payload, updated_at FROM public.checkalt_deposits ORDER BY id`)).rows;

    // Staging-like data: deposits of other minutes and states, none stranded in the window.
    await admin.query(`
      INSERT INTO public.check_intake_items (id, tenant_id, deposited_at) VALUES
        ('c1740000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', NULL),
        ('c1740000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', NULL);
      INSERT INTO public.checkalt_deposits (id, check_intake_item_id, tenant_id, status, checkalt_reference, provider_http_attempted_at,
        last_status_payload, created_at, updated_at) VALUES
        ('d1740000-0000-4000-8000-000000000001', 'c1740000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
         'submitted', 'REF-1', '2026-11-20 10:00:00+00', '{"phase": "submitted"}', '2026-11-20 10:00:00+00', '2026-11-20 10:00:00+00'),
        ('d1740000-0000-4000-8000-000000000002', 'c1740000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
         'submitting', NULL, '2026-11-24 20:30:00+00', '{"phase": "submitting", "provider_http_attempted": true}',
         '2026-11-24 20:30:00+00', '2026-11-24 20:30:00+00');`);
    const before = await rows();

    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(r.release_sql_inspect.counts, { checkalt_stranded_attempts_in_window: 0, checkalt_reset_attempts_in_window: 0 });
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, ABSENT);
    assert.equal(r.apply_preconditions_met, false);
    // The committed staging pin is pending: it cannot apply, even on exactly this pre-state.
    assert.equal(r.pin_executable, false);
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    assert.equal((await admin.query(`SELECT to_regprocedure('${FN}') AS f`)).rows[0].f, null);
    // Drift between the recorded pre-state and the apply refuses.
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);
    // A stranded attempt in the window: staging must hold none, so the read reports it and the apply refuses.
    await admin.query(`
      INSERT INTO public.check_intake_items (id, tenant_id, deposited_at) VALUES
        ('c1740000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', NULL);
      INSERT INTO public.checkalt_deposits (id, check_intake_item_id, tenant_id, status, provider_http_attempted_at, last_status_payload, created_at)
      VALUES ('d1740000-0000-4000-8000-000000000003', 'c1740000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
        'submitting', '2026-11-24 19:58:53+00', '{"phase": "submitting", "provider_http_attempted": true}', '2026-11-24 19:58:52+00');`);
    try {
      const blocked = await inspect();
      assert.deepEqual(blocked.precondition_failures, ['checkalt_stranded_attempt_in_window']);
      assert.equal(blocked.release_sql_inspect.counts.checkalt_stranded_attempts_in_window, 1);
      const refused = await apply(ABSENT);
      assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(refused));
      assert.equal((await admin.query(`SELECT status FROM public.checkalt_deposits WHERE id = 'd1740000-0000-4000-8000-000000000003'`)).rows[0].status, 'submitting');
    } finally {
      await admin.query(`DELETE FROM public.checkalt_deposits WHERE id = 'd1740000-0000-4000-8000-000000000003';
        DELETE FROM public.check_intake_items WHERE id = 'c1740000-0000-4000-8000-000000000003';`);
    }
    // checkalt_deposits unreadable past RLS (another owner) refuses.
    await admin.query('CREATE ROLE other_owner_sql174 NOLOGIN');
    await admin.query('ALTER TABLE public.checkalt_deposits OWNER TO other_owner_sql174');
    try {
      const blocked = await inspect();
      assert.ok(blocked.precondition_failures.includes('definer_can_write_relations'), JSON.stringify(blocked.precondition_failures));
    } finally {
      await admin.query('ALTER TABLE public.checkalt_deposits OWNER TO checksops_admin');
    }

    const applied = await apply(ABSENT);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    // The zero-row path: no deposit row changed.
    assert.deepEqual(await rows(), before);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.release_sql_inspect.functions.map((row) => row.state), ['intended']);
    assert.deepEqual(after.release_sql_inspect.function_acl.map((row) => row.acl), [ACL]);
    assert.equal((await admin.query('SELECT pg_get_function_result($1::regprocedure) AS r', [FN])).rows[0].r, 'integer');
    for (const role of ['checksops', 'authenticated', 'anon', 'service_role']) {
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length > 0;
      if (exists) assert.equal((await admin.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS a`, [role, FN])).rows[0].a, false, role);
    }
    // The API login cannot run it.
    const api = await connectAs('checksops');
    try {
      await assert.rejects(api.query(`SELECT public.aws_checkalt_reset_stranded_attempt(now() - interval '1 minute', now())`), /permission denied/);
    } finally {
      await api.end();
    }
    // A second apply: refused, the database already past the pinned pre-state.
    assert.notEqual((await apply(ABSENT)).ok, true);
    // A drifted grant is not intended.
    await admin.query(`GRANT EXECUTE ON FUNCTION ${FN} TO checksops`);
    try {
      assert.equal((await inspect()).already_applied, false);
    } finally {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM checksops`);
    }
    // Re-running the reviewed bytes is a no-op on the fingerprint and on the rows.
    await asOwner(TEXT);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(await rows(), before);
  } finally {
    await fx.close();
  }
});
