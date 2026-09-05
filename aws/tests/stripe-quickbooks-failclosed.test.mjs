import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';

test('Stripe and QuickBooks stay fail-closed and are not Class A', async () => {
  assert.equal(CLASS_A_FUNCTIONS.has('quickbooks-payment'), false);
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-credit-topup'), false);
  assert.equal(CLASS_A_FUNCTIONS.has('report-check-usage-to-stripe'), false);

  for (const name of ['quickbooks-payment', 'quickbooks-auth', 'tenant-credit-topup']) {
    const result = await handler({
      requestContext: { http: { method: 'POST', path: `/functions/v1/${name}` } },
      body: JSON.stringify({}),
    });
    assert.equal(result.statusCode, 403, name);
    const body = JSON.parse(result.body);
    assert.equal(body.error, 'provider_disabled', name);
  }
});
