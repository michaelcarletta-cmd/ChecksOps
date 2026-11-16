/**
 * SQL 169 (aws/workflows/sql/169_check_billing_events_keep_charge_on_check_delete.sql) in the staging guarded executor, on
 * the release engine shared with SQL 90-168 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-16, on
 * deleting a check that has a ChecksOps charge: "Delete, keep charge (Recommended)".
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 169 included); this file covers what is new:
 *
 *   - the pin: staging-authorized (wave 61) from staging read-live run 43919046029 (applied in staging by run 43923431127), code-derived,
 *     selectable, packed, in step with the production pin (applied 2026-11-16 from production's own pre-state, retired); the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing; nothing names it;
 *   - the spec's one constraints entry (SQL 169 creates or replaces no function): the fingerprint is
 *     check_billing_events_check_intake_item_id_fkey's definition and validated flag;
 *   - the file: one guarded DO block that replaces that key and nothing else;
 *   - on PostgreSQL 16 (the Supabase CASCADE key): the pre-state read back as derived; a pending pin and an unexpected
 *     pre-state cannot apply; one apply through the executor reaches the intended fingerprint, then is refused as
 *     already in place.
 * The behavior is aws/tests/sql169-check-billing-events-keep-charge-on-check-delete-pg.test.mjs.
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
  AUTHORIZED_SQL169_CHECK_BILLING_EVENTS_KEEP_CHARGE_ON_CHECK_DELETE,
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
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { CHECK_A, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-16T12:00:00.000Z';
const KEY = 'sql169';
const TABLE = 'public.check_billing_events';
const CONSTRAINT = 'check_billing_events_check_intake_item_id_fkey';
// The engine's state key for a constraint (objKey in release-sql-state.mjs).
const CKEY = `${TABLE} ${CONSTRAINT}`;
const CASCADE_DEF = 'FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE CASCADE';
const SET_NULL_DEF = 'FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE SET NULL';
const at = (def, validated = true) => ({ constraints: { [CKEY]: { exists: true, def, validated } } });
/** The pre-state both databases are expected to have: the Supabase CASCADE key, validated. */
const CASCADE_PRE = releaseStateHash(KEY, at(CASCADE_DEF));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The Supabase table (20260501204336, NOT NULL dropped in 20260605163443) with its inline CASCADE key, as the superuser. */
const SUPABASE_BILLING = `
CREATE TABLE ${TABLE} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  check_intake_item_id uuid REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  event_type text NOT NULL DEFAULT 'check_processing', unit_price_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'recorded', created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO ${TABLE} (tenant_id, check_intake_item_id, event_type, unit_price_cents)
  VALUES ('${TENANT_A}', '${CHECK_A}', 'mortgage_ops_initial', 1000);`;

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
    expiry: '2026-11-16T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql169-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 169 staging-authorized from its read-live, code-derived, selectable, packed, in step with the applied and retired production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL169_CHECK_BILLING_EVENTS_KEEP_CHARGE_ON_CHECK_DELETE, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/169_check_billing_events_keep_charge_on_check_delete.sql');
  assert.equal(pin.migration_id, '169_check_billing_events_keep_charge_on_check_delete');
  assert.equal(spec.choice, 'sql169-check-billing-events-keep-charge-on-check-delete');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  assertStagingPinState(assert, KEY, pin);
  // Staging apply authorized (owner approved 2026-11-16) from staging read-live run 43919046029: already_applied false,
  // precondition_failures []. It read the derived pre-state (the ON DELETE CASCADE key).
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-16: staging apply (wave 61) from staging read-live run 43919046029');
  assert.equal(pin.expected_live_definition_sha256, CASCADE_PRE);
  assert.equal(pin.expected_live_definition_sha256, 'f7530ea5e4b9ff3d8dc74911ffeadfe9b38dd6fd867ca3edacbc9ec65c8c4a40');
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-169-apply.md'), 'utf8'), /\*\*Status:\*\* applied in staging \(wave 61, 2026-11-16, apply run 43923431127\); staging acceptance: the staging apply under the owner's run approval \(\"apply SQL 169 in staging\"; no separate acceptance statement\); applied to production \(2026-11-16\); the production pin is retired \(`execute: false`\)\./);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-169-apply.md'), 'utf8'), /read-live \(2026-11-16\)\.\*\* Run 43919046029/);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(CASCADE_PRE, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the CASCADE and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-169-apply.md'), 'utf8');
  for (const value of [CASCADE_PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, at(CASCADE_DEF))}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql169-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 169, and no other release migration fingerprints its key.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const constraints = [...(other.constraints || []), ...(other.added_constraints || [])].map((c) => `${c.table} ${c.name}`);
    assert.ok(!constraints.includes(CKEY), `${key} ${CKEY}`);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, []);
  assert.deepEqual(prod.predecessors, []);
  // Production pin execute-authorized (owner-approved pin change of 2026-11-16) on the staging apply from the same pre-state.
  // Its pre-state is production's own (read-only inspect SSM 29ddf3f2): the ON DELETE CASCADE key, equal to the staging pin's.
  // Then applied 2026-11-16 ("apply SQL 169 in production KEEP_CHARGES_WHEN_CHECK_IS_DELETED") and retired.
  assert.equal(prod.execute, false);
  assert.match(prod.authorization, /^Applied to production on 2026-11-16; execute is false again/);
  assert.equal(prod.applied.result, 'applied');
  assert.equal(prod.authorization_phrase, 'KEEP_CHARGES_WHEN_CHECK_IS_DELETED');
  assert.equal(prod.expected_live_definition_sha256, prod.production_inspect.live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, CASCADE_PRE);
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.staging_acceptance.ok, true);
  assert.equal(prod.staging_acceptance.reference, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43923431127');
  assert.ok(prod.production_inspect.note.includes(CASCADE_PRE));
  assert.ok(prod.order_note.includes(CASCADE_PRE));
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

test('reviewed file and spec: one guarded block replacing check_billing_events_check_intake_item_id_fkey with the SET NULL key; the fingerprint is its definition', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const code = TEXT.replace(/--[^\n]*/g, '');
  const statements = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, ['DO $body$']);
  // Exactly one DROP and one ADD, both of this key on this table; the ADD is the SET NULL key.
  assert.deepEqual([...code.matchAll(/ALTER TABLE ([\w.]+)\s+(DROP|ADD) CONSTRAINT (\w+)/g)].map((m) => [m[1], m[2], m[3]]), [
    [TABLE, 'DROP', CONSTRAINT],
    [TABLE, 'ADD', CONSTRAINT],
  ]);
  assert.match(code, /ADD CONSTRAINT check_billing_events_check_intake_item_id_fkey\s+FOREIGN KEY \(check_intake_item_id\) REFERENCES public\.check_intake_items\(id\) ON DELETE SET NULL;/);
  // The key is compared on pg_constraint (pg_get_constraintdef's rendering depends on search_path): CASCADE ('c') is the
  // accepted predecessor, SET NULL ('n') the no-op target; everything else must be the Supabase key's.
  assert.doesNotMatch(code, /pg_get_constraintdef/);
  assert.match(code, /v_fk\.on_delete = 'n'/);
  assert.match(code, /v_fk\.on_delete IS DISTINCT FROM 'c'/);
  assert.match(code, /c\.confrelid = 'public\.check_intake_items'::regclass AS references_checks/);
  assert.match(code, /v_fk\.on_update = 'a' AND v_fk\.match_type = 's'\s+AND NOT v_fk\.deferrable AND v_fk\.validated AND v_fk\.set_cols IS NULL/);
  for (const forbidden of [/\bGRANT\b/i, /\bREVOKE\b/i, /\bUPDATE\s+public\./i, /\bINSERT\b/i, /\bDELETE\s+FROM\b/i, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bCREATE\b/i, /\bTRIGGER\b/i, /\bNOT VALID\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i, /ADD COLUMN/i, /DROP COLUMN/i, /ALTER COLUMN/i, /DROP NOT NULL/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(TEXT, /NOT APPLIED\. Apply only through the guarded SQL path/);
  for (const code55000 of ['sql169_prerequisite_missing', 'sql169_column_not_nullable', 'sql169_unexpected_foreign_key']) {
    assert.match(TEXT, new RegExp(`RAISE EXCEPTION '${code55000}`), code55000);
  }
  assert.match(TEXT, /sql169_foreign_key_already_current/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.constraints, [{ table: TABLE, name: CONSTRAINT, def: SET_NULL_DEF }]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.deepEqual(spec.prerequisites, [TABLE, 'public.check_intake_items', `column ${TABLE}.check_intake_item_id`, 'column public.check_intake_items.id']);
  for (const absent of ['table_privileges', 'render', 'altered_columns', 'added_columns', 'triggers', 'policies', 'definer_writes']) {
    assert.equal(spec[absent], undefined, absent);
  }
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.constraints, { [CKEY]: { exists: true, def: SET_NULL_DEF, validated: true } });
  assert.equal(releaseStateText(KEY, intended), ['release sql169 v1', `constraint ${TABLE} ${CONSTRAINT}: ${sha(SET_NULL_DEF)} validated=true`].join('\n'));
  assert.equal(releaseStateText(KEY, at(CASCADE_DEF)), ['release sql169 v1', `constraint ${TABLE} ${CONSTRAINT}: ${sha(CASCADE_DEF)} validated=true`].join('\n'));
  assert.equal(releaseStateText(KEY, {}), ['release sql169 v1', `constraint ${TABLE} ${CONSTRAINT}: absent`].join('\n'));
  const scope = releaseUnrelatedScope(KEY);
  // The unrelated-state snapshot skips only this key; every other object must not change.
  assert.deepEqual(scope.skip_constraints, [`${TABLE}.${CONSTRAINT}`]);
  for (const field of ['skip_relations', 'acl_relations', 'skip_columns', 'skip_not_null_columns', 'skip_policies', 'skip_functions', 'skip_triggers', 'skip_views', 'skip_indexes']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: the prerequisites and the table owned by the login. No predecessor.
  const owned = (owner_is_login) => ({ [TABLE]: { exists: true, owner_is_login } });
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: owned(true) };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ altered: owned(false) }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ prerequisites_missing: [TABLE] }), ['prerequisites_present']);
  // The SET NULL key hashes to the pin; the CASCADE key and an unvalidated SET NULL key are other states.
  assert.equal(releaseStateHash(KEY, at(SET_NULL_DEF)), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, at(SET_NULL_DEF, false)), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(CASCADE_PRE, PINS[KEY].intended_replacement_sha256);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [SUPABASE_BILLING] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 169 through the executor from the Supabase CASCADE key: the pre-state as derived, a pending pin and drift refused, one apply reaches the intended definition, a re-apply is refused', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql169-exec-', 60269, async ({ admin, connectAs }) => {
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
  // As the engine reads it: pg_get_constraintdef names the referenced table's schema only when search_path would not find it.
  await admin.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', false)");
  const def = async () => (await admin.query(`SELECT pg_catalog.pg_get_constraintdef(oid) AS d, convalidated AS v FROM pg_catalog.pg_constraint
    WHERE conrelid = $1::regclass AND conname = $2`, [TABLE, CONSTRAINT])).rows[0];

  assert.deepEqual(await def(), { d: CASCADE_DEF, v: true });
  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.equal(r.already_applied, false);
  // The live pre-state is the one the runbook and the pins name.
  assert.equal(r.live_definition_sha256, CASCADE_PRE);
  // The committed staging pin is authorized on exactly this pre-state (wave 61, read-live run 43919046029).
  assert.equal(r.pin_executable, true);
  // A pending pin cannot apply: a pending copy of the committed pin (the committed pin is staging-authorized, wave 61).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT ${CONSTRAINT}`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} ${CASCADE_DEF}`);
  assert.equal((await inspect()).live_definition_sha256, r.live_definition_sha256);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  assert.deepEqual(await def(), { d: SET_NULL_DEF, v: true });
  // Deleting the check keeps its charge, unlinked.
  await admin.query('DELETE FROM public.check_intake_items WHERE id = $1::uuid', [CHECK_A]);
  assert.deepEqual((await admin.query(`SELECT check_intake_item_id, event_type, unit_price_cents FROM ${TABLE}`)).rows,
    [{ check_intake_item_id: null, event_type: 'mortgage_ops_initial', unit_price_cents: 1000 }]);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
