import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { logPaymentEvent } from '../functions/api/providers/parity/db.mjs';

const ROW = { tenant_id: '00000000-0000-4000-8000-000000000001', event_type: 'transfer.created', provider_metadata: { accountNumber: '123' } };

const client = (fail = {}) => {
  const calls = [];
  return {
    calls,
    query: async (text) => {
      const kind = text.trim().split(/\s+/).slice(0, 2).join(' ');
      calls.push(kind);
      if (fail[kind]) throw Object.assign(new Error(fail[kind]), { code: fail[kind] });
      return { rows: [] };
    },
  };
};

test('payment event log: inside a transaction the insert runs under a savepoint and is released', async () => {
  const c = client();
  await logPaymentEvent(c, ROW);
  assert.deepEqual(c.calls, ['SAVEPOINT payment_event_log', 'INSERT INTO', 'RELEASE SAVEPOINT']);
});

test('payment event log: a failed insert rolls back to its savepoint, is logged and never throws (the caller transaction survives)', async (t) => {
  const errors = mock.method(console, 'error', () => {});
  t.after(() => errors.mock.restore());
  const c = client({ 'INSERT INTO': '42501' });
  await logPaymentEvent(c, ROW);
  assert.deepEqual(c.calls, ['SAVEPOINT payment_event_log', 'INSERT INTO', 'ROLLBACK TO']);
  const logged = JSON.parse(errors.mock.calls[0].arguments[0]);
  assert.equal(logged.event, 'payment_event_log_failed');
  assert.equal(logged.sqlstate, '42501');
});

test('payment event log: outside a transaction block (SAVEPOINT refused) the insert still runs, with no release or rollback', async (t) => {
  const errors = mock.method(console, 'error', () => {});
  t.after(() => errors.mock.restore());
  const ok = client({ 'SAVEPOINT payment_event_log': '25P01' });
  await logPaymentEvent(ok, ROW);
  assert.deepEqual(ok.calls, ['SAVEPOINT payment_event_log', 'INSERT INTO']);
  const failing = client({ 'SAVEPOINT payment_event_log': '25P01', 'INSERT INTO': '42501' });
  await logPaymentEvent(failing, ROW);
  assert.deepEqual(failing.calls, ['SAVEPOINT payment_event_log', 'INSERT INTO']);
  assert.equal(errors.mock.calls.length, 1);
});
