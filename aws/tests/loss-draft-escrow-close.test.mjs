/**
 * Owner decisions of 2026-10-30 for loss_draft_action (POST /data/rpc):
 * 1. A monitored loss draft never goes to Endorsing: the bank deposits the check and the
 *    file stays open in Loss Draft to document escrow and disbursements.
 * 2. Not monitored: once the endorsed back of the check is uploaded (back_image_reuploaded),
 *    send_for_endorsements moves the check to Endorsing and closes the file, from any open
 *    state, without the received-back step first.
 * 3. Override "Review" always closes the file and returns the check to Review
 *    (needs_review / review, as return_to_review); "Endorsing" only when not monitored.
 * 4. mark_escrowed, request_draw, record_release, record_holdback and mark_final_release
 *    record amounts on a monitored file (no money moves), with validated amounts, the tenant
 *    gate and audit rows; record_release also lists the draw in loss_draft_releases.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENDORSED_BACK_IMAGE_SQL,
  LOSS_DRAFT_ESCROW_ACTIONS,
  LOSS_DRAFT_REVIEW_TARGET,
  LOSS_DRAFT_TENANT_SQL,
  SAFE_LOSS_DRAFT_ACTIONS,
  TENANT_MEMBER_SQL,
  executeSafeWriteRpc,
  parseLossDraftAmount,
} from '../functions/api/workflow-rpc.mjs';

const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const DRAFT_ID = '9e3c2d4f-5a6b-4789-abcd-ef0123456789';
const mapping = { application_user_id: USER };

const fake = ({
  monitoring = 'monitored',
  status = 'escrowed',
  memberOf = TENANT,
  backImageOnFile = false,
  checkMoves = true,
  checkId = CHECK_ID,
  releaseInsertFails = false,
  draftExtra = {},
} = {}) => {
  const queries = [];
  const client = {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === TENANT_MEMBER_SQL) {
        return { rows: params[0] === USER && params[1] === memberOf ? [{ '?column?': 1 }] : [] };
      }
      if (sql === LOSS_DRAFT_TENANT_SQL) return { rows: [{ tenant_id: TENANT }] };
      if (sql === ENDORSED_BACK_IMAGE_SQL) return { rows: backImageOnFile ? [{ '?column?': 1 }] : [] };
      if (/SELECT \* FROM public\.loss_draft_tracking WHERE id = \$1::uuid FOR UPDATE/.test(sql)) {
        return {
          rows: [{
            id: DRAFT_ID,
            check_intake_item_id: checkId,
            escrow_status: status,
            monitoring_type: monitoring,
            total_escrowed: '1000.00',
            draw_amount_released: '0.00',
            holdback_amount: '0.00',
            ...draftExtra,
          }],
        };
      }
      if (/UPDATE public\.check_intake_items/.test(sql) && /RETURNING id/.test(sql)) {
        return { rows: checkMoves ? [{ id: CHECK_ID }] : [] };
      }
      if (/INSERT INTO public\.loss_draft_releases/.test(sql) && releaseInsertFails) {
        const error = new Error('permission denied for table loss_draft_releases');
        error.code = '42501';
        throw error;
      }
      if (/SELECT escrow_status, monitoring_type, total_escrowed/.test(sql)) {
        return { rows: [{ escrow_status: 'escrowed', monitoring_type: monitoring }] };
      }
      return { rows: [] };
    },
  };
  return client;
};

const call = (client, action, { amount = null, extra = {}, notes = null } = {}) => executeSafeWriteRpc({
  client,
  mapping,
  name: 'loss_draft_action',
  args: { p_loss_draft_id: DRAFT_ID, p_action: action, p_amount: amount, p_notes: notes, p_extra: extra },
});

const writes = (client) => client.queries.filter((q) => /^\s*(UPDATE|INSERT|DELETE)/.test(q.sql));
const find = (client, re) => client.queries.find((q) => re.test(q.sql));

// --- amounts -------------------------------------------------------------------

test('parseLossDraftAmount: positive dollars and cents that fit numeric(12,2), no rounding', () => {
  assert.equal(parseLossDraftAmount(1000), '1000.00');
  assert.equal(parseLossDraftAmount('1000.5'), '1000.50');
  assert.equal(parseLossDraftAmount(' 25000.75 '), '25000.75');
  assert.equal(parseLossDraftAmount('0.01'), '0.01');
  assert.equal(parseLossDraftAmount('007.10'), '7.10');
  assert.equal(parseLossDraftAmount('9999999999.99'), '9999999999.99');
  for (const bad of [null, undefined, '', 0, '0', '0.00', -5, '-5', '1.005', 0.1 + 0.2, '1e5', 1e21,
    '10000000000', 'abc', '12,000', Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
    assert.equal(parseLossDraftAmount(bad), null, String(bad));
  }
});

test('the escrow actions are bridged and every other action is still refused', () => {
  for (const action of ['mark_escrowed', 'request_draw', 'record_release', 'record_holdback', 'mark_final_release']) {
    assert.ok(SAFE_LOSS_DRAFT_ACTIONS.has(action), action);
    assert.ok(LOSS_DRAFT_ESCROW_ACTIONS.has(action), action);
  }
  assert.equal(LOSS_DRAFT_REVIEW_TARGET, 'review');
});

for (const action of ['mark_escrowed', 'request_draw', 'record_release', 'record_holdback']) {
  test(`${action}: an invalid amount is refused before any read or write`, async () => {
    for (const amount of [null, 0, -1, '1.234', 'abc']) {
      const client = fake();
      const result = await call(client, action, { amount });
      assert.equal(result.error, 'invalid_field', `${action} ${amount}`);
      assert.equal(result.field, 'p_amount');
      assert.equal(client.queries.length, 0);
    }
  });
}

// --- escrow and draw records ---------------------------------------------------

test('mark_escrowed records total_escrowed and the escrowed status, then the audit row with the amount', async () => {
  const client = fake({ status: 'sent_to_lender' });
  const result = await call(client, 'mark_escrowed', { amount: '25000.5', notes: 'Lender confirmed' });
  assert.equal(result.error, undefined);
  const update = find(client, /UPDATE public\.loss_draft_tracking/);
  assert.match(update.sql, /escrow_status = 'escrowed'/);
  assert.match(update.sql, /total_escrowed = \$2::numeric/);
  assert.match(update.sql, /check_received_date = COALESCE\(check_received_date, CURRENT_DATE\)/);
  assert.deepEqual(update.params, [DRAFT_ID, '25000.50']);
  const audit = find(client, /INSERT INTO public\.loss_draft_audit_log/);
  assert.deepEqual(audit.params.slice(0, 5), [DRAFT_ID, 'mark_escrowed', USER, '25000.50', 'Lender confirmed']);
  assert.equal(JSON.parse(audit.params[5]).total_escrowed, '1000.00');
  assert.equal(find(client, /UPDATE public\.check_intake_items|check_audit_log/), undefined, 'no check move');
});

test('request_draw adds to draw_amount_requested and the draw stage', async () => {
  const client = fake();
  assert.equal((await call(client, 'request_draw', { amount: 5000 })).error, undefined);
  const update = find(client, /UPDATE public\.loss_draft_tracking/);
  assert.match(update.sql, /escrow_status = 'first_draw_requested'/);
  assert.match(update.sql, /draw_amount_requested = COALESCE\(draw_amount_requested, 0\) \+ \$2::numeric/);
  assert.match(update.sql, /draw_stage = draw_stage \+ 1/);
  assert.deepEqual(update.params, [DRAFT_ID, '5000.00']);
});

test('record_release adds to draw_amount_released (final when it reaches the escrow) and lists the draw', async () => {
  const client = fake({ status: 'first_draw_requested' });
  const result = await call(client, 'record_release', { amount: '400.25', notes: 'Draw 1' });
  assert.deepEqual(result, { data: { release_recorded: true } });
  const update = find(client, /UPDATE public\.loss_draft_tracking/);
  assert.match(update.sql, /THEN 'final_release_complete'\s+ELSE 'partial_release'/);
  assert.match(update.sql, /draw_amount_released = COALESCE\(draw_amount_released, 0\) \+ \$2::numeric/);
  const release = find(client, /INSERT INTO public\.loss_draft_releases/);
  assert.match(release.sql, /COALESCE\(MAX\(r\.draw_number\), 0\) \+ 1/);
  assert.match(release.sql, /'released'/);
  assert.deepEqual(release.params, [DRAFT_ID, '400.25', 'Draw 1', USER]);
  const order = client.queries.map((q) => q.sql);
  const sp = order.indexOf('SAVEPOINT loss_draft_release_row');
  assert.ok(sp > -1 && order[sp + 2] === 'RELEASE SAVEPOINT loss_draft_release_row');
  assert.ok(find(client, /INSERT INTO public\.loss_draft_audit_log/));
});

test('record_release: a refused loss_draft_releases insert rolls back to its savepoint and keeps the recorded amount', async () => {
  const client = fake({ status: 'partial_release', releaseInsertFails: true });
  const result = await call(client, 'record_release', { amount: 100 });
  assert.deepEqual(result, { data: { release_recorded: false } });
  assert.ok(client.queries.some((q) => q.sql === 'ROLLBACK TO SAVEPOINT loss_draft_release_row'));
  assert.ok(find(client, /INSERT INTO public\.loss_draft_audit_log/), 'the audit row is still written');
});

test('record_holdback sets holdback_amount; mark_final_release releases the escrowed total', async () => {
  const hold = fake();
  assert.equal((await call(hold, 'record_holdback', { amount: '750' })).error, undefined);
  const holdUpdate = find(hold, /UPDATE public\.loss_draft_tracking/);
  assert.match(holdUpdate.sql, /holdback_amount = \$2::numeric/);
  assert.doesNotMatch(holdUpdate.sql, /escrow_status/);
  assert.deepEqual(holdUpdate.params, [DRAFT_ID, '750.00']);

  const final = fake({ status: 'partial_release' });
  assert.equal((await call(final, 'mark_final_release')).error, undefined);
  const finalUpdate = find(final, /UPDATE public\.loss_draft_tracking/);
  assert.match(finalUpdate.sql, /escrow_status = 'final_release_complete'/);
  assert.match(finalUpdate.sql, /draw_amount_released = COALESCE\(total_escrowed, draw_amount_released\)/);
  assert.equal(find(final, /INSERT INTO public\.loss_draft_audit_log/).params[3], null);
});

for (const action of ['mark_escrowed', 'record_release', 'mark_final_release']) {
  test(`${action}: refused on a not-monitored file, a closed file and for a non-member, with no write`, async () => {
    const amount = action === 'mark_final_release' ? null : 10;
    const notMonitored = fake({ monitoring: 'not_monitored' });
    assert.equal((await call(notMonitored, action, { amount })).error, 'not_monitored_no_escrow');
    assert.deepEqual(writes(notMonitored), []);
    const closed = fake({ status: 'final_release_complete' });
    assert.equal((await call(closed, action, { amount })).error, 'loss_draft_closed');
    assert.deepEqual(writes(closed), []);
    const partner = fake({ memberOf: OTHER_TENANT });
    assert.equal((await call(partner, action, { amount })).error, 'not_authorized');
    assert.deepEqual(writes(partner), []);
  });
}

// --- send to Endorsing -----------------------------------------------------------

test('send_for_endorsements: a monitored file is refused, from every state, with no write', async () => {
  for (const status of ['pending_send', 'sent_to_lender', 'escrowed', 'check_received_back']) {
    const client = fake({ monitoring: 'monitored', status, backImageOnFile: true });
    const result = await call(client, 'send_for_endorsements');
    assert.equal(result.error, 'monitored_no_endorsing', status);
    assert.deepEqual(writes(client), [], status);
  }
  // A null monitoring type is monitored (the Actions tab reads it the same way).
  const legacy = fake({ monitoring: null, status: 'check_received_back' });
  assert.equal((await call(legacy, 'send_for_endorsements')).error, 'monitored_no_endorsing');
});

test('send_for_endorsements: not monitored with the endorsed back on file moves the check and closes the file from any open state', async () => {
  for (const status of ['pending_send', 'sent_to_lender', 'received_by_lender']) {
    const client = fake({ monitoring: 'not_monitored', status, backImageOnFile: true });
    const result = await call(client, 'send_for_endorsements', { notes: 'Endorsed by lender' });
    assert.equal(result.error, undefined, status);
    const tracking = find(client, /UPDATE public\.loss_draft_tracking/);
    assert.match(tracking.sql, /escrow_status = 'endorsing'/);
    assert.match(tracking.sql, /check_received_back_date = COALESCE\(check_received_back_date, CURRENT_DATE\)/);
    const check = find(client, /UPDATE public\.check_intake_items/);
    assert.match(check.sql, /status = 'endorsements_in_progress'/);
    assert.match(check.sql, /check_stage = 'endorsing'/);
    assert.match(check.sql, /deposited_at IS NULL/);
    assert.deepEqual(check.params, [CHECK_ID]);
    const checkAudit = find(client, /INSERT INTO public\.check_audit_log/);
    assert.equal(checkAudit.params[2], 'loss_draft_sent_to_endorsing');
    assert.deepEqual(JSON.parse(checkAudit.params[4]), { loss_draft_id: DRAFT_ID, prior_escrow_status: status, check_moved: true });
    assert.equal(find(client, /INSERT INTO public\.loss_draft_audit_log/).params[1], 'send_for_endorsements');
    assert.equal(find(client, /DELETE FROM/), undefined, 'the file is closed by its status, not deleted');
  }
});

test('send_for_endorsements: not monitored without the endorsed back image is refused unless received back', async () => {
  const missing = fake({ monitoring: 'not_monitored', status: 'sent_to_lender', backImageOnFile: false });
  assert.equal((await call(missing, 'send_for_endorsements')).error, 'endorsed_back_image_required');
  assert.deepEqual(writes(missing), []);
  const receivedBack = fake({ monitoring: 'not_monitored', status: 'check_received_back', backImageOnFile: false });
  assert.equal((await call(receivedBack, 'send_for_endorsements')).error, undefined);
  assert.equal(receivedBack.queries.some((q) => q.sql === ENDORSED_BACK_IMAGE_SQL), false);
  const closed = fake({ monitoring: 'not_monitored', status: 'endorsing', backImageOnFile: true });
  assert.equal((await call(closed, 'send_for_endorsements')).error, 'loss_draft_closed');
  const partner = fake({ monitoring: 'not_monitored', status: 'check_received_back', memberOf: OTHER_TENANT });
  assert.equal((await call(partner, 'send_for_endorsements')).error, 'not_authorized');
  assert.deepEqual(writes(partner), []);
});

test('ENDORSED_BACK_IMAGE_SQL reads the back_image_reuploaded event of the draft check', () => {
  assert.match(ENDORSED_BACK_IMAGE_SQL, /FROM public\.check_audit_log/);
  assert.match(ENDORSED_BACK_IMAGE_SQL, /check_id = \$1::uuid AND event_type = 'back_image_reuploaded'/);
});

// --- override ----------------------------------------------------------------------

test('override Review: closes the file and returns the check to Review, monitored or not', async () => {
  for (const monitoring of ['monitored', 'not_monitored']) {
    const client = fake({ monitoring, status: 'escrowed' });
    const result = await call(client, 'admin_reset_status', {
      extra: { target_status: 'review' },
      notes: 'Wrong lane',
    });
    assert.deepEqual(result, { data: null }, monitoring);
    const check = find(client, /UPDATE public\.check_intake_items/);
    assert.match(check.sql, /status = 'needs_review'/);
    assert.match(check.sql, /check_stage = 'review'/);
    assert.match(check.sql, /deposited_at IS NULL/);
    const audit = find(client, /INSERT INTO public\.check_audit_log/);
    assert.equal(audit.params[2], 'loss_draft_returned_to_review');
    assert.deepEqual(JSON.parse(audit.params[4]), {
      loss_draft_id: DRAFT_ID, prior_escrow_status: 'escrowed', monitoring_type: monitoring, check_moved: true, notes: 'Wrong lane',
    });
    const deletes = client.queries.filter((q) => /^DELETE FROM/.test(q.sql)).map((q) => q.sql);
    assert.deepEqual(deletes, [
      'DELETE FROM public.loss_draft_audit_log WHERE loss_draft_id = $1::uuid',
      'DELETE FROM public.loss_draft_documents WHERE loss_draft_id = $1::uuid',
      'DELETE FROM public.loss_draft_tracking WHERE id = $1::uuid',
    ]);
    assert.equal(find(client, /UPDATE public\.loss_draft_tracking/), undefined);
  }
});

test('override Review on a deposited check still closes the file and records that the check did not move', async () => {
  const client = fake({ checkMoves: false });
  assert.deepEqual(await call(client, 'admin_reset_status', { extra: { target_status: 'review' } }), { data: null });
  const audit = find(client, /INSERT INTO public\.check_audit_log/);
  assert.equal(JSON.parse(audit.params[4]).check_moved, false);
  assert.match(audit.params[3], /did not move/);
  assert.ok(find(client, /DELETE FROM public\.loss_draft_tracking/));
});

test('override Endorsing: refused for a monitored file; not monitored moves the check and removes the file', async () => {
  const monitored = fake({ monitoring: 'monitored' });
  assert.equal((await call(monitored, 'admin_reset_status', { extra: { target_status: 'endorsing' } })).error, 'monitored_no_endorsing');
  assert.deepEqual(writes(monitored), []);
  const notMonitored = fake({ monitoring: 'not_monitored', status: 'sent_to_lender' });
  assert.deepEqual(await call(notMonitored, 'admin_reset_status', { extra: { target_status: 'endorsing' } }), { data: null });
  assert.match(find(notMonitored, /UPDATE public\.check_intake_items/).sql, /check_stage = 'endorsing'/);
  assert.equal(find(notMonitored, /INSERT INTO public\.check_audit_log/).params[2], 'loss_draft_moved_to_endorsing');
  assert.ok(find(notMonitored, /DELETE FROM public\.loss_draft_tracking/));
});

test('override: Loss Draft (escrowed), Reissue and Void targets stay refused; a partner cannot override', async () => {
  for (const target of ['escrowed', 'pending_reissue', 'void', 'final_release_complete']) {
    const client = fake();
    const result = await call(client, 'admin_reset_status', { extra: { target_status: target } });
    assert.equal(result.error, 'rpc_financial_disabled', target);
    assert.deepEqual(writes(client), [], target);
  }
  const partner = fake({ memberOf: OTHER_TENANT });
  assert.equal((await call(partner, 'admin_reset_status', { extra: { target_status: 'review' } })).error, 'not_authorized');
  assert.deepEqual(writes(partner), []);
});
