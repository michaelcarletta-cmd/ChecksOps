/**
 * Delete Check as served in production (aws/functions/api/workflow.mjs handleDeleteCheck;
 * workflow-delete-check.mjs is not deployed, see production-lambda-source-reconciliation.test.mjs).
 *
 * Owner policy (2026-10-27): every check can be deleted with a reason, shared or not ("I really just
 * need to be able to delete checks with a reason typed in and no other issues"). Sharing does not
 * block: the check's shared_checks rows go with it (ON DELETE CASCADE), and a partner-ingested copy
 * (external_origin.source_check_id) is the company's own check. A claim payment does not block (its
 * check link is ON DELETE SET NULL). A ChecksOps charge does not block either (owner 2026-11-16, "Delete,
 * keep charge (Recommended)"): SQL 169 made check_billing_events' check link ON DELETE SET NULL, so the
 * charge stays, unlinked, and is listed in the deletion log; the rows the old cascade removed (voided, and
 * the uninvoiced mortgage_handling event written when a check enters Review) are removed under the
 * money-write flag. Real money records (deposits, Check Alt, disbursements) still block, except a deposit
 * record that never left the deposit queue (owner 2026-11-17): status pending_assignment and no batch,
 * provider, submission, reconciliation, clearing, exception, NSF or closeout data. That record and its
 * 'prepare_deposit' audit rows go with the check and are listed in the deletion log; one that went further,
 * or any related deposit record, still blocks (PostgreSQL: delete-check-deposit-queue-pg.test.mjs).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHECK_BILLING_EVENTS_FOR_DELETE_SQL, DEPOSIT_ITEMS_FOR_DELETE_SQL, DEPOSIT_QUEUE_AUDIT_FOR_DELETE_SQL,
  DEPOSIT_QUEUE_PROGRESS_FIELDS, DEPOSIT_QUEUE_RELATED_BLOCKERS, depositQueueProgress, handleDeleteCheck,
  isProvisionalBillingEvent,
} from '../functions/api/workflow.mjs';
import { SET_MONEY_WRITE_SQL } from '../functions/api/money-write-flag.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { TENANT_MEMBER_SQL } from '../functions/api/workflow-transitions.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const jwtEvent = (body) => ({
  rawPath: `/workflow/checks/${CHECK_ID}`,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'production',
    http: { method: 'DELETE', path: `/workflow/checks/${CHECK_ID}` },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const baseCheck = {
  id: CHECK_ID,
  tenant_id: FREEDOM,
  uploaded_by: APP_ID,
  status: 'needs_review',
  check_stage: 'review',
  claim_id: null,
  deposited_at: null,
  external_origin: null,
  amount: 100,
  check_number: '9001',
};

// A partner-ingested copy (SQL 70, native-paired Freedom code): it carries the source check id but
// no shared_checks row.
const ingestedCheck = {
  ...baseCheck,
  external_origin: {
    source_app: 'freedom_crm',
    source_check_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    source_partner_code: 'DF9CC985',
    native_paired: true,
  },
};

const ANY_ROW = [{ '?column?': 1 }];

const mockClient = ({ check = baseCheck, blockers = {}, billing = [], billingError = null, removeOnly = null, deposit = null } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql) || /SAVEPOINT/.test(sql)) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params?.[1] ?? '1' }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', status: 'active' }] };
      }
      if (sql === USER_ROLES_SQL) return { rows: [] };
      if (sql === TENANT_MEMBER_SQL) return { rows: params[0] === APP_ID && params[1] === FREEDOM ? ANY_ROW : [] };
      if (sql === CHECK_BILLING_EVENTS_FOR_DELETE_SQL) {
        if (billingError) throw Object.assign(new Error('billing read failed'), { code: billingError });
        return { rows: billing };
      }
      if (/DELETE FROM public\.check_billing_events/.test(sql)) {
        const ids = removeOnly ?? params[1];
        return { rows: ids.map((id) => ({ id })) };
      }
      if (deposit) {
        const fail = (code) => { throw Object.assign(new Error('deposit query failed'), { code }); };
        if (sql === DEPOSIT_ITEMS_FOR_DELETE_SQL) {
          if (deposit.readError) fail(deposit.readError);
          return { rows: (deposit.items || []).map((item) => ({ item })) };
        }
        if (sql === DEPOSIT_QUEUE_AUDIT_FOR_DELETE_SQL) return { rows: (deposit.audit || []).map((entry) => ({ entry })) };
        const related = DEPOSIT_QUEUE_RELATED_BLOCKERS.find((row) => row.sql === sql);
        if (related) return { rows: deposit.related === related.table ? ANY_ROW : [] };
        if (/DELETE FROM public\.deposit_audit_log/.test(sql)) {
          if (deposit.deleteError) fail(deposit.deleteError);
          return { rows: (deposit.audit || []).map((entry) => ({ id: entry.id })) };
        }
        if (/DELETE FROM public\.deposit_items/.test(sql)) {
          if (deposit.deleteError) fail(deposit.deleteError);
          return { rows: (deposit.removedItems ?? deposit.items ?? []).map((item) => ({ id: item.id })) };
        }
      }
      if (/FROM public.check_intake_items/.test(sql) && /SELECT id, tenant_id/.test(sql)) return { rows: [check] };
      if (/SELECT \* FROM public.check_intake_items/.test(sql)) return { rows: [check] };
      for (const table of ['deposit_items', 'checkalt_deposits', 'disbursement_batches', 'claim_check_payments',
        'claim_payments', 'check_billing_events', 'check_payment_directions', 'claim_disbursements']) {
        if (new RegExp(`FROM public\\.${table}\\b`).test(sql)) return { rows: blockers[table] ? ANY_ROW : [] };
      }
      if (/FROM public.claim_checks cc\s+WHERE/.test(sql)) return { rows: blockers.claim_checks_terminal ? ANY_ROW : [] };
      if (/to_regclass\('public.check_deletion_log'\)/.test(sql)) return { rows: [{ t: 'check_deletion_log' }] };
      if (/DELETE FROM public.check_intake_items/.test(sql)) return { rows: [{ id: CHECK_ID }] };
      return { rows: [] };
    },
  };
};

const depsFor = (client) => ({
  forceWorkflow: true,
  disableS3Cleanup: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

const remove = (client) => handleDeleteCheck(jwtEvent({ check_id: CHECK_ID, reason: 'duplicate intake' }), depsFor(client));
const deleted = (client) => client.queries.some((q) => /DELETE FROM public\.check_intake_items/.test(q.sql));

test('a partner-ingested copy with no active share is deleted', async () => {
  const client = mockClient({ check: ingestedCheck });
  const result = await remove(client);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.deleted, true);
  assert.equal(deleted(client), true);
  assert.equal(client.queries.some((q) => /INSERT INTO public\.check_deletion_log/.test(q.sql)), true);
});

test('a shared check is deleted with its reason; sharing is never read or a blocker', async () => {
  const client = mockClient();
  const result = await remove(client);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.deleted, true);
  assert.equal(deleted(client), true);
  assert.equal(client.queries.some((q) => /shared_checks/.test(q.sql)), false);
});

test('a claim payment linked to a check in Review does not block (its link is ON DELETE SET NULL)', async () => {
  const client = mockClient({ check: { ...baseCheck, claim_id: CLAIM_ID }, blockers: { claim_payments: true } });
  const result = await remove(client);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(client.queries.some((q) => /FROM public\.claim_payments/.test(q.sql)), false);
  assert.equal(deleted(client), true);
});

const CHARGE = { id: '11111111-1111-4111-8111-111111111111', event_type: 'check_processing', status: 'recorded', unit_price_cents: 150, invoice_id: null, billed_at: '2026-11-10T00:00:00.000Z' };
const INVOICED_REVIEW = { id: '22222222-2222-4222-8222-222222222222', event_type: 'mortgage_handling', status: 'invoiced', unit_price_cents: 1000, invoice_id: 'inv_1', billed_at: '2026-11-11T00:00:00.000Z' };
const PROVISIONAL_REVIEW = { id: '33333333-3333-4333-8333-333333333333', event_type: 'mortgage_handling', status: 'reported', unit_price_cents: 1000, invoice_id: null, billed_at: '2026-11-12T00:00:00.000Z' };
const VOIDED = { id: '44444444-4444-4444-8444-444444444444', event_type: 'check_processing', status: 'voided', unit_price_cents: 150, invoice_id: null, billed_at: '2026-11-13T00:00:00.000Z' };
const snapshotOf = (client) => JSON.parse(client.queries.find((q) => /INSERT INTO public\.check_deletion_log/.test(q.sql)).params[7]);
const billingDelete = (client) => client.queries.find((q) => /DELETE FROM public\.check_billing_events/.test(q.sql));

test('the provisional rule is exactly the old non-blocking set: voided, or an uninvoiced mortgage_handling event', () => {
  assert.equal(isProvisionalBillingEvent(CHARGE), false);
  assert.equal(isProvisionalBillingEvent(INVOICED_REVIEW), false);
  assert.equal(isProvisionalBillingEvent({ ...PROVISIONAL_REVIEW, invoice_id: 'inv_2' }), false);
  assert.equal(isProvisionalBillingEvent({ ...PROVISIONAL_REVIEW, event_type: null }), false);
  assert.equal(isProvisionalBillingEvent(PROVISIONAL_REVIEW), true);
  assert.equal(isProvisionalBillingEvent({ ...PROVISIONAL_REVIEW, status: null }), true);
  assert.equal(isProvisionalBillingEvent(VOIDED), true);
});

test('a ChecksOps charge does not block: the check is deleted, the charge kept and listed in the deletion log', async () => {
  const client = mockClient({ billing: [CHARGE, INVOICED_REVIEW] });
  const result = await remove(client);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(deleted(client), true);
  // Nothing to remove: the money-write flag is not set and no billing row is deleted.
  assert.equal(billingDelete(client), undefined);
  assert.equal(client.queries.some((q) => q.sql === SET_MONEY_WRITE_SQL), false);
  assert.deepEqual(snapshotOf(client).billing_events_kept, [CHARGE, INVOICED_REVIEW]);
  assert.equal(snapshotOf(client).id, CHECK_ID);
  // check_billing_events is read once, never as a blocker.
  assert.equal(client.queries.filter((q) => /FROM public\.check_billing_events/.test(q.sql) && !/DELETE/.test(q.sql)).length, 1);
});

test('the provisional rows go with the check under the money-write flag; the charges stay', async () => {
  const client = mockClient({ billing: [CHARGE, PROVISIONAL_REVIEW, VOIDED] });
  const result = await remove(client);
  assert.equal(result.ok, true, JSON.stringify(result));
  const del = billingDelete(client);
  assert.deepEqual(del.params, [CHECK_ID, [PROVISIONAL_REVIEW.id, VOIDED.id]]);
  assert.match(del.sql, /e\.status = 'voided'/);
  assert.match(del.sql, /e\.event_type = 'mortgage_handling'/);
  assert.match(del.sql, /e\.status IS DISTINCT FROM 'invoiced'/);
  assert.match(del.sql, /to_jsonb\(e\)->>'invoice_id' IS NULL/);
  const flag = client.queries.findIndex((q) => q.sql === SET_MONEY_WRITE_SQL);
  const at = client.queries.indexOf(del);
  const save = client.queries.findIndex((q) => q.sql === 'SAVEPOINT delete_billing_events');
  assert.ok(save >= 0 && save < flag && flag < at, 'savepoint, then flag, then delete');
  assert.ok(at < client.queries.findIndex((q) => /DELETE FROM public\.check_intake_items/.test(q.sql)));
  assert.deepEqual(snapshotOf(client).billing_events_kept, [CHARGE]);
  assert.equal(deleted(client), true);
});

test('a provisional row that could not be removed refuses the delete (no stray charge outlives its check)', async () => {
  const client = mockClient({ billing: [PROVISIONAL_REVIEW, VOIDED], removeOnly: [VOIDED.id] });
  const result = await remove(client);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'billing_cleanup_incomplete');
  assert.equal(deleted(client), false);
  assert.ok(client.queries.some((q) => q.sql === 'ROLLBACK TO SAVEPOINT delete_billing_events'));
});

test('a refused billing read or delete (42501) refuses the delete; a missing table settles nothing', async () => {
  const deniedClient = mockClient({ billingError: '42501' });
  const refused = await remove(deniedClient);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'billing_cleanup_denied');
  assert.equal(deleted(deniedClient), false);
  const absent = mockClient({ billingError: '42P01' });
  const ok = await remove(absent);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(snapshotOf(absent).billing_events_kept, []);
});

for (const table of ['deposit_items', 'checkalt_deposits', 'disbursement_batches', 'claim_check_payments',
  'check_payment_directions', 'claim_disbursements', 'claim_checks_terminal']) {
  test(`real money records still block: ${table}`, async () => {
    const client = mockClient({ check: ingestedCheck, blockers: { [table]: true } });
    const result = await remove(client);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'check_has_financial_activity');
    assert.equal(result.blocker, table);
    assert.equal(deleted(client), false);
  });
}

test('a deposited check is still refused as terminal', async () => {
  const client = mockClient({ check: { ...baseCheck, status: 'deposited', check_stage: 'deposited', deposited_at: '2026-10-01' } });
  const result = await remove(client);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'check_terminal_financial_state');
  assert.equal(deleted(client), false);
});

const QUEUE_ITEM = {
  id: 'd1000000-0000-4000-8000-00000000000a', check_id: CHECK_ID, status: 'pending_assignment', amount: 1250,
  check_number: '1001', batch_id: null, provider: null, submitted_at: null, cleared_at: null, variance_amount: 0,
  nsf_flag: false, closeout_complete: false, owner_id: APP_ID, next_action: 'assign provider',
  created_at: '2026-11-15T00:00:00.000Z',
};
const QUEUE_AUDIT = { id: 'da000000-0000-4000-8000-00000000000a', deposit_item_id: QUEUE_ITEM.id, action: 'prepare_deposit', actor_id: APP_ID, amount: 1250, notes: 'queued' };
const depositDeletes = (client) => client.queries.filter((q) => /DELETE FROM public\.deposit_(items|audit_log)/.test(q.sql));

test('the queue-only rule: pending_assignment and nothing set beyond the queue; anything else is named', () => {
  assert.deepEqual(depositQueueProgress(QUEUE_ITEM), []);
  // Queue management fields (owner, next action) are not progress.
  assert.deepEqual(depositQueueProgress({ id: QUEUE_ITEM.id, status: 'pending_assignment' }), []);
  assert.deepEqual(depositQueueProgress({ ...QUEUE_ITEM, status: 'provider_assigned', provider: 'manual_branch', batch_id: 'b1' }),
    ['status:provider_assigned', 'batch_id', 'provider']);
  for (const field of DEPOSIT_QUEUE_PROGRESS_FIELDS) {
    assert.deepEqual(depositQueueProgress({ ...QUEUE_ITEM, [field]: 'x' }), [field], field);
  }
  assert.deepEqual(depositQueueProgress({ ...QUEUE_ITEM, nsf_flag: true }), ['nsf_flag']);
  assert.deepEqual(depositQueueProgress({ ...QUEUE_ITEM, closeout_complete: true }), ['closeout_complete']);
  assert.deepEqual(depositQueueProgress({ ...QUEUE_ITEM, variance_amount: '5.00' }), ['variance_amount']);
  assert.deepEqual(depositQueueProgress({ ...QUEUE_ITEM, variance_amount: '0.00' }), []);
  // A row that cannot be read as a deposit record never counts as queue-only.
  for (const row of [undefined, null, {}, { '?column?': 1 }]) assert.deepEqual(depositQueueProgress(row), ['unreadable']);
  // Batch, provider, submission, reconciliation, clearing, exception, NSF and closeout data are all covered.
  for (const field of ['batch_id', 'provider', 'provider_reference', 'submitted_at', 'reconciled_at', 'reconciled_amount',
    'cleared_at', 'exception_reason', 'exception_code', 'return_reason', 'closeout_at']) {
    assert.ok(DEPOSIT_QUEUE_PROGRESS_FIELDS.includes(field), field);
  }
});

test('a deposit record that never left the queue does not block: it and its prepare_deposit audit row go with the check and are listed in the deletion log', async () => {
  const client = mockClient({ deposit: { items: [QUEUE_ITEM], audit: [QUEUE_AUDIT] } });
  const result = await remove(client);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(deleted(client), true);
  const [auditDelete, itemDelete] = depositDeletes(client);
  assert.match(auditDelete.sql, /DELETE FROM public\.deposit_audit_log/);
  assert.match(auditDelete.sql, /a\.action = 'prepare_deposit'/);
  assert.deepEqual(auditDelete.params, [[QUEUE_ITEM.id]]);
  // The DELETE repeats the queue-only test and is bound to this check.
  assert.match(itemDelete.sql, /di\.status = 'pending_assignment'/);
  assert.match(itemDelete.sql, /di\.batch_id IS NULL/);
  assert.match(itemDelete.sql, /di\.provider IS NULL/);
  assert.match(itemDelete.sql, /di\.submitted_at IS NULL/);
  assert.match(itemDelete.sql, /di\.cleared_at IS NULL/);
  assert.deepEqual(itemDelete.params, [[QUEUE_ITEM.id], CHECK_ID]);
  // Read and every related-record check first, then the removal inside its savepoint, then the check.
  const at = (q) => client.queries.indexOf(q);
  const save = client.queries.findIndex((q) => q.sql === 'SAVEPOINT delete_deposit_queue');
  const lastRelated = Math.max(...DEPOSIT_QUEUE_RELATED_BLOCKERS.map((row) => client.queries.findIndex((q) => q.sql === row.sql)));
  assert.ok(lastRelated >= 0 && lastRelated < save && save < at(auditDelete) && at(auditDelete) < at(itemDelete));
  assert.ok(at(itemDelete) < client.queries.findIndex((q) => /DELETE FROM public\.check_intake_items/.test(q.sql)));
  for (const row of DEPOSIT_QUEUE_RELATED_BLOCKERS) assert.ok(client.queries.some((q) => q.sql === row.sql), row.table);
  assert.deepEqual(snapshotOf(client).deposit_queue_removed, { deposit_items: [QUEUE_ITEM], deposit_audit_log: [QUEUE_AUDIT] });
  assert.deepEqual(snapshotOf(client).billing_events_kept, []);
});

test('a check with no deposit record deletes as before and the deletion log lists none', async () => {
  const client = mockClient({ deposit: { items: [] } });
  const result = await remove(client);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(depositDeletes(client), []);
  assert.equal(client.queries.some((q) => q.sql === 'SAVEPOINT delete_deposit_queue'), false);
  assert.deepEqual(snapshotOf(client).deposit_queue_removed, { deposit_items: [], deposit_audit_log: [] });
});

test('a deposit record that left the queue still blocks and the refusal names what it reached', async () => {
  const assigned = { ...QUEUE_ITEM, status: 'provider_assigned', provider: 'manual_branch', batch_id: 'b1000000-0000-4000-8000-000000000001' };
  const client = mockClient({ deposit: { items: [assigned], audit: [QUEUE_AUDIT] } });
  const result = await remove(client);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'check_has_financial_activity');
  assert.equal(result.blocker, 'deposit_items');
  assert.deepEqual(result.reached, ['status:provider_assigned', 'batch_id', 'provider']);
  assert.equal(deleted(client), false);
  assert.deepEqual(depositDeletes(client), []);
});

for (const table of DEPOSIT_QUEUE_RELATED_BLOCKERS.map((row) => row.table)) {
  test(`a queue record with a related deposit record still blocks: ${table}`, async () => {
    const client = mockClient({ deposit: { items: [QUEUE_ITEM], audit: [QUEUE_AUDIT], related: table } });
    const result = await remove(client);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'check_has_financial_activity');
    assert.equal(result.blocker, table);
    assert.equal(result.reached, undefined);
    assert.equal(deleted(client), false);
    assert.deepEqual(depositDeletes(client), []);
  });
}

test('a deposit record the API role may not delete refuses the delete cleanly; nothing is removed', async () => {
  for (const [deposit, error] of [
    [{ items: [QUEUE_ITEM], audit: [QUEUE_AUDIT], deleteError: '42501' }, 'deposit_cleanup_denied'],
    [{ items: [QUEUE_ITEM], audit: [QUEUE_AUDIT], deleteError: '23503' }, 'deposit_cleanup_denied'],
    // RLS without a DELETE policy: the DELETE removes 0 rows.
    [{ items: [QUEUE_ITEM], audit: [QUEUE_AUDIT], removedItems: [] }, 'deposit_cleanup_incomplete'],
  ]) {
    const client = mockClient({ deposit });
    const result = await remove(client);
    assert.equal(result.ok, false, error);
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, error);
    assert.equal(result.blocker, 'deposit_items');
    assert.equal(deleted(client), false);
    assert.ok(client.queries.some((q) => q.sql === 'ROLLBACK TO SAVEPOINT delete_deposit_queue'), error);
    // The refusal rolls the whole write transaction back (data.mjs withIdentity): no COMMIT.
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
    assert.equal(client.queries.at(-1).sql, 'ROLLBACK');
  }
});

test('deposit records that cannot be read refuse the delete; a schema without the table has nothing to remove', async () => {
  const refused = await remove(mockClient({ deposit: { readError: '42501' } }));
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'blocker_verification_denied');
  assert.equal(refused.blocker, 'deposit_items');
  const absent = mockClient({ deposit: { readError: '42P01' } });
  const ok = await remove(absent);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(depositDeletes(absent), []);
});
