import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleFunctionInvoke } from '../functions/api/providers.mjs';

const eventOf = (body) => ({
  body: JSON.stringify(body),
  headers: { 'x-tenant-id': 'spoof' },
  requestContext: { http: { method: 'POST', path: '/functions/v1/moov-invoice' } },
});

test('moov-invoice rejects negative and zero line amounts before provider execution', async () => {
  const negative = await handleFunctionInvoke(eventOf({
    action: 'create',
    line_items: [{ name: 'Mitigation', unit_price: -10, quantity: 1 }],
  }), 'moov-invoice');
  assert.equal(negative.statusCode, 400);
  assert.equal(negative.error, 'invalid_amount');

  const zero = await handleFunctionInvoke(eventOf({
    action: 'create',
    line_items: [{ name: 'Mitigation', unit_price: 0, quantity: 1 }],
  }), 'moov-invoice');
  assert.equal(zero.statusCode, 400);
  assert.equal(zero.error, 'invalid_amount');

  const malformed = await handleFunctionInvoke(eventOf({
    action: 'create_and_send',
    line_items: [{ name: 'Mitigation', unit_price: 'abc', quantity: 1 }],
  }), 'moov-invoice');
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.error, 'invalid_amount');
});
