/**
 * Month-end billing of next-day / same-day fees after SQL 120: the fee written at send time
 * (one per recipient of a send) is the one billed; a voided fee is never billed or written
 * again; a bank top-up leg of the same recipient is not a second fee; a wallet funding leg is
 * not a send. Fixtures only (a fake client keyed on the SQL text).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  persistMoovUsageForPeriod,
  sendRecipientKey,
} from '../functions/api/tenant-billing-engine.mjs';

const TENANT = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', next_day_rate_cents: 75, same_day_rate_cents: 100 };
const PERIOD = '2026-10';

const leg = (id, { hash = null, index = '0', speed = 'standard', status = 'completed', at = '2026-10-20T15:00:00.000Z', role = 'send_wallet' } = {}) => ({
  id, tenant_id: TENANT.id, status, speed, requested_speed: speed, completed_at: at, created_at: at,
  leg_role: role, provider_metadata: hash ? { request_hash: hash, recipient_index: index } : {},
});
const event = (id, transferId, meta, { type = 'moov_next_day', status = 'recorded', at = '2026-10-20T15:00:01.000Z', invoice = null } = {}) => ({
  id, tenant_id: TENANT.id, payment_transfer_id: transferId, event_type: type, unit_price_cents: type === 'moov_same_day' ? 100 : 75,
  billed_at: at, billing_period: null, invoice_id: invoice, status, source_kind: type, source_id: transferId,
  check_intake_item_id: null, claim_id: null, provider_metadata: meta,
});

function fakeClient({ transfers, events }) {
  const inserts = [];
  const calls = [];
  return {
    inserts,
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM public\.payment_transfers/.test(sql) && !/check_billing_events/.test(sql)) {
        // The caller filters out non-send legs in SQL; mirror that here.
        const excluded = params[4];
        return { rows: transfers.filter((t) => !excluded.includes(t.leg_role || '')) };
      }
      if (/FROM public\.check_billing_events e/.test(sql)) return { rows: events };
      if (/INSERT INTO public\.check_billing_events/.test(sql)) {
        const row = { id: `new-${inserts.length + 1}`, tenant_id: params[0], payment_transfer_id: params[1], event_type: params[2], unit_price_cents: params[3], billed_at: params[4], billing_period: params[5], invoice_id: null, status: 'recorded', source_kind: params[6], source_id: params[1], check_intake_item_id: null };
        inserts.push(row);
        return { rows: [row] };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };
}

test('1 a recipient\'s legs share one key; a leg without a send hash stands alone', () => {
  assert.equal(sendRecipientKey(leg('w', { hash: 'h1', index: '0' })), sendRecipientKey(leg('b', { hash: 'h1', index: '0', role: 'send_bank' })));
  assert.notEqual(sendRecipientKey(leg('w', { hash: 'h1', index: '0' })), sendRecipientKey(leg('x', { hash: 'h1', index: '1' })));
  assert.equal(sendRecipientKey(leg('solo')), 'leg:solo');
});

test('2 the send-time fee is billed once; the top-up leg of the same recipient adds nothing', async () => {
  const transfers = [leg('w0', { hash: 'h1' }), leg('b0', { hash: 'h1', role: 'send_bank' })];
  const events = [event('e0', 'w0', { request_hash: 'h1', recipient_index: '0' })];
  const client = fakeClient({ transfers, events });
  const out = await persistMoovUsageForPeriod(client, { tenant: TENANT, period: PERIOD, persist: true });
  assert.deepEqual(out.nextDay.map((e) => e.id), ['e0']);
  assert.equal(client.inserts.length, 0);
});

test('3 a voided fee is not billed and not written again', async () => {
  const transfers = [leg('w0', { hash: 'h1', status: 'failed' }), leg('b0', { hash: 'h1', role: 'send_bank', status: 'completed' })];
  const events = [event('e0', 'w0', { request_hash: 'h1', recipient_index: '0' }, { status: 'voided' })];
  const client = fakeClient({ transfers, events });
  const out = await persistMoovUsageForPeriod(client, { tenant: TENANT, period: PERIOD, persist: true });
  assert.equal(out.nextDay.length, 0);
  assert.equal(client.inserts.length, 0);
  assert.ok(out.skipped.some((s) => s.id === 'b0' && s.reason === 'fee_voided'));
});

test('4 a send with no fee yet (sent before SQL 120) is written once per recipient, at its rate', async () => {
  const transfers = [
    leg('w0', { hash: 'h2', speed: 'same_day' }),
    leg('b0', { hash: 'h2', speed: 'same_day', role: 'send_bank' }),
    leg('w1', { hash: 'h2', index: '1', speed: 'same_day' }),
  ];
  const client = fakeClient({ transfers, events: [] });
  const out = await persistMoovUsageForPeriod(client, { tenant: TENANT, period: PERIOD, persist: true });
  assert.deepEqual(client.inserts.map((r) => r.payment_transfer_id), ['w0', 'w1']);
  assert.equal(out.sameDay.length, 2);
  assert.equal(out.sameDay.reduce((s, e) => s + e.unit_price_cents, 0), 200);
});

test('5 wallet funding and parent legs are not sends; they are filtered in SQL', async () => {
  const transfers = [leg('f0', { role: 'wallet_funding' }), leg('p0', { role: 'parent' })];
  const client = fakeClient({ transfers, events: [] });
  const out = await persistMoovUsageForPeriod(client, { tenant: TENANT, period: PERIOD, persist: true });
  assert.equal(out.nextDay.length, 0);
  assert.equal(client.inserts.length, 0);
  assert.deepEqual(client.calls[0].params[4], ['wallet_funding', 'parent', 'platform_fee']);
  assert.match(client.calls[0].sql, /COALESCE\(leg_role, ''\) <> ALL\(\$5::text\[\]\)/);
});

test('6 only fees billed inside the period count; a preview writes nothing', async () => {
  const transfers = [leg('w0', { hash: 'h1' }), leg('w9', { hash: 'h9' })];
  const events = [
    event('e0', 'w0', { request_hash: 'h1', recipient_index: '0' }),
    event('eSep', 'old', { request_hash: 'h0', recipient_index: '0' }, { at: '2026-09-30T23:59:59.000Z' }),
  ];
  const client = fakeClient({ transfers, events });
  const out = await persistMoovUsageForPeriod(client, { tenant: TENANT, period: PERIOD, persist: false });
  assert.deepEqual(out.nextDay.map((e) => e.id ?? `preview:${e.payment_transfer_id}`).sort(), ['e0', 'preview:w9']);
  assert.equal(client.inserts.length, 0);
});
