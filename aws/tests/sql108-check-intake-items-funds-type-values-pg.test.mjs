/**
 * SQL 108 (aws/workflows/sql/108_check_intake_items_funds_type_values.sql) on PostgreSQL 16, through
 * its production tool, the owner the non-superuser checksops_admin login:
 *
 *   - production-like (the Supabase five-value constraint that refused the 2026-10-21 production
 *     saves, rows holding acv and NULL): the four values the SPA also offers are refused before;
 *     one apply reaches the intended fingerprint; then all nine values and NULL save, any other
 *     value is refused, the existing rows are unchanged; the file run again is a no-op and the tool
 *     refuses a re-apply;
 *   - the file refuses, and changes nothing, when the constraint is missing, has another
 *     definition, or a row (under a NOT VALID five-value predecessor) holds a value outside the
 *     nine; through the tool such an apply rolls back.
 *
 * Run: node --test aws/tests/sql108-check-intake-items-funds-type-values-pg.test.mjs (as root the PG
 * helpers run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { CHECK_A, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = 'public.check_intake_items';
const CONSTRAINT = 'check_intake_items_funds_type_check';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql108', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SUPABASE_FIVE = Object.freeze(['acv', 'rcv', 'recoverable_depreciation', 'supplement', 'overhead_and_profit']);
const ADDED = Object.freeze(['deductible', 'other_structures', 'personal_property', 'additional_living_expenses']);
const NINE = Object.freeze([...SUPABASE_FIVE, ...ADDED]);
const NINE_DEF = `CHECK (((funds_type IS NULL) OR (funds_type = ANY (ARRAY[${NINE.map((v) => `'${v}'::text`).join(', ')}]))))`;
const FIVE_CHECK = `CHECK (funds_type IS NULL OR funds_type IN (${SUPABASE_FIVE.map((v) => `'${v}'`).join(',')}))`;
const CHECK_B = '55555555-5555-4555-8555-55555555555b';
/** The Supabase column and constraint (20260506145529), and a second check row, as the superuser before ownership. */
const SUPABASE_FUNDS_TYPE = `
ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS funds_type text;
ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} ${FIVE_CHECK};
UPDATE ${TABLE} SET funds_type = 'acv' WHERE id = '${CHECK_A}';
INSERT INTO ${TABLE} (id, tenant_id) VALUES ('${CHECK_B}', '${TENANT_A}');`;

const authorized = (pin, live) => Object.freeze({
  ...pin,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${pin.migration}-pg-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: 'a'.repeat(40),
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `${pin.migration}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-21T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql108-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

const constraintDef = async (admin) => (await admin.query(`SELECT pg_catalog.pg_get_constraintdef(oid) AS def, convalidated AS validated
  FROM pg_catalog.pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [TABLE, CONSTRAINT])).rows[0] || null;
const rows = async (admin) => (await admin.query(`SELECT id::text, funds_type FROM ${TABLE} ORDER BY id`)).rows;
/** One funds_type UPDATE (what /data/write runs), always rolled back; returns the error or null. */
async function save(admin, value) {
  await admin.query('BEGIN');
  try {
    await admin.query(`UPDATE ${TABLE} SET funds_type = $1 WHERE id = $2::uuid`, [value, CHECK_B]);
    return null;
  } catch (error) {
    return error;
  } finally {
    await admin.query('ROLLBACK');
  }
}
/** The file as the owner; returns the error or null, and the notices. */
async function runFile(connectAs) {
  const owner = await connectAs('checksops_admin');
  const notices = [];
  owner.on('notice', (n) => notices.push(n.message));
  try {
    await owner.query(TEXT);
    return { error: null, notices };
  } catch (error) {
    return { error, notices };
  } finally {
    await owner.end();
  }
}

test('PostgreSQL 16: production-like, SQL 108 through its production tool: the four refused values save, others are still refused, rows unchanged, re-run a no-op', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql108-prod-', 60740, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await rows(admin);
  // As production refused them on 2026-10-21.
  for (const value of ADDED) {
    const error = await save(admin, value);
    assert.equal(error?.code, '23514', value);
    assert.match(error.message, /violates check constraint "check_intake_items_funds_type_check"/, value);
  }
  for (const value of [...SUPABASE_FIVE, null]) assert.equal(await save(admin, value), null, String(value));

  const s = (await inspectReleaseProduction('sql108', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  const pin = authorized(PIN, s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql108', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(await constraintDef(admin), { def: NINE_DEF, validated: true });
  assert.deepEqual(await rows(admin), before);

  for (const value of [...NINE, null]) assert.equal(await save(admin, value), null, String(value));
  for (const value of ['ale', 'depreciation', 'contents', 'Deductible', '']) {
    assert.equal((await save(admin, value))?.code, '23514', JSON.stringify(value));
  }

  // The file again is a no-op; the tool sees it in place and refuses a re-apply.
  const again = await runFile(connectAs);
  assert.equal(again.error, null);
  assert.ok(again.notices.some((n) => n.startsWith('sql108_funds_type_check_already_current')), JSON.stringify(again.notices));
  assert.deepEqual(await constraintDef(admin), { def: NINE_DEF, validated: true });
  const inspected = (await inspectReleaseProduction('sql108', { connect, pin, root: ROOT })).details;
  assert.equal(inspected.already_applied, true);
  assert.equal(inspected.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql108', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: the file refuses a missing constraint, another definition and rows outside the nine values, and changes nothing; through the tool the apply rolls back', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql108-refuse-', 60840, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const replaceWith = async (check) => {
    await admin.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
    if (check) await admin.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} ${check}`);
  };
  const refuses = async (pattern, label) => {
    const before = await constraintDef(admin);
    const result = await runFile(connectAs);
    assert.ok(result.error, `${label}: expected a refusal`);
    assert.equal(result.error.code, '55000', `${label}: ${result.error.message}`);
    assert.match(result.error.message, pattern, label);
    assert.deepEqual(await constraintDef(admin), before, label);
  };

  await replaceWith(null);
  await refuses(/^sql108_unsupported_funds_type_check: constraint check_intake_items_funds_type_check not found/, 'missing');
  // Another list (four of the five), a list without NULL, a pattern rule: not the reviewed predecessor.
  await replaceWith(`CHECK (funds_type IS NULL OR funds_type IN ('acv','rcv','supplement','overhead_and_profit'))`);
  await refuses(/^sql108_unsupported_funds_type_check md5=[0-9a-f]{32} n=4$/, 'four values');
  await replaceWith(`CHECK (funds_type IN (${SUPABASE_FIVE.map((v) => `'${v}'`).join(',')}))`);
  await refuses(/^sql108_unsupported_funds_type_check md5=[0-9a-f]{32}$/, 'no NULL arm');
  await replaceWith(`CHECK (funds_type IS NULL OR funds_type ~ '^[a-z_]+$')`);
  await refuses(/^sql108_unsupported_funds_type_check md5=[0-9a-f]{32}$/, 'pattern');
  // A NOT VALID five-value predecessor with a row outside the nine values.
  await replaceWith(null);
  await admin.query(`UPDATE ${TABLE} SET funds_type = 'ale' WHERE id = '${CHECK_B}'`);
  await admin.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} ${FIVE_CHECK} NOT VALID`);
  await refuses(/^sql108_invalid_rows: 1 existing rows would violate the new funds_type rule$/, 'invalid rows');

  // Through the tool: the inspect passes (the table is present and owned), the apply rolls back.
  const s = (await inspectReleaseProduction('sql108', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, []);
  assert.equal(s.already_applied, false);
  const pin = authorized(PIN, s.live_definition_sha256);
  const before = await constraintDef(admin);
  const refused = await executeReleaseProductionApply('sql108', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.deepEqual(await constraintDef(admin), before);
  assert.equal((await admin.query(`SELECT funds_type FROM ${TABLE} WHERE id = $1::uuid`, [CHECK_B])).rows[0].funds_type, 'ale');
}));
