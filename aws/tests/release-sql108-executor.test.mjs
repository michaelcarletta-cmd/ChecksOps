/**
 * SQL 108 (aws/workflows/sql/108_check_intake_items_funds_type_values.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-106 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 108 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 9), code-derived, selectable, packed,
 *     in step with the production pin; the pinned commit authored the bytes; no predecessor,
 *     no order;
 *   - the spec's one constraints entry (SQL 108 creates or replaces no function): the fingerprint
 *     is check_intake_items_funds_type_check's definition and validated flag; the nine values are
 *     exactly the SPA's FUNDS_TYPE_OPTIONS and the Check Classification select's;
 *   - the file: one guarded DO block that replaces that constraint and nothing else;
 *   - on PostgreSQL 16 (the Supabase five-value constraint): one apply through the executor reaches
 *     the intended fingerprint, the four refused values then save, an unknown one is still
 *     refused; a re-apply is refused.
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
  AUTHORIZED_SQL108_CHECK_INTAKE_ITEMS_FUNDS_TYPE_VALUES,
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
import { CHECK_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-21T12:00:00.000Z';
const KEY = 'sql108';
const TABLE = 'public.check_intake_items';
const CONSTRAINT = 'check_intake_items_funds_type_check';
// The engine's state key for a constraint (objKey in release-sql-state.mjs).
const CKEY = `${TABLE} ${CONSTRAINT}`;
const SUPABASE_FIVE = Object.freeze(['acv', 'rcv', 'recoverable_depreciation', 'supplement', 'overhead_and_profit']);
const ADDED = Object.freeze(['deductible', 'other_structures', 'personal_property', 'additional_living_expenses']);
const NINE = Object.freeze([...SUPABASE_FIVE, ...ADDED]);
const SUPABASE_FIVE_DEF = `CHECK (((funds_type IS NULL) OR (funds_type = ANY (ARRAY[${SUPABASE_FIVE.map((v) => `'${v}'::text`).join(', ')}]))))`;
const NINE_DEF = `CHECK (((funds_type IS NULL) OR (funds_type = ANY (ARRAY[${NINE.map((v) => `'${v}'::text`).join(', ')}]))))`;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = (key = KEY) => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[key].production_pin_rel), 'utf8'));

/** The Supabase column and constraint (20260506145529), run as the superuser before ownership. */
const SUPABASE_FUNDS_TYPE = `
ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS funds_type text;
ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT}
  CHECK (funds_type IS NULL OR funds_type IN (${SUPABASE_FIVE.map((v) => `'${v}'`).join(',')}));`;

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
    expiry: '2026-10-21T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql108-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 108 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor, no order', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL108_CHECK_INTAKE_ITEMS_FUNDS_TYPE_VALUES, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/108_check_intake_items_funds_type_values.sql');
  assert.equal(pin.migration_id, '108_check_intake_items_funds_type_values');
  assert.equal(spec.choice, 'sql108-check-intake-items-funds-type-values');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-21) from staging read-live run 39657370816:
  // the constraint was the Supabase five-value definition, validated, so SQL 108 was not yet applied.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-21: staging apply (wave 9) from staging read-live run 39657370816');
  assert.equal(pin.expected_live_definition_sha256, 'c83dcc9b97b84d294a743063adb0c1f5231f5c37ade2f00d65dc134a1d55cf00');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  // The recorded pre-state is the engine's fingerprint of exactly the Supabase five-value constraint.
  assert.equal(releaseStateHash(KEY, { constraints: { [CKEY]: { exists: true, def: SUPABASE_FIVE_DEF, validated: true } } }), pin.expected_live_definition_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, 'a796a3966009ceb9db4bcc43c4a75cc1a15753954e4f469abe77174eaccceaa5');
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql108-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 108, supersedes it or lists it as a predecessor.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration fingerprints or alters this constraint.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => key !== KEY
    && (RELEASE_SQL_SPECS[key].constraints || []).some((c) => c.name === CONSTRAINT)), []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
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

test('the nine values are exactly what the SPA offers, and the Supabase constraint allowed only five of them', () => {
  const status = fs.readFileSync(path.join(ROOT, 'src/features/check-command/status.ts'), 'utf8');
  const block = status.slice(status.indexOf('export const FUNDS_TYPE_OPTIONS'));
  const options = block.slice(0, block.indexOf('];'));
  assert.deepEqual([...options.matchAll(/value: "([^"]+)"/g)].map((m) => m[1]), [...NINE]);
  const review = fs.readFileSync(path.join(ROOT, 'src/components/check-review/CheckReviewConsole.tsx'), 'utf8');
  const select = review.slice(review.indexOf('Select funds type'));
  const items = select.slice(0, select.indexOf('</SelectContent>'));
  assert.deepEqual([...items.matchAll(/<SelectItem value="([^"]+)"/g)].map((m) => m[1]).filter((v) => v !== '__unset__'), [...NINE]);
  const supabase = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260506145529_61e262df-66f0-4b5d-b477-5f4fa7add9d6.sql'), 'utf8');
  assert.match(supabase, new RegExp(`funds_type IN \\(${SUPABASE_FIVE.map((v) => `'${v}'`).join(',')}\\)`));
});

test('reviewed file and spec: one guarded block replacing check_intake_items_funds_type_check; the fingerprint is its definition', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const code = TEXT.replace(/--[^\n]*/g, '');
  const statements = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, ['DO $body$']);
  // Exactly one DROP and one ADD, both of this constraint on this table.
  assert.deepEqual([...code.matchAll(/ALTER TABLE ([\w.]+)\s+(DROP|ADD) CONSTRAINT (\w+)/g)].map((m) => [m[1], m[2], m[3]]), [
    [TABLE, 'DROP', CONSTRAINT],
    [TABLE, 'ADD', CONSTRAINT],
  ]);
  const add = code.slice(code.indexOf('ADD CONSTRAINT'));
  assert.deepEqual([...add.slice(0, add.indexOf('));')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...NINE]);
  for (const forbidden of [/\bGRANT\b/i, /\bREVOKE\b/i, /\bUPDATE\s+public\./i, /\bINSERT\b/i, /\bDELETE\b/i, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bCREATE\b/i, /\bTRIGGER\b/i, /\bCASCADE\b/i, /\bNOT VALID\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i, /ADD COLUMN/i, /DROP COLUMN/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(TEXT, /NOT APPLIED\. Apply only through the guarded SQL path/);
  assert.match(TEXT, /sql108_unsupported_funds_type_check/);
  assert.match(TEXT, /sql108_invalid_rows/);
  assert.match(TEXT, /sql108_funds_type_check_already_current/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.constraints, [{ table: TABLE, name: CONSTRAINT, def: NINE_DEF }]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.deepEqual(spec.prerequisites, [TABLE]);
  assert.equal(spec.table_privileges, undefined);
  assert.equal(spec.render, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.constraints, { [CKEY]: { exists: true, def: NINE_DEF, validated: true } });
  assert.equal(releaseStateText(KEY, intended), ['release sql108 v1', `constraint ${TABLE} ${CONSTRAINT}: ${sha(NINE_DEF)} validated=true`].join('\n'));
  assert.equal(releaseStateText(KEY, {}), ['release sql108 v1', `constraint ${TABLE} ${CONSTRAINT}: absent`].join('\n'));
  const scope = releaseUnrelatedScope(KEY);
  // The unrelated-state snapshot skips only this constraint; every other object must not change.
  assert.deepEqual(scope.skip_constraints, [`${TABLE}.${CONSTRAINT}`]);
  for (const field of ['skip_relations', 'acl_relations', 'skip_columns', 'skip_not_null_columns', 'skip_policies', 'skip_functions', 'skip_triggers', 'skip_views', 'skip_indexes']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: the table must exist and be owned by the login. No predecessor.
  const owned = (owner_is_login) => ({ [TABLE]: { exists: true, owner_is_login } });
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: owned(true) };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ altered: owned(false) }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ prerequisites_missing: [TABLE] }), ['prerequisites_present']);
  // The intended constraint hashes to the pin; the Supabase five-value one is another state.
  const at = (def, validated = true) => ({ constraints: { [CKEY]: { exists: true, def, validated } } });
  assert.equal(releaseStateHash(KEY, at(NINE_DEF)), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, at(NINE_DEF, false)), PINS[KEY].intended_replacement_sha256);
  const fiveDef = `CHECK (((funds_type IS NULL) OR (funds_type = ANY (ARRAY[${SUPABASE_FIVE.map((v) => `'${v}'::text`).join(', ')}]))))`;
  assert.notEqual(releaseStateHash(KEY, at(fiveDef)), PINS[KEY].intended_replacement_sha256);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [SUPABASE_FUNDS_TYPE] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 108 through the executor from the Supabase constraint: drift refused, one apply reaches the intended definition, the four values save, a re-apply is refused', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql108-exec-', 60240, async ({ admin, connectAs }) => {
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
  const def = async () => (await admin.query(`SELECT pg_catalog.pg_get_constraintdef(oid) AS d, convalidated AS v FROM pg_catalog.pg_constraint
    WHERE conrelid = $1::regclass AND conname = $2`, [TABLE, CONSTRAINT])).rows[0];
  const setFundsType = async (value) => {
    try {
      await admin.query(`UPDATE ${TABLE} SET funds_type = $1 WHERE id = $2::uuid`, [value, CHECK_A]);
      return null;
    } catch (error) {
      return error;
    }
  };

  // Before: the four values the SPA offers are refused, as in production.
  for (const value of ADDED) {
    const error = await setFundsType(value);
    assert.equal(error?.code, '23514', value);
    assert.match(error.message, /violates check constraint "check_intake_items_funds_type_check"/);
  }
  assert.equal(await setFundsType('acv'), null);

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.equal(r.already_applied, false);
  assert.notEqual(r.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT ${CONSTRAINT}`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} CHECK (funds_type IS NULL OR funds_type IN (${SUPABASE_FIVE.map((v) => `'${v}'`).join(',')}))`);
  assert.equal((await inspect()).live_definition_sha256, r.live_definition_sha256);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  assert.deepEqual(await def(), { d: NINE_DEF, v: true });
  // The row kept its value; all nine values and NULL save; anything else is still refused.
  assert.equal((await admin.query(`SELECT funds_type FROM ${TABLE} WHERE id = $1::uuid`, [CHECK_A])).rows[0].funds_type, 'acv');
  for (const value of [...NINE, null]) assert.equal(await setFundsType(value), null, String(value));
  assert.equal((await setFundsType('ale'))?.code, '23514');
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
