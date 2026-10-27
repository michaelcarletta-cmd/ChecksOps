/**
 * SQL 120 (aws/workflows/sql/120_usage_events_at_approval_and_send.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-119 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 120 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 20), code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor;
 *   - the file and spec: five functions, EXECUTE for the owner only, two triggers, the covering
 *     unique index; no table, column, policy or grant to another role; the definer-write and
 *     duplicate pre-conditions refuse;
 *   - on PostgreSQL 16: refused while SQL 98's price functions are missing; a pending pin cannot
 *     apply; one apply through the executor reaches the intended fingerprint (and records the
 *     October backfill), then is refused as already in place.
 * The behavior (approval, sends, voids) is aws/tests/sql120-usage-events-pg.test.mjs.
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
  AUTHORIZED_SQL120_USAGE_EVENTS_AT_APPROVAL_AND_SEND,
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
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { CHECK_A, TENANT_A, pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';
import { PAYMENT_SCHEMA } from './helpers/sql109-payment-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-27T12:00:00.000Z';
const KEY = 'sql120';
const FNS = [
  'public.aws_check_processing_price_cents(uuid)',
  'public.aws_record_checkalt_billing_event()',
  'public.aws_send_speed_fee_type(text)',
  'public.aws_send_speed_fee_cents(uuid, text)',
  'public.aws_record_send_speed_fee()',
];
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
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql120-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// The columns SQL 120 reads and writes that the release fixture's tables lack (production's shapes),
// Check Alt deposits, and two October rows the backfill picks up. SQL 98's price functions are
// added only after the first inspect (the prerequisite refusal).
const SQL120_SCHEMA = `
ALTER TABLE public.tenants ADD COLUMN next_day_rate_cents integer, ADD COLUMN same_day_rate_cents integer;
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
INSERT INTO public.check_billing_config (price_per_check_cents) VALUES (300);
UPDATE public.tenants SET per_check_billing_enabled = true, per_check_rate_cents = 250 WHERE id = '${TENANT_A}';
INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status, submitted_at)
  VALUES ('${CHECK_A}', '${TENANT_A}', 'cleared', '2026-10-20T15:00:00Z');
INSERT INTO public.payment_transfers (tenant_id, environment, status, idempotency_key, amount_cents, leg_role, check_id, speed, provider_metadata, submitted_at)
  VALUES ('${TENANT_A}', 'production', 'completed', 'send:bf:0:wallet', 5000, 'send_wallet', '${CHECK_A}', 'same_day',
          '{"request_hash":"bf","recipient_index":0}', '2026-10-21T15:00:00Z');`;
const SQL98_PRICE_FUNCTIONS = `
CREATE FUNCTION public.aws_check_billing_default_price_cents() RETURNS integer LANGUAGE sql STABLE
  SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT c.price_per_check_cents FROM public.check_billing_config c WHERE c.active = true ORDER BY c.created_at DESC LIMIT 1 $$;
CREATE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path = public AS $$ SELECT true $$;`;

test('pin: SQL 120 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL120_USAGE_EVENTS_AT_APPROVAL_AND_SEND, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/120_usage_events_at_approval_and_send.sql');
  assert.equal(pin.migration_id, '120_usage_events_at_approval_and_send');
  assert.equal(spec.choice, 'sql120-usage-events-at-approval-and-send');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-27) from staging read-live run 40545376358: the five
  // functions and two triggers absent, so SQL 120 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-27: staging apply (wave 20) from staging read-live run 40545376358');
  assert.equal(pin.expected_live_definition_sha256, 'f3c1dd26888ac9fce91721cad698d39ee99cdca80c4a7888f9cfea9043171e9d');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent (a database without SQL 120) has a fingerprint of its own.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql120-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
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
  // Production pin execute-authorized (owner-approved bundle of 2026-10-27) on the staging apply from
  // the same pre-state: production's recorded pre-state is this pin's.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-27 /);
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, 'f3c1dd26888ac9fce91721cad698d39ee99cdca80c4a7888f9cfea9043171e9d');
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

test('reviewed file and spec: five owner-only functions, two triggers, the covering unique index; no table, column, policy or other grant; definer-write and duplicate pre-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs).sort(), FNS.map((fn) => fn.replace(/^public\.|\(.*$/g, '')).sort());
  for (const name of ['aws_record_checkalt_billing_event', 'aws_record_send_speed_fee']) {
    assert.equal(defs[name].security_definer, true, name);
    assert.equal(defs[name].result, 'trigger', name);
    assert.deepEqual(defs[name].config, ['row_security=off', 'search_path=public'], name);
    // They write only check_billing_events.
    assert.deepEqual([...new Set([...defs[name].prosrc.matchAll(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => m[1]))],
      ['public.check_billing_events'], name);
  }
  assert.equal(defs.aws_send_speed_fee_type.security_definer, false);
  // Check Alt: approved or accepted only; voids only after an approval, never an invoiced event.
  const checkalt = defs.aws_record_checkalt_billing_event.prosrc;
  assert.match(checkalt, /v_new IN \('submitted', 'cleared'\) AND v_old NOT IN \('submitted', 'cleared'\)/);
  assert.match(checkalt, /v_new IN \('rejected', 'error', 'duplicate'\) AND v_old IN \('submitted', 'cleared'\)/);
  assert.match(checkalt, /v_event\.status = 'recorded' AND v_event\.invoice_id IS NULL/);
  // Sends: send legs of a check, per recipient (request_hash, recipient_index); 75 / 100 defaults.
  const send = defs.aws_record_send_speed_fee.prosrc;
  assert.match(send, /NEW\.leg_role NOT IN \('send_wallet', 'send_bank'\)/);
  assert.match(send, /OR NEW\.check_id IS NULL/);
  assert.match(send, /provider_metadata->>'recipient_index' IS NOT DISTINCT FROM v_recipient/);
  assert.match(defs.aws_send_speed_fee_cents.prosrc, /CASE p_event_type WHEN 'moov_same_day' THEN 100 ELSE 75 END/);
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').replace(/'(?:[^']|'')*'/g, "''");
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|VIEW)\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /\bDELETE\b/i, /ROW LEVEL SECURITY/i, /\bGRANT\b/i, /\bDROP\s+(?!TRIGGER IF EXISTS)/i]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  // Data writes outside functions: the two backfill inserts, both from 2026-10-01.
  assert.equal([...outside.matchAll(/\bINSERT INTO public\.check_billing_events\b/g)].length, 2);
  assert.equal([...TEXT.matchAll(/>= timestamptz '2026-10-01 00:00:00\+00'/g)].length, 2);
  assert.match(TEXT, /Not changed: no policy, no grant to checksops, no table or column\./);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, FNS.map((identity) => ({ identity, acl: ['owner EXECUTE'] })));
  assert.deepEqual(spec.definer_writes, ['public.check_billing_events']);
  assert.deepEqual(spec.altered_relations, ['public.checkalt_deposits', 'public.payment_transfers', 'public.check_billing_events']);
  assert.deepEqual(spec.added_indexes, ['public.check_billing_events_transfer_event_uidx']);
  assert.equal(spec.table_privileges, undefined);
  assert.equal(spec.policies, undefined);
  assert.equal(spec.tables, undefined);
  assert.equal(spec.added_columns, undefined);
  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(text, /^release sql120 v1\n/);
  assert.match(text, /\ntrigger public\.checkalt_deposits aws_checkalt_deposit_billing_event: enabled=O def=[0-9a-f]{64}\n/);
  assert.match(text, /\ntrigger public\.payment_transfers aws_payment_transfer_send_speed_fee: enabled=O def=[0-9a-f]{64}\n/);
  assert.match(text, /\nunique public\.check_billing_events transfer_event \(payment_transfer_id,event_type\): covered=true$/);
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    definer: { 'public.check_billing_events': true },
    covers: { 'public.check_billing_events transfer_event': { covered: false } },
    counts: { check_billing_event_transfer_duplicates: 0 },
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.ok(!pre().includes('definer_can_write_relations'));
  assert.ok(!pre().includes('unique_covered_or_no_duplicates'));
  assert.ok(pre({ definer: { 'public.check_billing_events': false } }).includes('definer_can_write_relations'));
  assert.ok(pre({ counts: { check_billing_event_transfer_duplicates: 2 } }).includes('unique_covered_or_no_duplicates'));
  assert.ok(!pre({ counts: { check_billing_event_transfer_duplicates: 2 }, covers: { 'public.check_billing_events transfer_event': { covered: true } } })
    .includes('unique_covered_or_no_duplicates'));
});

test('PostgreSQL 16: SQL 120 through the executor: refused without SQL 98\'s price functions, a pending pin cannot apply, one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql120-exec-', 59410, { extra: [...sql98To100Schema(), PAYMENT_SCHEMA, SQL120_SCHEMA] });
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

    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.prerequisites_missing,
      ['public.aws_check_billing_default_price_cents()', 'public.aws_check_billing_charges_when_per_check_off()']);
    assert.ok(early.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    const owner = await connectAs('checksops_admin');
    try {
      await owner.query(SQL98_PRICE_FUNCTIONS);
    } finally {
      await owner.end();
    }

    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, releaseStateHash(KEY, {}));
    // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.equal((await fx.admin.query('SELECT count(*)::int AS n FROM public.check_billing_events')).rows[0].n, 0);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    // The October backfill: the approved deposit and the same-day send.
    const rows = (await fx.admin.query('SELECT event_type, unit_price_cents FROM public.check_billing_events ORDER BY event_type')).rows;
    assert.deepEqual(rows.map((row) => [row.event_type, row.unit_price_cents]), [['check_processing', 250], ['moov_same_day', 100]]);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
