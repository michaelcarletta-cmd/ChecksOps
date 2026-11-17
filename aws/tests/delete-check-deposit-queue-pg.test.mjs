/**
 * Delete Check and a deposit record that never left the deposit queue (owner 2026-11-17), on PostgreSQL 16:
 * aws/functions/api/workflow.mjs planDepositQueueForCheckDelete and removeDepositQueueForCheckDelete, run as the API
 * login (checksops) inside its own transaction, then the check's DELETE, against deposit tables shaped like the
 * Supabase ones (deposit_items.check_id and the deposit_item_id keys do not cascade; deposit_attachments does):
 *
 *   - a check whose deposit record is still in the queue (pending_assignment, nothing else set) with its
 *     'prepare_deposit' audit row: both are removed with the check and returned by the plan; another check's
 *     deposit record and audit row are untouched;
 *   - a deposit record that was only assigned to a provider and an open batch (owner 2026-11-17, second case) goes with
 *     the check too, with its 'assign_provider' audit row, and the batch's totals are reduced; a batch that is not
 *     open, or that the API login cannot see or change, refuses the delete;
 *   - a deposit record that went further (submitted; succeeded; an NSF flag) is refused and the
 *     plan names what it reached; a queue record with a related deposit record (provider attempt, exception,
 *     webhook, escalation, attachment, or an audit row of another action) is refused by that table; nothing changes;
 *   - when the API login may not delete deposit records (DELETE revoked, or no DELETE policy under RLS) the removal
 *     answers deposit_cleanup_denied / deposit_cleanup_incomplete and nothing changes.
 * The handler's use of the two helpers is covered in aws/tests/workflow-delete-check-live.test.mjs.
 *
 * Run: node --test aws/tests/delete-check-deposit-queue-pg.test.mjs (as root the PG helpers run the server as ubuntu).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEPOSIT_QUEUE_RELATED_BLOCKERS,
  planCheckAltDepositsForCheckDelete,
  planDepositQueueForCheckDelete,
  removeDepositQueueForCheckDelete,
} from '../functions/api/workflow.mjs';
import { CHECK_A, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const CHECK_B = '55555555-5555-4555-8555-55555555555b';
const CHECK_C = '55555555-5555-4555-8555-55555555555c';
const ITEM_A = 'd1000000-0000-4000-8000-00000000000a';
const ITEM_B = 'd1000000-0000-4000-8000-00000000000b';
const ITEM_C = 'd1000000-0000-4000-8000-00000000000c';
const AUDIT_A = 'da000000-0000-4000-8000-00000000000a';
const AUDIT_B = 'da000000-0000-4000-8000-00000000000b';
const AUDIT_C = 'da000000-0000-4000-8000-00000000000c';
const BATCH = 'db000000-0000-4000-8000-000000000001';
const ACTOR = 'a1000000-0000-4000-8000-000000000001';
const DEPOSIT_TABLES = ['deposit_items', 'deposit_audit_log', 'deposit_provider_attempts', 'deposit_exceptions',
  'deposit_webhook_events', 'deposit_escalation_events', 'deposit_attachments'];

// The fixture's deposit_items is (id, check_id, amount, status text, batch_id); the rest follows the Supabase tables.
const FIXTURE = `
INSERT INTO public.check_intake_items (id, tenant_id) VALUES ('${CHECK_B}', '${TENANT_A}'), ('${CHECK_C}', '${TENANT_A}');
ALTER TABLE public.deposit_batches
  ADD COLUMN status text NOT NULL DEFAULT 'open', ADD COLUMN submitted_at timestamptz, ADD COLUMN cleared_at timestamptz,
  ADD COLUMN cleared_amount numeric(12,2) NOT NULL DEFAULT 0, ADD COLUMN failed_amount numeric(12,2) NOT NULL DEFAULT 0;
INSERT INTO public.deposit_batches (id, provider, total_items, total_amount) VALUES ('${BATCH}', 'manual_branch', 2, 2150.00);
CREATE POLICY delcheck_test_batch_all ON public.deposit_batches FOR ALL TO checksops USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE ON public.deposit_batches TO checksops;
ALTER TABLE public.deposit_items
  ALTER COLUMN status SET DEFAULT 'pending_assignment',
  ADD CONSTRAINT deposit_items_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.deposit_batches(id),
  ADD CONSTRAINT deposit_items_check_id_fkey FOREIGN KEY (check_id) REFERENCES public.check_intake_items(id),
  ADD CONSTRAINT deposit_items_check_id_key UNIQUE (check_id),
  ADD COLUMN provider text, ADD COLUMN check_number text, ADD COLUMN provider_reference text,
  ADD COLUMN provider_payload jsonb, ADD COLUMN exception_code text, ADD COLUMN reconciled_at timestamptz,
  ADD COLUMN submitted_at timestamptz, ADD COLUMN cleared_at timestamptz, ADD COLUMN deposit_slip_number text,
  ADD COLUMN variance_amount numeric DEFAULT 0, ADD COLUMN nsf_flag boolean DEFAULT false,
  ADD COLUMN closeout_complete boolean NOT NULL DEFAULT false, ADD COLUMN owner_id uuid, ADD COLUMN next_action text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE public.deposit_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deposit_item_id uuid REFERENCES public.deposit_items(id),
  batch_id uuid REFERENCES public.deposit_batches(id), action text NOT NULL, actor_id uuid, amount numeric(12,2), notes text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.deposit_provider_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deposit_item_id uuid NOT NULL REFERENCES public.deposit_items(id),
  status text NOT NULL DEFAULT 'pending');
CREATE TABLE public.deposit_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deposit_item_id uuid NOT NULL REFERENCES public.deposit_items(id),
  exception_type text NOT NULL DEFAULT 'review', description text NOT NULL DEFAULT 'x');
CREATE TABLE public.deposit_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deposit_item_id uuid REFERENCES public.deposit_items(id),
  event_type text NOT NULL DEFAULT 'x');
CREATE TABLE public.deposit_escalation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deposit_item_id uuid REFERENCES public.deposit_items(id),
  escalation_type text NOT NULL DEFAULT 'unassigned_item');
CREATE TABLE public.deposit_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_item_id uuid NOT NULL REFERENCES public.deposit_items(id) ON DELETE CASCADE,
  file_name text NOT NULL DEFAULT 'slip.pdf');
INSERT INTO public.deposit_items (id, check_id, amount, check_number, owner_id, next_action) VALUES
  ('${ITEM_A}', '${CHECK_A}', 1250.00, '1001', '${ACTOR}', 'assign provider'),
  ('${ITEM_B}', '${CHECK_B}', 900.00, '1002', NULL, NULL),
  ('${ITEM_C}', '${CHECK_C}', 400.00, '1003', NULL, NULL);
INSERT INTO public.deposit_audit_log (id, deposit_item_id, action, actor_id, amount, notes) VALUES
  ('${AUDIT_A}', '${ITEM_A}', 'prepare_deposit', '${ACTOR}', 1250.00, 'queued'),
  ('${AUDIT_B}', '${ITEM_B}', 'prepare_deposit', '${ACTOR}', 900.00, NULL),
  ('${AUDIT_C}', '${ITEM_C}', 'prepare_deposit', '${ACTOR}', 400.00, NULL);
${DEPOSIT_TABLES.map((table) => `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
CREATE POLICY delcheck_test_member_all ON public.${table} FOR ALL TO checksops USING (true) WITH CHECK (true);
GRANT SELECT, DELETE ON public.${table} TO checksops;`).join('\n')}
-- Check Alt deposit records, keyed to the check with ON DELETE CASCADE as in the Supabase table; the API login may only read them.
CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_intake_item_id uuid REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  tenant_id uuid, checkalt_reference text UNIQUE, status text NOT NULL DEFAULT 'pending', amount numeric,
  provider_http_attempted_at timestamptz, submitted_at timestamptz, cleared_at timestamptz, returned_at timestamptz,
  approved_at timestamptz, status_unresolved boolean NOT NULL DEFAULT false, failure_class text, last_error text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.wallet_funding_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkalt_deposit_id uuid REFERENCES public.checkalt_deposits(id) ON DELETE CASCADE);
ALTER TABLE public.checkalt_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_funding_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY delcheck_test_ca_select ON public.checkalt_deposits FOR SELECT TO checksops USING (true);
CREATE POLICY delcheck_test_wfq_select ON public.wallet_funding_queue FOR SELECT TO checksops USING (true);
GRANT SELECT ON public.checkalt_deposits, public.wallet_funding_queue TO checksops;
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
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** Every deposit row and check, as text, to prove "nothing changed". */
const state = async (admin) => {
  const out = {};
  for (const table of [...DEPOSIT_TABLES, 'deposit_batches', 'check_intake_items']) {
    out[table] = (await admin.query(`SELECT to_jsonb(t)::text AS row FROM public.${table} t ORDER BY t.id`)).rows.map((r) => r.row);
  }
  return out;
};
const ids = async (admin, table) => (await admin.query(`SELECT id::text FROM public.${table} ORDER BY id`)).rows.map((r) => r.id);

/** The plan, then the removal and the check's DELETE, as the API login in one transaction (rolled back on a refusal). */
async function deleteAsApi(connectAs, checkId) {
  const api = await connectAs('checksops');
  try {
    await api.query('BEGIN');
    const plan = await planDepositQueueForCheckDelete(api, checkId);
    if (plan.error) {
      await api.query('ROLLBACK');
      return plan;
    }
    const removed = await removeDepositQueueForCheckDelete(api, checkId, plan);
    if (removed.error) {
      await api.query('ROLLBACK');
      return removed;
    }
    const deleted = (await api.query('DELETE FROM public.check_intake_items WHERE id = $1::uuid RETURNING id', [checkId])).rows.length;
    await api.query('COMMIT');
    return { plan, removed, deleted };
  } catch (error) {
    await api.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await api.end();
  }
}

test('PostgreSQL 16: a deposit record that never left the queue goes with the check, with its prepare_deposit audit row; other checks keep theirs', { timeout: 600000 }, async (t) => withPg(t, 'pg-delcheck-queue-', 60571, async ({ admin, connectAs }) => {
  const before = await state(admin);
  // The deposit record's key does not cascade: without the helper the check's DELETE is refused by the key.
  const raw = await connectAs('checksops');
  try {
    await assert.rejects(raw.query('DELETE FROM public.check_intake_items WHERE id = $1::uuid', [CHECK_A]), (error) => error.code === '23503');
  } finally {
    await raw.end();
  }
  assert.deepEqual(await state(admin), before);

  const a = await deleteAsApi(connectAs, CHECK_A);
  assert.equal(a.deleted, 1, JSON.stringify(a));
  assert.deepEqual(a.removed, { items: 1, audit: 1, batches: 0 });
  assert.deepEqual(a.plan.batches, []);
  // The plan carries the full rows for the deletion log.
  assert.equal(a.plan.items.length, 1);
  assert.equal(a.plan.items[0].id, ITEM_A);
  assert.equal(a.plan.items[0].check_id, CHECK_A);
  assert.equal(a.plan.items[0].status, 'pending_assignment');
  assert.equal(Number(a.plan.items[0].amount), 1250);
  assert.equal(a.plan.items[0].next_action, 'assign provider');
  assert.equal(a.plan.audit.length, 1);
  assert.equal(a.plan.audit[0].id, AUDIT_A);
  assert.equal(a.plan.audit[0].action, 'prepare_deposit');
  assert.equal(a.plan.audit[0].notes, 'queued');

  assert.deepEqual(await ids(admin, 'deposit_items'), [ITEM_B, ITEM_C]);
  assert.deepEqual(await ids(admin, 'deposit_audit_log'), [AUDIT_B, AUDIT_C]);
  assert.deepEqual(await ids(admin, 'check_intake_items'), [CHECK_B, CHECK_C].sort());
  // The other checks' rows are byte for byte what they were.
  const after = await state(admin);
  assert.deepEqual(after.deposit_items, before.deposit_items.filter((row) => !row.includes(ITEM_A)));
  assert.deepEqual(after.deposit_audit_log, before.deposit_audit_log.filter((row) => !row.includes(ITEM_A)));

  // A check with no deposit record: nothing planned, nothing removed.
  await admin.query('DELETE FROM public.deposit_audit_log WHERE deposit_item_id = $1::uuid', [ITEM_C]);
  await admin.query('DELETE FROM public.deposit_items WHERE id = $1::uuid', [ITEM_C]);
  const c = await deleteAsApi(connectAs, CHECK_C);
  assert.deepEqual(c, { plan: { items: [], audit: [], batches: [] }, removed: { items: 0, audit: 0, batches: 0 }, deleted: 1 });
  assert.deepEqual(await ids(admin, 'deposit_items'), [ITEM_B]);
}));

test('PostgreSQL 16: a deposit record that left the queue, or has any related deposit record, still refuses the delete and nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-delcheck-queue-blk-', 60671, async ({ admin, connectAs }) => {
  const refusedWith = async (setup, undo, expected) => {
    await admin.query(setup);
    const before = await state(admin);
    const out = await deleteAsApi(connectAs, CHECK_A);
    assert.deepEqual(out, expected, setup);
    assert.deepEqual(await state(admin), before, setup);
    await admin.query(undo);
  };
  const blocked = (reached) => ({ error: 'check_has_financial_activity', blocker: 'deposit_items', reached });
  const reset = `UPDATE public.deposit_items SET status = 'pending_assignment', provider = NULL, batch_id = NULL, cleared_at = NULL,
    submitted_at = NULL, deposit_slip_number = NULL, nsf_flag = false, closeout_complete = false, variance_amount = 0,
    exception_code = NULL, reconciled_at = NULL WHERE id = '${ITEM_A}'`;

  // Assigned to a provider and a batch only: the record no longer blocks by itself, but its batch must be open.
  const assign = `UPDATE public.deposit_items SET status = 'provider_assigned', provider = 'manual_branch', batch_id = '${BATCH}' WHERE id = '${ITEM_A}'`;
  const batchBlocked = (reached) => ({ error: 'check_has_financial_activity', blocker: 'deposit_batches', reached });
  const batchReset = `${reset}; UPDATE public.deposit_batches SET status = 'open', submitted_at = NULL, cleared_at = NULL, cleared_amount = 0, failed_amount = 0 WHERE id = '${BATCH}'`;
  await refusedWith(`${assign}; UPDATE public.deposit_batches SET status = 'submitted', submitted_at = '2026-11-10T00:00:00Z' WHERE id = '${BATCH}'`,
    batchReset, batchBlocked(['status:submitted', 'submitted_at']));
  await refusedWith(`${assign}; UPDATE public.deposit_batches SET status = 'sealed' WHERE id = '${BATCH}'`, batchReset, batchBlocked(['status:sealed']));
  await refusedWith(`${assign}; UPDATE public.deposit_batches SET cleared_amount = 10 WHERE id = '${BATCH}'`, batchReset, batchBlocked(['cleared_amount']));
  // Assigned and then anything more on the record itself: refused by the record.
  await refusedWith(`${assign}; UPDATE public.deposit_items SET provider_reference = 'REF-1' WHERE id = '${ITEM_A}'`,
    `${reset}; UPDATE public.deposit_items SET provider_reference = NULL WHERE id = '${ITEM_A}'`,
    blocked(['status:provider_assigned', 'batch_id', 'provider', 'provider_reference']));
  await refusedWith(`UPDATE public.deposit_items SET status = 'submitted', provider = 'manual_branch', batch_id = '${BATCH}', submitted_at = '2026-11-10T00:00:00Z' WHERE id = '${ITEM_A}'`,
    reset, blocked(['status:submitted', 'batch_id', 'provider', 'submitted_at']));
  await refusedWith(`UPDATE public.deposit_items SET status = 'succeeded', provider = 'manual_branch', cleared_at = '2026-11-10T00:00:00Z', deposit_slip_number = 'S-1' WHERE id = '${ITEM_A}'`,
    reset, blocked(['status:succeeded', 'provider', 'deposit_slip_number', 'cleared_at']));
  // Still pending_assignment, but one field beyond the queue is enough.
  await refusedWith(`UPDATE public.deposit_items SET nsf_flag = true WHERE id = '${ITEM_A}'`, reset, blocked(['nsf_flag']));
  await refusedWith(`UPDATE public.deposit_items SET submitted_at = '2026-11-10T00:00:00Z' WHERE id = '${ITEM_A}'`, reset, blocked(['submitted_at']));
  await refusedWith(`UPDATE public.deposit_items SET reconciled_at = '2026-11-10T00:00:00Z', variance_amount = 5 WHERE id = '${ITEM_A}'`, reset, blocked(['reconciled_at', 'variance_amount']));
  await refusedWith(`UPDATE public.deposit_items SET exception_code = 'R01' WHERE id = '${ITEM_A}'`, reset, blocked(['exception_code']));
  await refusedWith(`UPDATE public.deposit_items SET closeout_complete = true WHERE id = '${ITEM_A}'`, reset, blocked(['closeout_complete']));

  // A queue record with a related deposit record: refused by that table.
  for (const table of ['deposit_provider_attempts', 'deposit_exceptions', 'deposit_webhook_events', 'deposit_escalation_events', 'deposit_attachments']) {
    await refusedWith(`INSERT INTO public.${table} (deposit_item_id) VALUES ('${ITEM_A}')`,
      `DELETE FROM public.${table} WHERE deposit_item_id = '${ITEM_A}'`,
      { error: 'check_has_financial_activity', blocker: table });
  }
  for (const action of ['mark_manual_deposit', 'record_submission']) {
    await refusedWith(`INSERT INTO public.deposit_audit_log (deposit_item_id, action) VALUES ('${ITEM_A}', '${action}')`,
      `DELETE FROM public.deposit_audit_log WHERE deposit_item_id = '${ITEM_A}' AND action = '${action}'`,
      { error: 'check_has_financial_activity', blocker: 'deposit_audit_log' });
  }
  assert.deepEqual(DEPOSIT_QUEUE_RELATED_BLOCKERS.map((row) => row.table), ['deposit_provider_attempts', 'deposit_exceptions',
    'deposit_webhook_events', 'deposit_escalation_events', 'deposit_attachments', 'deposit_audit_log']);

  // Back in the queue with nothing related, it is deletable again.
  const ok = await deleteAsApi(connectAs, CHECK_A);
  assert.equal(ok.deleted, 1, JSON.stringify(ok));
  assert.deepEqual(ok.removed, { items: 1, audit: 1, batches: 0 });
}));

test('PostgreSQL 16: a deposit record only assigned to a provider and an open batch goes with the check; the batch totals are reduced and the batch stays', { timeout: 600000 }, async (t) => withPg(t, 'pg-delcheck-queue-asg-', 60871, async ({ admin, connectAs }) => {
  const AUDIT_ASSIGN = 'da000000-0000-4000-8000-0000000000a1';
  // CHECK_A and CHECK_B are both assigned to the same open batch (2 items, 2150.00), as assign_provider writes it.
  await admin.query(`UPDATE public.deposit_items SET status = 'provider_assigned', provider = 'manual_branch', batch_id = '${BATCH}' WHERE id IN ('${ITEM_A}', '${ITEM_B}');
    INSERT INTO public.deposit_audit_log (id, deposit_item_id, batch_id, action, actor_id, amount) VALUES
      ('${AUDIT_ASSIGN}', '${ITEM_A}', '${BATCH}', 'assign_provider', '${ACTOR}', 1250.00),
      (gen_random_uuid(), '${ITEM_B}', '${BATCH}', 'assign_provider', '${ACTOR}', 900.00);`);
  const before = await state(admin);
  const batch = async () => (await admin.query(`SELECT total_items, total_amount::text, status FROM public.deposit_batches WHERE id = '${BATCH}'`)).rows[0];
  assert.deepEqual(await batch(), { total_items: 2, total_amount: '2150.00', status: 'open' });

  // When the API login may not change the batch, or cannot see it, the delete is refused and nothing changes.
  await admin.query('REVOKE UPDATE ON public.deposit_batches FROM checksops');
  assert.deepEqual(await deleteAsApi(connectAs, CHECK_A), { error: 'deposit_cleanup_denied' });
  assert.deepEqual(await state(admin), before);
  await admin.query('GRANT UPDATE ON public.deposit_batches TO checksops');
  await admin.query('DROP POLICY delcheck_test_batch_all ON public.deposit_batches');
  assert.deepEqual(await deleteAsApi(connectAs, CHECK_A), { error: 'check_has_financial_activity', blocker: 'deposit_batches', reached: ['unreadable'] });
  assert.deepEqual(await state(admin), before);
  await admin.query('CREATE POLICY delcheck_test_batch_all ON public.deposit_batches FOR ALL TO checksops USING (true) WITH CHECK (true)');

  const a = await deleteAsApi(connectAs, CHECK_A);
  assert.equal(a.deleted, 1, JSON.stringify(a));
  assert.deepEqual(a.removed, { items: 1, audit: 2, batches: 1 });
  assert.equal(a.plan.items[0].status, 'provider_assigned');
  assert.equal(a.plan.items[0].batch_id, BATCH);
  assert.deepEqual(a.plan.audit.map((row) => row.action).sort(), ['assign_provider', 'prepare_deposit']);
  // The plan carries the batch as it was before the change, for the deletion log.
  assert.equal(a.plan.batches.length, 1);
  assert.equal(a.plan.batches[0].id, BATCH);
  assert.equal(a.plan.batches[0].total_items, 2);
  assert.equal(Number(a.plan.batches[0].total_amount), 2150);
  // The batch stays, without this check's item and amount; the other check keeps its record and audit rows.
  assert.deepEqual(await batch(), { total_items: 1, total_amount: '900.00', status: 'open' });
  assert.deepEqual(await ids(admin, 'deposit_items'), [ITEM_B, ITEM_C]);
  const after = await state(admin);
  assert.deepEqual(after.deposit_items, before.deposit_items.filter((row) => !row.includes(ITEM_A)));
  assert.deepEqual(after.deposit_audit_log, before.deposit_audit_log.filter((row) => !row.includes(ITEM_A)));

  // The last item leaves an empty open batch behind (it is not deleted).
  const b = await deleteAsApi(connectAs, CHECK_B);
  assert.equal(b.deleted, 1, JSON.stringify(b));
  assert.deepEqual(b.removed, { items: 1, audit: 2, batches: 1 });
  assert.deepEqual(await batch(), { total_items: 0, total_amount: '0.00', status: 'open' });
  assert.deepEqual(await ids(admin, 'deposit_items'), [ITEM_C]);
}));

test('PostgreSQL 16: when the API login may not delete deposit records the delete is refused and nothing is removed', { timeout: 600000 }, async (t) => withPg(t, 'pg-delcheck-queue-deny-', 60771, async ({ admin, connectAs }) => {
  const before = await state(admin);

  // DELETE revoked on the audit rows, then on the deposit record itself (42501).
  await admin.query('REVOKE DELETE ON public.deposit_audit_log FROM checksops');
  assert.deepEqual(await deleteAsApi(connectAs, CHECK_A), { error: 'deposit_cleanup_denied' });
  assert.deepEqual(await state(admin), before);
  await admin.query('GRANT DELETE ON public.deposit_audit_log TO checksops');
  await admin.query('REVOKE DELETE ON public.deposit_items FROM checksops');
  assert.deepEqual(await deleteAsApi(connectAs, CHECK_A), { error: 'deposit_cleanup_denied' });
  assert.deepEqual(await state(admin), before);
  await admin.query('GRANT DELETE ON public.deposit_items TO checksops');

  // RLS without a DELETE policy for the API login: the DELETE removes 0 rows and the removal is undone.
  await admin.query(`DROP POLICY delcheck_test_member_all ON public.deposit_items;
    CREATE POLICY delcheck_test_member_select ON public.deposit_items FOR SELECT TO checksops USING (true);`);
  assert.deepEqual(await deleteAsApi(connectAs, CHECK_A), { error: 'deposit_cleanup_incomplete' });
  assert.deepEqual(await state(admin), before);

  // The deposit records cannot be read at all: the blocker cannot be verified.
  await admin.query('REVOKE SELECT ON public.deposit_items FROM checksops, authenticated');
  assert.deepEqual(await deleteAsApi(connectAs, CHECK_A), { error: 'blocker_verification_denied', blocker: 'deposit_items' });
  assert.deepEqual(await state(admin), before);
}));

test('PostgreSQL 16: a Check Alt deposit record that Check Alt never took goes with the check through its cascading key; one it took still refuses', { timeout: 600000 }, async (t) => withPg(t, 'pg-delcheck-queue-ca-', 60971, async ({ admin, connectAs }) => {
  const CA_A = 'ca000000-0000-4000-8000-00000000000a';
  const CA_B = 'ca000000-0000-4000-8000-00000000000b';
  // CHECK_C: the queue record only. CHECK_A: a refused image (error, no reference). CHECK_B: accepted by Check Alt.
  await admin.query(`INSERT INTO public.checkalt_deposits (id, check_intake_item_id, tenant_id, status, amount, provider_http_attempted_at, checkalt_reference, submitted_at, failure_class, last_error) VALUES
    ('${CA_A}', '${CHECK_A}', '${TENANT_A}', 'error', 1250.00, now(), NULL, NULL, 'provider_error', 'image not accepted'),
    ('${CA_B}', '${CHECK_B}', '${TENANT_A}', 'submitted', 900.00, now(), 'REF-B', now(), NULL, NULL)`);
  const caIds = async () => ids(admin, 'checkalt_deposits');
  const run = async (checkId) => {
    const api = await connectAs('checksops');
    try {
      await api.query('BEGIN');
      const checkAlt = await planCheckAltDepositsForCheckDelete(api, checkId);
      if (checkAlt.error) { await api.query('ROLLBACK'); return checkAlt; }
      const plan = await planDepositQueueForCheckDelete(api, checkId);
      const removed = await removeDepositQueueForCheckDelete(api, checkId, plan);
      const deletedRows = (await api.query('DELETE FROM public.check_intake_items WHERE id = $1::uuid RETURNING id', [checkId])).rows.length;
      await api.query('COMMIT');
      return { checkAlt, removed, deleted: deletedRows };
    } catch (error) {
      await api.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await api.end();
    }
  };

  // Accepted by Check Alt: refused, and the plan names what it reached; nothing changes.
  const before = await state(admin);
  assert.deepEqual(await run(CHECK_B), { error: 'check_has_financial_activity', blocker: 'checkalt_deposits',
    reached: ['status:submitted', 'provider_http_attempted_at', 'checkalt_reference', 'submitted_at'] });
  assert.deepEqual(await state(admin), before);
  assert.deepEqual(await caIds(), [CA_A, CA_B]);

  // A wallet funding entry made from the refused record: refused by that table.
  await admin.query(`INSERT INTO public.wallet_funding_queue (checkalt_deposit_id) VALUES ('${CA_A}')`);
  assert.deepEqual(await run(CHECK_A), { error: 'check_has_financial_activity', blocker: 'wallet_funding_queue' });
  assert.deepEqual(await caIds(), [CA_A, CA_B]);
  await admin.query('DELETE FROM public.wallet_funding_queue');

  // The API login cannot read the records: unverifiable, refused.
  await admin.query('REVOKE SELECT ON public.checkalt_deposits FROM checksops');
  assert.deepEqual(await run(CHECK_A), { error: 'blocker_verification_denied', blocker: 'checkalt_deposits' });
  await admin.query('GRANT SELECT ON public.checkalt_deposits TO checksops');

  // The refused image: the record is planned (full row, for the deletion log) and leaves with the check by cascade,
  // although the API login has no DELETE on the table.
  const a = await run(CHECK_A);
  assert.equal(a.deleted, 1, JSON.stringify(a));
  assert.equal(a.checkAlt.deposits.length, 1);
  assert.equal(a.checkAlt.deposits[0].id, CA_A);
  assert.equal(a.checkAlt.deposits[0].status, 'error');
  assert.equal(a.checkAlt.deposits[0].last_error, 'image not accepted');
  assert.deepEqual(await caIds(), [CA_B]);

  // A check with no Check Alt record: nothing planned.
  const c = await run(CHECK_C);
  assert.equal(c.deleted, 1, JSON.stringify(c));
  assert.deepEqual(c.checkAlt, { deposits: [] });
  assert.deepEqual(await caIds(), [CA_B]);
  assert.deepEqual(await ids(admin, 'check_intake_items'), [CHECK_B]);
}));
