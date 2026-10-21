/**
 * Production Moov transfer status write-back (aws/functions/api/providers/moov-transfer-webhook.mjs
 * and its dispatch in providers/webhooks.mjs). Fake database clients only; no provider call.
 * The real SQL 107 writer on PostgreSQL 16 is aws/tests/sql107-moov-transfer-webhook-status-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TRANSFER_STATUS_WRITER_SQL,
  applyProductionMoovTransferWebhook,
  extractAchOutcome,
  interpretMoovTransferEvent,
  isMoovTransferEvent,
  mapMoovTransferStatus,
  productionTransferWebhookApplyEnabled,
} from '../functions/api/providers/moov-transfer-webhook.mjs';
import { handleProviderWebhook } from '../functions/api/providers/webhooks.mjs';
import { hmacHex } from '../functions/api/providers/hmac.mjs';
import {
  isBouncedTransferStatus,
  transferDisplayStatus,
  transferIssueText,
} from '../../src/lib/payments/transferReturn.ts';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const TRANSFER = '55555555-5555-4555-8555-555555555555';

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
const PRODUCTION_ENV = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_PROVIDER_WEBHOOK_DRY_RUN: 'false',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
};
const silent = () => {
  const lines = [];
  return { lines, warn: (line) => lines.push(JSON.parse(line)) };
};

/** A fake webhook transaction: records statements; the writer answers `result` (or throws). */
function fakeClient({ result = null, writerError = null } = {}) {
  const calls = [];
  const gucs = [];
  return {
    calls,
    gucs,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      const m = /set_config\('([a-z_.]+)', '([^']*)', true\)/.exec(String(sql));
      if (m) gucs.push([m[1], m[2]]);
      if (sql === TRANSFER_STATUS_WRITER_SQL) {
        if (writerError) throw writerError;
        return { rows: [{ result }] };
      }
      return { rows: [] };
    },
  };
}
const writerCall = (client) => client.calls.find((c) => c.sql === TRANSFER_STATUS_WRITER_SQL);

test('status mapping: Moov transfer statuses onto payment_transfers statuses', () => {
  assert.deepEqual(
    ['created', 'queued', 'pending', 'completed', 'failed', 'reversed', 'returned', 'canceled', 'cancelled', 'CANCELED', '', 'mystery', null]
      .map(mapMoovTransferStatus),
    ['submitted', 'submitted', 'pending', 'completed', 'failed', 'returned', 'returned', 'canceled', 'canceled', 'canceled', null, null, null],
  );
  assert.equal(isMoovTransferEvent('transfer.updated'), true);
  assert.equal(isMoovTransferEvent('transfer.created'), true);
  assert.equal(isMoovTransferEvent('account.updated'), false);
  assert.equal(isMoovTransferEvent('bankAccount.updated'), false);
  assert.equal(isMoovTransferEvent(undefined), false);
});

test('return codes and NOCs: either leg or a flat field, normalized; anything not R## / C## ignored', () => {
  assert.deepEqual(extractAchOutcome({ source: { achDetails: { status: 'returned', return: { code: 'R01', reason: 'Insufficient funds' } } } }), {
    returnCode: 'R01', returnReason: 'Insufficient funds', correctionCode: null, correctionReason: null, achReturned: true,
  });
  const dest = extractAchOutcome({ destination: { achDetails: { return: { code: 'r10', description: 'Customer advises not authorized' } } } });
  assert.equal(dest.returnCode, 'R10');
  assert.equal(dest.returnReason, 'Customer advises not authorized');
  assert.equal(extractAchOutcome({ returnCode: 'R02' }).returnCode, 'R02');
  assert.equal(extractAchOutcome({ return: { code: 'X99' } }).returnCode, null);
  assert.equal(extractAchOutcome({ return: { code: 'R1' } }).returnCode, null);
  const noc = extractAchOutcome({ source: { achDetails: { status: 'corrected', correction: { code: 'C01', reason: 'Incorrect account number' } } } });
  assert.deepEqual([noc.correctionCode, noc.correctionReason, noc.returnCode, noc.achReturned], ['C01', 'Incorrect account number', null, false]);
  // The transfer's own status 'returned' is not an ACH leg status.
  assert.equal(extractAchOutcome({ status: 'returned' }).achReturned, false);
  // Source wins over destination.
  assert.equal(extractAchOutcome({ source: { achDetails: { return: { code: 'R01' } } }, destination: { achDetails: { return: { code: 'R03' } } } }).returnCode, 'R01');
});

test('interpreting a transfer.* event: a return wins over a completed or failed status; event-type fallback; completion time only when completed', () => {
  const completedThenReturned = interpretMoovTransferEvent({
    type: 'transfer.updated',
    data: { transferID: 'tr_1', status: 'completed', completedOn: '2026-10-21T15:00:00Z', source: { achDetails: { status: 'returned', return: { code: 'R01', reason: 'Insufficient funds' } } } },
  });
  assert.equal(completedThenReturned.status, 'returned');
  assert.equal(completedThenReturned.providerStatus, 'completed');
  assert.equal(completedThenReturned.returnCode, 'R01');
  assert.equal(completedThenReturned.completedAt, null);
  const failedWithReturn = interpretMoovTransferEvent({ type: 'transfer.updated', data: { transferID: 'tr_1', status: 'failed', source: { achDetails: { return: { code: 'R10' } } } } });
  assert.equal(failedWithReturn.status, 'returned');
  const plainFailure = interpretMoovTransferEvent({ type: 'transfer.updated', data: { transferID: 'tr_1', status: 'failed' } });
  assert.equal(plainFailure.status, 'failed');
  assert.equal(plainFailure.returnCode, null);
  const reversed = interpretMoovTransferEvent({ type: 'transfer.updated', data: { transferID: 'tr_1', status: 'reversed' } });
  assert.equal(reversed.status, 'returned');
  const canceledWithLegReturn = interpretMoovTransferEvent({ type: 'transfer.updated', data: { transferID: 'tr_1', status: 'canceled', source: { achDetails: { status: 'returned' } } } });
  assert.equal(canceledWithLegReturn.status, 'canceled');
  const done = interpretMoovTransferEvent({ type: 'transfer.updated', data: { transferID: 'tr_1', status: 'completed', completedOn: '2026-10-21T15:00:00Z' } });
  assert.equal(done.status, 'completed');
  assert.equal(done.completedAt, '2026-10-21T15:00:00.000Z');
  const byType = interpretMoovTransferEvent({ type: 'transfer.failed', data: { transferID: 'tr_1' } });
  assert.deepEqual([byType.providerStatus, byType.status], ['failed', 'failed']);
  const noc = interpretMoovTransferEvent({ type: 'transfer.updated', data: { transferID: 'tr_1', status: 'pending', source: { achDetails: { correction: { code: 'C02' } } } } });
  assert.deepEqual([noc.status, noc.correctionCode], ['pending', 'C02']);
  assert.equal(interpretMoovTransferEvent({ type: 'transfer.updated', data: {} }).providerTransferId, null);
  // The payload never names a tenant: nothing tenant-shaped is read.
  const spoof = interpretMoovTransferEvent({ type: 'transfer.updated', tenant_id: OTHER_TENANT, data: { transferID: 'tr_1', status: 'failed', tenantId: OTHER_TENANT } });
  assert.ok(!JSON.stringify(spoof).includes(OTHER_TENANT));
});

test('production switch: the existing production switches only; off in dry-run, sandbox execution or without Moov', async () => {
  await withEnv(PRODUCTION_ENV, async () => assert.equal(productionTransferWebhookApplyEnabled(), true));
  await withEnv({ ...PRODUCTION_ENV, AWS_PROVIDER_WEBHOOK_DRY_RUN: undefined }, async () => assert.equal(productionTransferWebhookApplyEnabled(), false));
  await withEnv({ ...PRODUCTION_ENV, AWS_PROVIDER_WEBHOOK_DRY_RUN: 'true' }, async () => assert.equal(productionTransferWebhookApplyEnabled(), false));
  await withEnv({ ...PRODUCTION_ENV, AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => assert.equal(productionTransferWebhookApplyEnabled(), false));
  await withEnv({ ...PRODUCTION_ENV, AWS_MOOV_ENABLED: 'false' }, async () => assert.equal(productionTransferWebhookApplyEnabled(), false));
  await withEnv({ ...PRODUCTION_ENV, AWS_PROVIDER_EXECUTION_ENABLED: undefined }, async () => assert.equal(productionTransferWebhookApplyEnabled(), false));
});

test('apply: one writer call with the mapped fields, inside a savepoint, the apply GUC scoped and reset; a return logs moov_transfer_returned once', async () => {
  const log = silent();
  const client = fakeClient({ result: {
    transfer_id: TRANSFER, tenant_id: TENANT, leg_role: 'send_bank', previous_status: 'completed', new_status: 'returned', outcome: 'applied', notify: true,
  } });
  const out = await applyProductionMoovTransferWebhook(client, {
    eventID: 'evt-2', type: 'transfer.updated',
    data: { transferID: 'tr_1', status: 'completed', source: { achDetails: { status: 'returned', return: { code: 'R01', reason: 'Insufficient funds' } } } },
  }, { eventId: 'evt-2', log });
  assert.deepEqual(writerCall(client).params, ['production', 'tr_1', 'returned', 'completed', 'evt-2', 'transfer.updated', 'R01', 'Insufficient funds', null, null, null]);
  const order = client.calls.map((c) => c.sql);
  const iApply = order.findIndex((s) => s.includes("'request.provider_webhook_apply', '1'"));
  const iSave = order.indexOf('SAVEPOINT moov_transfer_status');
  const iWriter = order.indexOf(TRANSFER_STATUS_WRITER_SQL);
  const iRelease = order.indexOf('RELEASE SAVEPOINT moov_transfer_status');
  const iReset = order.findIndex((s) => s.includes("'request.provider_webhook_apply', '0'"));
  assert.ok(iApply >= 0 && iApply < iSave && iSave < iWriter && iWriter < iRelease && iRelease < iReset, JSON.stringify(order));
  assert.deepEqual(client.gucs.at(-1), ['request.provider_webhook_apply', '0']);
  assert.ok(client.gucs.some(([k, v]) => k === 'request.aws_financial_permissions_activated' && v === '0'));
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'applied');
  assert.equal(out.status, 'returned');
  assert.equal(out.notify, true);
  assert.equal(out.return_code, 'R01');
  assert.equal(out.tenant_id, TENANT, 'the tenant comes from the row, via the writer');
  assert.deepEqual(out.mutations, ['payment_transfers', 'payment_event_log']);
  assert.equal(out.financialTablesMutated, true);
  assert.deepEqual(log.lines.map((l) => [l.event, l.tenant_id, l.transfer_id, l.status, l.return_code]), [
    ['moov_transfer_returned', TENANT, TRANSFER, 'returned', 'R01'],
  ]);
  // No other table is touched and nothing outside the writer is written.
  assert.ok(!client.calls.some((c) => /\b(UPDATE|INSERT|DELETE)\b/i.test(c.sql) && c.sql !== TRANSFER_STATUS_WRITER_SQL));
});

test('apply: idempotency and out-of-order outcomes are reported, not re-logged; nothing is notified twice', async () => {
  for (const [outcome, applied, mutations] of [
    ['duplicate_event', false, []],
    ['stale', false, ['payment_event_log']],
    ['unchanged', false, ['payment_event_log']],
    ['correction', true, ['payment_transfers', 'payment_event_log']],
    ['not_owned', false, []],
  ]) {
    const log = silent();
    const client = fakeClient({ result: { transfer_id: TRANSFER, tenant_id: TENANT, leg_role: 'send_bank', previous_status: 'returned', new_status: 'returned', outcome, notify: false } });
    const out = await applyProductionMoovTransferWebhook(client, { type: 'transfer.updated', data: { transferID: 'tr_1', status: 'completed' } }, { eventId: 'evt-x', log });
    assert.equal(out.outcome, outcome);
    assert.equal(out.applied, applied, outcome);
    assert.equal(out.skipped, applied ? null : outcome);
    assert.deepEqual(out.mutations, mutations, outcome);
    assert.equal(out.notify, false);
    assert.deepEqual(log.lines, [], outcome);
  }
  const unknown = await applyProductionMoovTransferWebhook(fakeClient({ result: { outcome: 'unknown_transfer', notify: false } }), { type: 'transfer.updated', data: { transferID: 'tr_x', status: 'failed' } }, { eventId: 'e', log: silent() });
  assert.equal(unknown.outcome, 'unknown_transfer');
  assert.equal(unknown.tenant_id, null);
  assert.deepEqual(unknown.mutations, []);
});

test('apply: a missing or refusing writer (SQL 107 not applied) rolls back to the savepoint, resets the GUC and never throws', async () => {
  const log = silent();
  const error = Object.assign(new Error('function public.aws_moov_webhook_apply_transfer_status(...) does not exist'), { code: '42883' });
  const client = fakeClient({ writerError: error });
  const out = await applyProductionMoovTransferWebhook(client, { type: 'transfer.updated', data: { transferID: 'tr_1', status: 'failed' } }, { eventId: 'evt-1', log });
  assert.equal(out.applied, false);
  assert.equal(out.skipped, 'status_writer_unavailable');
  assert.equal(out.sqlstate, '42883');
  assert.equal(out.financialTablesMutated, false);
  const order = client.calls.map((c) => c.sql);
  assert.ok(order.includes('ROLLBACK TO SAVEPOINT moov_transfer_status'));
  assert.deepEqual(client.gucs.at(-1), ['request.provider_webhook_apply', '0']);
  assert.equal(log.lines[0].event, 'moov_transfer_status_writer_failed');
});

test('apply: nothing is called without a transfer id, an event id or a status / NOC', async () => {
  for (const [payload, eventId, skipped] of [
    [{ type: 'transfer.updated', data: {} }, 'e', 'no_transfer_id'],
    [{ type: 'transfer.updated', data: { transferID: 'tr_1', status: 'failed' } }, '', 'no_event_id'],
    [{ type: 'transfer.updated', data: { transferID: 'tr_1', status: 'mystery' } }, 'e', 'unmapped_status'],
  ]) {
    const client = fakeClient();
    const out = await applyProductionMoovTransferWebhook(client, payload, { eventId, log: silent() });
    assert.equal(out.skipped, skipped);
    assert.equal(client.calls.length, 0, skipped);
  }
});

/** A signed Moov webhook through handleProviderWebhook with a fake database. */
async function deliver(payload, { writerResult, duplicate = false } = {}) {
  const secret = 'moov-webhook-secret';
  const webhookId = payload.eventID;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `n-${webhookId}`;
  const rawBody = JSON.stringify(payload);
  const signature = hmacHex(secret, `${timestamp}|${nonce}|${webhookId}`, 'sha512');
  const client = fakeClient({ result: writerResult });
  const base = client.query.bind(client);
  client.connect = async () => {};
  client.end = async () => {};
  client.query = async (sql, params = []) => {
    if (String(sql).includes('INSERT INTO public.aws_provider_webhook_receipts')) {
      client.calls.push({ sql: String(sql), params });
      return { rows: duplicate ? [] : [{ id: 'receipt-1', provider: params[0], external_event_id: params[1] }] };
    }
    if (String(sql).includes('FROM public.aws_provider_webhook_receipts')) {
      client.calls.push({ sql: String(sql), params });
      return { rows: [{ id: 'receipt-1', provider: 'moov', external_event_id: params[1] }] };
    }
    return base(sql, params);
  };
  const event = {
    rawPath: '/webhooks/moov',
    headers: { 'x-webhook-id': webhookId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': signature },
    body: rawBody,
    requestContext: { stage: 'production', http: { method: 'POST', path: '/webhooks/moov' } },
  };
  const result = await handleProviderWebhook(event, 'moov', {
    loadProviderSecrets: async () => ({ MOOV_WEBHOOK_SECRET: secret }),
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
  });
  return { result, client };
}

test('webhook route: a production transfer.updated return is written back once; a redelivery is stopped by the receipt; dry-run and other events do not call the writer', async () => {
  const payload = {
    eventID: 'evt-route-1', type: 'transfer.updated', accountID: 'acct-prod',
    data: { transferID: 'tr_prod_1', status: 'failed', source: { achDetails: { status: 'returned', return: { code: 'R01', reason: 'Insufficient funds' } } } },
  };
  const writerResult = { transfer_id: TRANSFER, tenant_id: TENANT, leg_role: 'send_bank', previous_status: 'submitted', new_status: 'returned', outcome: 'applied', notify: true };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await withEnv(PRODUCTION_ENV, async () => {
      const { result, client } = await deliver(payload, { writerResult });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.applied, true);
      assert.deepEqual(result.apply_mutations, ['payment_transfers', 'payment_event_log']);
      assert.equal(result.apply_environment, 'production');
      assert.equal(result.liveProviderCalled, false);
      assert.deepEqual(writerCall(client).params.slice(0, 7), ['production', 'tr_prod_1', 'returned', 'failed', 'evt-route-1', 'transfer.updated', 'R01']);
      // The writer runs before the Collection V2 step, which no longer sees the apply GUC.
      const sqls = client.calls.map((c) => c.sql);
      const iWriter = sqls.indexOf(TRANSFER_STATUS_WRITER_SQL);
      const iReset = sqls.findIndex((s, i) => i > iWriter && s.includes("'request.provider_webhook_apply', '0'"));
      const iCollection = sqls.findIndex((s) => s.includes('tenant_maintenance_payments') || s.includes('SELECT * FROM public.payment_transfers'));
      assert.ok(iWriter >= 0 && iReset > iWriter && iCollection > iReset, JSON.stringify(sqls));
      assert.equal(sqls.at(-1), 'COMMIT');

      const again = await deliver(payload, { writerResult, duplicate: true });
      assert.equal(again.result.duplicate, true);
      assert.equal(again.result.apply_skipped, 'duplicate');
      assert.equal(writerCall(again.client), undefined);

      const account = await deliver({ eventID: 'evt-route-2', type: 'account.updated', accountID: 'acct-prod', data: {} }, { writerResult });
      assert.equal(writerCall(account.client), undefined);
    });
    await withEnv({ ...PRODUCTION_ENV, AWS_PROVIDER_WEBHOOK_DRY_RUN: 'true' }, async () => {
      const { result, client } = await deliver({ ...payload, eventID: 'evt-route-3' }, { writerResult });
      assert.equal(result.applied, false);
      assert.equal(writerCall(client), undefined);
    });
  } finally {
    console.warn = originalWarn;
  }
});

test('UI: a bounced status wins over Moov\'s; the return, failure or NOC is explained only from the webhook record', () => {
  assert.equal(isBouncedTransferStatus('returned'), true);
  assert.equal(isBouncedTransferStatus('completed'), false);
  // Moov may still say "completed" after an ACH return.
  assert.equal(transferDisplayStatus({ status: 'returned', provider_status: 'completed' }), 'returned');
  assert.equal(transferDisplayStatus({ status: 'pending', provider_status: 'processing' }), 'processing');
  assert.equal(transferDisplayStatus({ status: 'submitted', provider_status: null }), 'submitted');
  assert.equal(
    transferIssueText({ status: 'returned', provider_metadata: { moov_return: { code: 'R01', reason: 'Insufficient funds' } } }),
    'Returned by the bank (R01: Insufficient funds). Check the bank details and send again if needed.',
  );
  assert.equal(
    transferIssueText({ status: 'failed', provider_metadata: { moov_last_webhook: { status: 'failed' } } }),
    'Moov reported this transfer failed. Check the bank details and send again if needed.',
  );
  assert.equal(
    transferIssueText({ status: 'pending', provider_metadata: { moov_correction: { code: 'C01' } } }),
    'The bank sent a notification of change (C01). Update the bank details before the next payment.',
  );
  // A send's own refusal or unsent leg (no webhook record) keeps the existing display.
  assert.equal(transferIssueText({ status: 'canceled', provider_metadata: {} }), null);
  assert.equal(transferIssueText({ status: 'failed', provider_metadata: { post_error_status: 422 } }), null);
  assert.equal(transferIssueText({ status: 'completed', provider_metadata: null }), null);
});
