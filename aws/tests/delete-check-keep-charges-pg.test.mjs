/**
 * Delete Check keeps a deleted check's charges (owner 2026-11-16, "Delete, keep charge (Recommended)"), on PostgreSQL 16:
 * aws/functions/api/workflow.mjs settleBillingEventsForCheckDelete, run as the API login (checksops) inside its own
 * transaction, then the check's DELETE, against the Supabase check_billing_events table after the real SQL 169 file
 * (aws/workflows/sql/169_check_billing_events_keep_charge_on_check_delete.sql) ran as checksops_admin, with SQL 136's
 * restrictive DELETE gate (the money-write flag) for the API login:
 *
 *   - a check with a real charge (invoiced Mortgage Ops) plus a provisional mortgage_handling event and a voided row:
 *     the provisional and voided rows are removed (under the flag), the charge stays with check_intake_item_id NULL and
 *     every other column unchanged, and is returned as kept;
 *   - a check with only a provisional mortgage_handling event: the event is removed, nothing stays;
 *   - another check's charge is untouched;
 *   - without the flag the gate refuses the API login's own DELETE of a billing row (0 rows): the helper is what sets it;
 *   - with DELETE revoked from the API login the helper answers billing_cleanup_denied and changes nothing.
 * The blockers (deposits, Check Alt, disbursements, payments, payment directions) are covered through the handler in
 * aws/tests/workflow-delete-check-live.test.mjs.
 *
 * Run: node --test aws/tests/delete-check-keep-charges-pg.test.mjs (as root the PG helpers run the server as ubuntu).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { settleBillingEventsForCheckDelete } from '../functions/api/workflow.mjs';
import { CHECK_A, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL169 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/169_check_billing_events_keep_charge_on_check_delete.sql'), 'utf8');
const TABLE = 'public.check_billing_events';
const CHECK_B = '55555555-5555-4555-8555-55555555555b';
const CHECK_C = '55555555-5555-4555-8555-55555555555c';
const CLAIM = '66666666-6666-4666-8666-666666666666';
const CHARGE_A = 'd0c10000-0000-4000-8000-00000000000a';
const REVIEW_A = 'd0c10000-0000-4000-8000-0000000000a2';
const VOIDED_A = 'd0c10000-0000-4000-8000-0000000000a3';
const CHARGE_B = 'd0c10000-0000-4000-8000-00000000000b';
const REVIEW_C = 'd0c10000-0000-4000-8000-00000000000c';

const FIXTURE = `
INSERT INTO public.check_intake_items (id, tenant_id) VALUES ('${CHECK_B}', '${TENANT_A}'), ('${CHECK_C}', '${TENANT_A}');
CREATE TABLE ${TABLE} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  check_intake_item_id uuid REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  claim_id uuid,
  event_type text NOT NULL DEFAULT 'check_processing',
  unit_price_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'recorded',
  invoice_id uuid,
  billed_at timestamptz NOT NULL DEFAULT '2026-11-01T00:00:00Z');
CREATE UNIQUE INDEX check_billing_events_check_event_uidx ON ${TABLE} (check_intake_item_id, event_type);
INSERT INTO ${TABLE} (id, tenant_id, check_intake_item_id, claim_id, event_type, unit_price_cents, status, invoice_id, billed_at) VALUES
  ('${CHARGE_A}', '${TENANT_A}', '${CHECK_A}', '${CLAIM}', 'mortgage_ops_initial', 1000, 'invoiced', 'e0000000-0000-4000-8000-000000000001', '2026-11-02T00:00:00Z'),
  ('${REVIEW_A}', '${TENANT_A}', '${CHECK_A}', '${CLAIM}', 'mortgage_handling', 1000, 'reported', NULL, '2026-11-03T00:00:00Z'),
  ('${VOIDED_A}', '${TENANT_A}', '${CHECK_A}', '${CLAIM}', 'check_processing', 150, 'voided', NULL, '2026-11-04T00:00:00Z'),
  ('${CHARGE_B}', '${TENANT_A}', '${CHECK_B}', '${CLAIM}', 'mortgage_ops_initial', 1000, 'recorded', NULL, '2026-11-05T00:00:00Z'),
  ('${REVIEW_C}', '${TENANT_A}', '${CHECK_C}', NULL, 'mortgage_handling', 1000, 'reported', NULL, '2026-11-06T00:00:00Z');
ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
CREATE POLICY delcheck_test_member_all ON ${TABLE} FOR ALL TO checksops USING (true) WITH CHECK (true);
CREATE POLICY aws_money_write_gate_delete_check_billing_events ON ${TABLE} AS RESTRICTIVE FOR DELETE TO checksops
  USING (COALESCE(current_setting('request.money_write', true) = '1', false));
GRANT SELECT, DELETE ON ${TABLE} TO checksops;
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY delcheck_test_api_delete ON public.check_intake_items FOR DELETE TO checksops USING (true);
CREATE POLICY delcheck_test_api_select ON public.check_intake_items FOR SELECT TO checksops USING (true);
GRANT DELETE ON public.check_intake_items TO checksops;`;

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
  const fx = await releaseFixture(pg, prefix, port, { extra: [FIXTURE] });
  try {
    const owner = await fx.connectAs('checksops_admin');
    try {
      await owner.query(SQL169);
    } finally {
      await owner.end();
    }
    await fn(fx);
  } finally {
    await fx.close();
  }
}

const rows = async (admin) => (await admin.query(`SELECT id::text, check_intake_item_id::text AS check_id, event_type,
  unit_price_cents, status, invoice_id::text, billed_at::text FROM ${TABLE} ORDER BY id`)).rows;
const checkExists = async (admin, id) => (await admin.query('SELECT 1 FROM public.check_intake_items WHERE id = $1::uuid', [id])).rows.length > 0;

/** settleBillingEventsForCheckDelete, then the check's DELETE, as the API login in one transaction. */
async function deleteAsApi(connectAs, checkId) {
  const api = await connectAs('checksops');
  try {
    await api.query('BEGIN');
    const billing = await settleBillingEventsForCheckDelete(api, checkId);
    if (billing.error) {
      await api.query('ROLLBACK');
      return billing;
    }
    const deleted = (await api.query('DELETE FROM public.check_intake_items WHERE id = $1::uuid RETURNING id', [checkId])).rows.length;
    await api.query('COMMIT');
    return { ...billing, deleted };
  } catch (error) {
    await api.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await api.end();
  }
}

test('PostgreSQL 16: deleting a check keeps its charges unlinked and removes only the provisional billing rows, under the money-write gate', { timeout: 600000 }, async (t) => withPg(t, 'pg-delcheck-keep-', 60569, async ({ admin, connectAs }) => {
  const before = await rows(admin);
  const chargeA = before.find((r) => r.id === CHARGE_A);
  const chargeB = before.find((r) => r.id === CHARGE_B);

  // Without the flag the gate refuses the API login's own delete of a billing row.
  const raw = await connectAs('checksops');
  try {
    const refused = await raw.query(`DELETE FROM ${TABLE} WHERE id = $1::uuid RETURNING id`, [REVIEW_A]);
    assert.equal(refused.rows.length, 0);
  } finally {
    await raw.end();
  }
  assert.deepEqual(await rows(admin), before);

  // Check A: a real charge, a provisional Review event and a voided row.
  const a = await deleteAsApi(connectAs, CHECK_A);
  assert.equal(a.deleted, 1);
  assert.deepEqual([...a.removed].sort(), [REVIEW_A, VOIDED_A].sort());
  assert.deepEqual(a.kept.map((r) => String(r.id)), [CHARGE_A]);
  assert.equal(a.kept[0].event_type, 'mortgage_ops_initial');
  assert.equal(a.kept[0].status, 'invoiced');
  assert.equal(await checkExists(admin, CHECK_A), false);
  const afterA = await rows(admin);
  assert.deepEqual(afterA.find((r) => r.id === CHARGE_A), { ...chargeA, check_id: null });
  assert.equal(afterA.some((r) => r.id === REVIEW_A || r.id === VOIDED_A), false);
  // Another check's charge is untouched.
  assert.deepEqual(afterA.find((r) => r.id === CHARGE_B), chargeB);

  // Check C: only a provisional Review event: it goes, nothing stays.
  const c = await deleteAsApi(connectAs, CHECK_C);
  assert.equal(c.deleted, 1);
  assert.deepEqual(c.removed, [REVIEW_C]);
  assert.deepEqual(c.kept, []);
  assert.equal((await rows(admin)).some((r) => r.id === REVIEW_C), false);

  // The flag ends with each transaction: a fresh API session is refused again.
  const fresh = await connectAs('checksops');
  try {
    assert.equal((await fresh.query(`DELETE FROM ${TABLE} WHERE id = $1::uuid RETURNING id`, [CHARGE_B])).rows.length, 0);
  } finally {
    await fresh.end();
  }
  assert.deepEqual((await rows(admin)).find((r) => r.id === CHARGE_B), chargeB);
}));

test('PostgreSQL 16: with DELETE revoked from the API login the helper answers billing_cleanup_denied and nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-delcheck-deny-', 60669, async ({ admin, connectAs }) => {
  await admin.query(`REVOKE DELETE ON ${TABLE} FROM checksops`);
  const before = await rows(admin);
  const out = await deleteAsApi(connectAs, CHECK_A);
  assert.deepEqual(out, { error: 'billing_cleanup_denied' });
  assert.equal(await checkExists(admin, CHECK_A), true);
  assert.deepEqual(await rows(admin), before);
}));
