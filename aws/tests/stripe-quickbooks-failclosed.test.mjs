import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';
import { classifyFunction } from '../functions/api/providers/catalog.mjs';

test('Stripe stays fail-closed and is not Class A', async () => {
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-credit-topup'), false);
  assert.equal(CLASS_A_FUNCTIONS.has('report-check-usage-to-stripe'), false);

  for (const name of ['tenant-credit-topup']) {
    const result = await handler({
      requestContext: { http: { method: 'POST', path: `/functions/v1/${name}` } },
      body: JSON.stringify({}),
    });
    assert.equal(result.statusCode, 403, name);
    const body = JSON.parse(result.body);
    assert.equal(body.error, 'provider_disabled', name);
  }
});

test('removed QuickBooks functions are unknown and refused', async () => {
  for (const name of ['quickbooks-payment', 'quickbooks-auth']) {
    assert.equal(CLASS_A_FUNCTIONS.has(name), false, name);
    assert.equal(classifyFunction(name), null, name);
    const result = await handler({
      requestContext: { http: { method: 'POST', path: `/functions/v1/${name}` } },
      body: JSON.stringify({}),
    });
    assert.equal(result.statusCode, 403, name);
    const body = JSON.parse(result.body);
    assert.equal(body.error, 'provider_disabled', name);
    assert.equal(body.provider, null, name);
  }
});
