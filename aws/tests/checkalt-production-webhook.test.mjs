import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hmacHex } from '../functions/api/providers/hmac.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  applyProductionCheckAltWebhook,
  productionCheckAltWebhookApplyEnabled,
} from '../functions/api/providers/webhook-apply.mjs';

const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const DEPOSIT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REFERENCE = 'CA-PROD-REF-1';

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

const signedCheckAlt = ({ secret, webhookId, body, nowMs = Date.now() }) => {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = hmacHex(secret, `${webhookId}.${timestamp}.${rawBody}`, 'sha256');
  return {
    rawPath: '/webhooks/checkalt',
    body: rawBody,
    headers: {
      'x-webhook-id': webhookId,
      'x-timestamp': timestamp,
      'x-signature': signature,
    },
    requestContext: { stage: 'production-prep', http: { method: 'POST', path: '/webhooks/checkalt' } },
  };
};

const mockProdClient = ({ deposit = {
  id: DEPOSIT_ID,
  tenant_id: FREEDOM_TENANT,
  checkalt_reference: REFERENCE,
  status: 'submitted',
} } = {}) => {
  const queries = [];
  const receipts = [];
  const updates = [];
  return {
    queries,
    receipts,
    updates,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql.includes('aws_lookup_checkalt_deposit')) {
        return { rows: deposit && String(params[0]) === String(deposit.checkalt_reference) ? [deposit] : [] };
      }
      if (sql.includes('FROM public.checkalt_deposits')) {
        if (params[0] === deposit?.id && String(params[1]) === String(deposit.checkalt_reference)) {
          return { rows: [deposit] };
        }
        return { rows: [] };
      }
      if (sql.includes('UPDATE public.checkalt_deposits')) {
        updates.push({ sql, params });
        return { rows: [{ ...deposit, status: params[1] || deposit.status }] };
      }
      if (sql.includes('UPDATE public.aws_provider_sandbox_operations')) {
        throw new Error('sandbox operations must not be written on the production CheckAlt path');
      }
      if (sql.includes('INSERT INTO public.aws_provider_webhook_receipts')) {
        const existing = receipts.find((row) => row.provider === params[0] && row.external_event_id === params[1]);
        if (existing) return { rows: [] };
        const row = {
          id: `receipt-${receipts.length + 1}`,
          provider: params[0],
          external_event_id: params[1],
          dry_run: params[6],
          received_at: new Date().toISOString(),
        };
        receipts.push(row);
        return { rows: [row] };
      }
      if (sql.includes('FROM public.aws_provider_webhook_receipts')) {
        return { rows: receipts.filter((row) => row.provider === params[0] && row.external_event_id === params[1]) };
      }
      return { rows: [] };
    },
  };
};

const depsFor = (client, secret) => ({
  loadProviderSecrets: async () => ({ CHECKALT_WEBHOOK_SECRET: secret }),
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  createClient: () => client,
});

test('production CheckAlt apply stays off while webhook dry-run is true', async () => {
  await withEnv({
    AWS_PROVIDER_WEBHOOK_DRY_RUN: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_CHECKALT_ENABLED: 'false',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  }, async () => {
    assert.equal(productionCheckAltWebhookApplyEnabled(), false);
    const secret = 'prod-checkalt-webhook-secret';
    const client = mockProdClient();
    const first = await handleProviderRequest(
      signedCheckAlt({
        secret,
        webhookId: 'evt-dry-1',
        body: {
          eventID: 'evt-dry-1',
          type: 'deposit.updated',
          referenceNumber: REFERENCE,
          status: 200,
          depositDate: '2026-09-22',
          tenant_id: C1C_TENANT,
        },
      }),
      '/webhooks/checkalt',
      'POST',
      depsFor(client, secret),
    );
    assert.equal(first.ok, true);
    assert.equal(first.dry_run, true);
    assert.equal(first.applied, false);
    assert.equal(first.apply_skipped, 'webhook_dry_run');
    assert.equal(first.financialTablesMutated, false);
    assert.equal(first.productionRecordsMutated, false);
    assert.equal(first.mapped_tenant_id, FREEDOM_TENANT);
    assert.equal(first.lookup, 'checkalt_deposit');
    assert.equal(first.payload.tenant_id, '[ignored-untrusted]');
    assert.equal(client.updates.length, 0);
    assert.equal(client.receipts.length, 1);
    assert.equal(client.receipts[0].dry_run, true);
  });
});

test('unsigned and malformed CheckAlt signatures are rejected before persist', async () => {
  const secret = 'prod-checkalt-webhook-secret';
  const client = mockProdClient();
  const unsigned = await handleProviderRequest({
    rawPath: '/webhooks/checkalt',
    body: JSON.stringify({ eventID: 'evt-unsigned', referenceNumber: REFERENCE, status: 127 }),
    headers: {},
    requestContext: { stage: 'production-prep', http: { method: 'POST', path: '/webhooks/checkalt' } },
  }, '/webhooks/checkalt', 'POST', depsFor(client, secret));
  assert.equal(unsigned.statusCode, 401);
  assert.equal(unsigned.error, 'missing_signature_headers');
  assert.equal(client.receipts.length, 0);

  const malformed = await handleProviderRequest({
    rawPath: '/webhooks/checkalt',
    body: '{not-json',
    headers: {
      'x-webhook-id': 'evt-bad',
      'x-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-signature': 'aa',
    },
    requestContext: { stage: 'production-prep', http: { method: 'POST', path: '/webhooks/checkalt' } },
  }, '/webhooks/checkalt', 'POST', depsFor(client, secret));
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.error, 'malformed_webhook');

  const invalid = await handleProviderRequest({
    rawPath: '/webhooks/checkalt',
    body: JSON.stringify({ eventID: 'evt-bad-sig', referenceNumber: REFERENCE, status: 127 }),
    headers: {
      'x-webhook-id': 'evt-bad-sig',
      'x-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-signature': '00'.repeat(32),
    },
    requestContext: { stage: 'production-prep', http: { method: 'POST', path: '/webhooks/checkalt' } },
  }, '/webhooks/checkalt', 'POST', depsFor(client, secret));
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.error, 'invalid_signature');
  assert.equal(client.updates.length, 0);
});

test('duplicate production CheckAlt event is receipt-idempotent and does not apply twice', async () => {
  await withEnv({
    AWS_PROVIDER_WEBHOOK_DRY_RUN: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_CHECKALT_ENABLED: 'false',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  }, async () => {
    const secret = 'prod-checkalt-webhook-secret';
    const client = mockProdClient();
    const event = signedCheckAlt({
      secret,
      webhookId: 'evt-dup-1',
      body: {
        eventID: 'evt-dup-1',
        type: 'deposit.updated',
        referenceNumber: REFERENCE,
        status: 127,
        tenant_id: C1C_TENANT,
      },
    });
    const first = await handleProviderRequest(event, '/webhooks/checkalt', 'POST', depsFor(client, secret));
    const second = await handleProviderRequest(event, '/webhooks/checkalt', 'POST', depsFor(client, secret));
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.applied, true);
    assert.equal(first.productionRecordsMutated, true);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.applied, false);
    assert.equal(second.apply_skipped, 'duplicate');
    assert.equal(second.productionRecordsMutated, false);
    assert.equal(client.updates.length, 1);
    assert.equal(client.receipts.length, 1);
    assert.ok(!client.queries.some((q) => q.sql.includes('aws_provider_sandbox_operations')));
  });
});

test('production apply refuses sandbox mode and unmapped references', async () => {
  await withEnv({
    AWS_PROVIDER_WEBHOOK_DRY_RUN: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  }, async () => {
    assert.equal(productionCheckAltWebhookApplyEnabled(), false);
    const refused = await applyProductionCheckAltWebhook({ query: async () => ({ rows: [] }) }, {
      referenceNumber: REFERENCE,
      status: 127,
    });
    assert.equal(refused.applied, false);
    assert.equal(refused.skipped, 'sandbox_mode_refused');
  });

  await withEnv({
    AWS_PROVIDER_WEBHOOK_DRY_RUN: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
  }, async () => {
    const secret = 'prod-checkalt-webhook-secret';
    const client = mockProdClient({ deposit: null });
    const result = await handleProviderRequest(
      signedCheckAlt({
        secret,
        webhookId: 'evt-unmap',
        body: { eventID: 'evt-unmap', referenceNumber: 'NO-SUCH-REF', status: 127 },
      }),
      '/webhooks/checkalt',
      'POST',
      depsFor(client, secret),
    );
    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.equal(result.apply_skipped, 'unmapped_production_deposit');
    assert.equal(result.productionRecordsMutated, false);
    assert.equal(client.updates.length, 0);
    assert.equal(client.receipts.length, 1);
  });
});
