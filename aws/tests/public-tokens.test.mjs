import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  handlePublicRecipientSession,
  isPlausiblePublicToken,
  loadInvoiceByToken,
} from '../functions/api/public-tokens.mjs';

test('public-invoice is Class A and does not require Cognito', async () => {
  assert.ok(CLASS_A_FUNCTIONS.has('public-invoice'));
  assert.ok(!CLASS_A_FUNCTIONS.has('moov-recipient-session'));
  const missing = await handleAppServiceRequest({
    body: JSON.stringify({ token: 'short' }),
    requestContext: { http: { method: 'POST', path: '/functions/v1/public-invoice' } },
  }, '/functions/v1/public-invoice', 'POST');
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.error, 'invalid_link');
  assert.equal(missing.message.includes('Cognito'), false);
  assert.match(missing.message, /invalid or has expired/i);
});

test('plausible public tokens reject malformed values', () => {
  assert.equal(isPlausiblePublicToken(''), false);
  assert.equal(isPlausiblePublicToken('abc'), false);
  assert.equal(isPlausiblePublicToken('undefined'), false);
  assert.equal(isPlausiblePublicToken('has space-token12'), false);
  assert.equal(isPlausiblePublicToken('valid-token-value'), true);
});

test('recipient session malformed token is a clean public error', async () => {
  const result = await handlePublicRecipientSession({
    body: JSON.stringify({ token: 'nope' }),
    headers: { 'x-tenant-id': 'spoof' },
    requestContext: { http: { method: 'POST', path: '/functions/v1/moov-recipient-session' } },
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'invalid_link');
  assert.equal(String(result.error).includes('missing_cognito_token'), false);
  assert.equal(result.spoofFieldsIgnored.headerTenantId, 'spoof');
});

test('public invoice does not look up by raw id', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../functions/api/public-tokens.mjs', import.meta.url), 'utf8'),
  );
  assert.equal(src.includes('OR id::text'), false);
  assert.match(src, /public_token = \$1/);
});

test('unknown invoice token is not found when invoice tables are missing', async () => {
  const client = {
    query: async () => {
      throw new Error('permission denied for table moov_invoices');
    },
  };
  assert.equal(await loadInvoiceByToken(client, 'not-a-real-invoice-token-xyz'), null);
});

test('invoice lookup uses public_token only and continues after a missing table', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (String(sql).includes('moov_invoices')) throw new Error('relation does not exist');
      return {
        rows: [{
          id: 'inv-1',
          public_token: params[0],
          tenant_id: '4f172140-f57a-4744-8050-95f4f07b13b4',
        }],
      };
    },
  };
  const row = await loadInvoiceByToken(client, 'valid-token-value');
  assert.equal(row.public_token, 'valid-token-value');
  assert.equal(queries.length, 2);
  assert.equal(queries.some((q) => String(q.sql).includes('id::text')), false);
});
