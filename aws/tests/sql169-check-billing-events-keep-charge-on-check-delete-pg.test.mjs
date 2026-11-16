/**
 * SQL 169 (aws/workflows/sql/169_check_billing_events_keep_charge_on_check_delete.sql) on PostgreSQL 16, through its
 * production tool, the owner the non-superuser checksops_admin login. Owner 2026-11-16, on deleting a check that has a
 * ChecksOps charge: "Delete, keep charge (Recommended)".
 *
 *   - production-like (the Supabase table: nullable check_intake_item_id, the inline CASCADE key, the unique indexes on
 *     the column, an updated_at trigger, a status-only trigger, RLS with a restrictive UPDATE gate for the API role):
 *     before, deleting a check deletes its charges; one apply reaches the intended fingerprint; then the API role's
 *     delete of a check keeps its charges with check_intake_item_id NULL and every other column unchanged (updated_at
 *     stamped by its trigger), the status-only trigger does not fire, the restrictive gate still refuses the API role's
 *     own UPDATE, another check's charge and deposit are untouched, every other constraint is unchanged; the file run
 *     again is a no-op and the tool refuses a re-apply;
 *   - the file refuses, and changes nothing, when the column is NOT NULL, the key is missing, has another name, is
 *     doubled, has another delete action, is deferrable or references another column, or the table is missing.
 *
 * Run: node --test aws/tests/sql169-check-billing-events-keep-charge-on-check-delete-pg.test.mjs (as root the PG helpers
 * run the server as the ubuntu account).
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
import { releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { CHECK_A, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql169';
const TABLE = 'public.check_billing_events';
const CONSTRAINT = 'check_billing_events_check_intake_item_id_fkey';
const CASCADE_DEF = 'FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE CASCADE';
const SET_NULL_DEF = 'FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE SET NULL';
const CASCADE_PRE = releaseStateHash(KEY, { constraints: { [`${TABLE} ${CONSTRAINT}`]: { exists: true, def: CASCADE_DEF, validated: true } } });
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const CHECK_B = '55555555-5555-4555-8555-55555555555b';
const CHARGE_A = 'c1690000-0000-4000-8000-00000000000a';
const CHARGE_A2 = 'c1690000-0000-4000-8000-0000000000a2';
const CHARGE_B = 'c1690000-0000-4000-8000-00000000000b';
const CLAIM = '66666666-6666-4666-8666-666666666666';
const DEPOSIT_B = 'd1690000-0000-4000-8000-00000000000b';

/**
 * The Supabase table (20260501204336; NOT NULL dropped in 20260605163443) with its inline CASCADE key, the unique
 * indexes that include the column (SQL 98, SQL 153), an updated_at trigger, a trigger on UPDATE OF status only (SQL
 * 154's shape; it raises, so a firing would fail the delete), RLS with SQL 136's restrictive UPDATE gate for the API
 * role, a second check with a charge and a deposit, and a DELETE path for the API role on check_intake_items. Run as the
 * superuser before ownership.
 */
const SUPABASE_BILLING = `
INSERT INTO public.check_intake_items (id, tenant_id) VALUES ('${CHECK_B}', '${TENANT_A}');
CREATE TABLE ${TABLE} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  check_intake_item_id uuid REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  claim_id uuid,
  payment_transfer_id uuid,
  event_type text NOT NULL DEFAULT 'check_processing',
  unit_price_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'recorded',
  billed_at timestamptz NOT NULL DEFAULT '2026-11-01T00:00:00Z',
  updated_at timestamptz NOT NULL DEFAULT '2026-11-01T00:00:00Z');
CREATE UNIQUE INDEX check_billing_events_check_event_uidx ON ${TABLE} (check_intake_item_id, event_type);
CREATE UNIQUE INDEX check_billing_events_one_second_mortgagee_per_check ON ${TABLE} (check_intake_item_id)
  WHERE event_type = 'mortgage_ops_second_mortgagee' AND status IS DISTINCT FROM 'voided' AND check_intake_item_id IS NOT NULL;
INSERT INTO ${TABLE} (id, tenant_id, check_intake_item_id, claim_id, event_type, unit_price_cents, status) VALUES
  ('${CHARGE_A}', '${TENANT_A}', '${CHECK_A}', '${CLAIM}', 'mortgage_ops_initial', 1000, 'invoiced'),
  ('${CHARGE_A2}', '${TENANT_A}', '${CHECK_A}', '${CLAIM}', 'mortgage_ops_second_mortgagee', 500, 'recorded'),
  ('${CHARGE_B}', '${TENANT_A}', '${CHECK_B}', '${CLAIM}', 'mortgage_ops_initial', 1000, 'recorded');
CREATE FUNCTION public.sql169_test_stamp_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := '2026-11-16T00:00:00Z'; RETURN NEW; END $$;
CREATE TRIGGER trg_check_billing_events_updated_at BEFORE UPDATE ON ${TABLE}
  FOR EACH ROW EXECUTE FUNCTION public.sql169_test_stamp_updated_at();
CREATE FUNCTION public.sql169_test_status_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'sql169 test: the status trigger fired'; END $$;
CREATE TRIGGER aws_check_billing_event_starter_package BEFORE INSERT OR UPDATE OF status ON ${TABLE}
  FOR EACH ROW EXECUTE FUNCTION public.sql169_test_status_only();
ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
CREATE POLICY sql169_test_member_all ON ${TABLE} FOR ALL TO checksops USING (true) WITH CHECK (true);
CREATE POLICY aws_money_write_gate_update_check_billing_events ON ${TABLE} AS RESTRICTIVE FOR UPDATE TO checksops USING (false);
GRANT SELECT, UPDATE ON ${TABLE} TO checksops;
INSERT INTO public.deposit_items (id, check_id) VALUES ('${DEPOSIT_B}', '${CHECK_B}');
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY sql169_test_api_delete ON public.check_intake_items FOR DELETE TO checksops USING (true);
CREATE POLICY sql169_test_api_select ON public.check_intake_items FOR SELECT TO checksops USING (true);
GRANT DELETE ON public.check_intake_items TO checksops;`;

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
    build_timestamp: '2026-11-16T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql169-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    // As the engine reads them: pg_get_constraintdef names the referenced schema only when search_path would not find it.
    await fx.admin.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', false)");
    await fn(fx);
  } finally {
    await fx.close();
  }
}

const keyDef = async (admin) => (await admin.query(`SELECT pg_catalog.pg_get_constraintdef(oid) AS def, convalidated AS validated
  FROM pg_catalog.pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [TABLE, CONSTRAINT])).rows[0] || null;
/** Every constraint in schema public, rendered: what an apply or a refusal must leave as it was. */
const constraints = async (admin) => (await admin.query(`SELECT con.conrelid::regclass::text || ' ' || con.conname || ' ' || pg_catalog.pg_get_constraintdef(con.oid) AS d
  FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace WHERE n.nspname = 'public' ORDER BY 1`)).rows.map((r) => r.d);
const charges = async (admin) => (await admin.query(`SELECT id::text, tenant_id::text, check_intake_item_id::text, claim_id::text,
  payment_transfer_id::text, event_type, unit_price_cents, currency, status, billed_at::text, updated_at::text FROM ${TABLE} ORDER BY id`)).rows;
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

test('PostgreSQL 16: production-like, SQL 169 through its production tool: deleting a check keeps its charges, unlinked, everything else unchanged; re-run a no-op', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql169-prod-', 60369, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  assert.deepEqual(await keyDef(admin), { def: CASCADE_DEF, validated: true });
  const before = await charges(admin);
  assert.equal(before.length, 3);

  // Before: deleting a check deletes its charges (the CASCADE key), so the API could not keep them.
  await admin.query('BEGIN');
  await admin.query('DELETE FROM public.check_intake_items WHERE id = $1::uuid', [CHECK_A]);
  assert.deepEqual((await charges(admin)).map((r) => r.id), [CHARGE_B]);
  await admin.query('ROLLBACK');
  assert.deepEqual(await charges(admin), before);

  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.live_definition_sha256, CASCADE_PRE);
  const otherConstraints = (await constraints(admin)).filter((d) => !d.includes(CONSTRAINT));
  const pin = authorized(PIN, s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, CASCADE_PRE);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(await keyDef(admin), { def: SET_NULL_DEF, validated: true });
  assert.deepEqual(await charges(admin), before, 'the apply writes no row');
  assert.deepEqual((await constraints(admin)).filter((d) => !d.includes(CONSTRAINT)), otherConstraints);

  // The API role cannot update a charge itself (SQL 136's restrictive gate) ...
  const api = await connectAs('checksops');
  try {
    const own = await api.query(`UPDATE ${TABLE} SET check_intake_item_id = NULL WHERE id = $1::uuid`, [CHARGE_A]);
    assert.equal(own.rowCount, 0);
    // ... but its delete of the check unlinks the check's charges through the key, as the table's owner.
    const del = await api.query('DELETE FROM public.check_intake_items WHERE id = $1::uuid', [CHECK_A]);
    assert.equal(del.rowCount, 1);
  } finally {
    await api.end();
  }
  const after = await charges(admin);
  const byId = Object.fromEntries(before.map((r) => [r.id, r]));
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id), 'no charge is deleted');
  for (const row of after) {
    if (row.id === CHARGE_B) {
      assert.deepEqual(row, byId[CHARGE_B], 'another check\'s charge is untouched');
      continue;
    }
    // Unlinked; every other column as it was (updated_at stamped by its own trigger); status unchanged, so the
    // status-only trigger did not fire.
    assert.equal(row.check_intake_item_id, null, row.id);
    assert.equal(row.updated_at, '2026-11-16 00:00:00+00', row.id);
    const { check_intake_item_id: _a, updated_at: _b, ...rest } = row;
    const { check_intake_item_id: _c, updated_at: _d, ...was } = byId[row.id];
    assert.deepEqual(rest, was, row.id);
  }
  assert.deepEqual((await admin.query('SELECT id::text, check_id::text FROM public.deposit_items WHERE id = $1::uuid', [DEPOSIT_B])).rows,
    [{ id: DEPOSIT_B, check_id: CHECK_B }]);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.check_intake_items WHERE id = $1::uuid', [CHECK_B])).rows[0].n, 1);
  // More unlinked charges of the same event types are allowed by the unique indexes (NULL is distinct; the 2nd-mortgagee
  // index is partial on IS NOT NULL). This fixture's status-only trigger refuses every INSERT, so it is off for this.
  await admin.query(`ALTER TABLE ${TABLE} DISABLE TRIGGER aws_check_billing_event_starter_package`);
  await admin.query(`INSERT INTO ${TABLE} (tenant_id, check_intake_item_id, event_type, unit_price_cents)
    VALUES ($1::uuid, NULL, 'mortgage_ops_initial', 1000), ($1::uuid, NULL, 'mortgage_ops_second_mortgagee', 500)`, [TENANT_A]);
  await admin.query(`ALTER TABLE ${TABLE} ENABLE TRIGGER aws_check_billing_event_starter_package`);

  // The file again is a no-op; the tool sees it in place and refuses a re-apply.
  const again = await runFile(connectAs);
  assert.equal(again.error, null);
  assert.ok(again.notices.includes('sql169_foreign_key_already_current'), JSON.stringify(again.notices));
  assert.deepEqual(await keyDef(admin), { def: SET_NULL_DEF, validated: true });
  const inspected = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(inspected.already_applied, true);
  assert.equal(inspected.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: the file refuses, and changes nothing, on a NOT NULL column, a missing, renamed, doubled, RESTRICT, deferrable or other-column key, or a missing table', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql169-refuse-', 60469, async ({ admin, connectAs }) => {
  const setKey = async (sql) => {
    await admin.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
    await admin.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS check_billing_events_check_fk`);
    await admin.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS check_billing_events_check_intake_item_id_fkey1`);
    if (sql) await admin.query(sql);
  };
  const refuses = async (pattern, label) => {
    const before = await constraints(admin);
    const rows = await charges(admin);
    const result = await runFile(connectAs);
    assert.ok(result.error, `${label}: expected a refusal`);
    assert.equal(result.error.code, '55000', `${label}: ${result.error.message}`);
    assert.match(result.error.message, pattern, label);
    assert.deepEqual(await constraints(admin), before, label);
    assert.deepEqual(await charges(admin), rows, label);
  };
  const cascade = `ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE CASCADE`;

  await admin.query(`ALTER TABLE ${TABLE} ALTER COLUMN check_intake_item_id SET NOT NULL`);
  await refuses(/^sql169_column_not_nullable: public\.check_billing_events\.check_intake_item_id is NOT NULL$/, 'NOT NULL');
  await admin.query(`ALTER TABLE ${TABLE} ALTER COLUMN check_intake_item_id DROP NOT NULL`);

  await setKey(null);
  await refuses(/^sql169_unexpected_foreign_key: 0 foreign key\(s\) on check_intake_item_id, name -$/, 'missing');
  await setKey(`ALTER TABLE ${TABLE} ADD CONSTRAINT check_billing_events_check_fk FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE CASCADE`);
  await refuses(/^sql169_unexpected_foreign_key: 1 foreign key\(s\) on check_intake_item_id, name check_billing_events_check_fk$/, 'renamed');
  await setKey(`${cascade}; ALTER TABLE ${TABLE} ADD CONSTRAINT check_billing_events_check_intake_item_id_fkey1 FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE CASCADE`);
  await refuses(/^sql169_unexpected_foreign_key: 2 foreign key\(s\) on check_intake_item_id/, 'doubled');
  await setKey(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE RESTRICT`);
  await refuses(/^sql169_unexpected_foreign_key: on_delete=r /, 'restrict');
  await setKey(`${cascade} DEFERRABLE`);
  await refuses(/^sql169_unexpected_foreign_key: on_delete=c on_update=a match=s deferrable=t /, 'deferrable');
  await setKey(`${cascade} ON UPDATE CASCADE`);
  await refuses(/^sql169_unexpected_foreign_key: on_delete=c on_update=c /, 'on update cascade');
  await setKey(`${cascade} NOT VALID`);
  await refuses(/ validated=f /, 'not validated');
  // Another referenced column: a unique copy of the id on check_intake_items stands in.
  await admin.query('ALTER TABLE public.check_intake_items ADD COLUMN sql169_alt uuid UNIQUE');
  await admin.query('UPDATE public.check_intake_items SET sql169_alt = id');
  await setKey(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(sql169_alt) ON DELETE CASCADE`);
  await refuses(/references_checks_id=f$/, 'other column');

  // The accepted predecessor applies; then the table missing refuses.
  await setKey(cascade);
  const ok = await runFile(connectAs);
  assert.equal(ok.error, null, ok.error?.message);
  assert.ok(ok.notices.includes('sql169_foreign_key_set_null_applied'), JSON.stringify(ok.notices));
  assert.deepEqual(await keyDef(admin), { def: SET_NULL_DEF, validated: true });
  await admin.query(`DROP TABLE ${TABLE}`);
  const missing = await runFile(connectAs);
  assert.equal(missing.error?.code, '55000');
  assert.match(missing.error.message, /^sql169_prerequisite_missing: public\.check_billing_events$/);
}));
