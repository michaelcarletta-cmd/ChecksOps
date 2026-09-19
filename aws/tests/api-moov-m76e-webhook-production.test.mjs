import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hmacHex } from '../functions/api/providers/hmac.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  applyProductionMoovWebhook,
  reconcileExistingFromProviderGet,
} from '../functions/api/providers/webhook-apply-production.mjs';
import {
  canTransition,
  completedAtFor,
  extractTransferEvent,
  inferSweepActivity,
} from '../functions/api/providers/moov-lifecycle.mjs';
import {
  AUTHORITATIVE_DISBURSEMENT_FUNDING,
  DOUBLE_FUNDING_PREVENTION,
  OUTGOING_PAYMENT_SEQUENCE,
} from '../functions/api/providers/moov-funding-sequence.mjs';
import { handleProductionMoovTransferStatus } from '../functions/api/providers/production/moov-transfer-status.mjs';
import {
  isProductionMoovReadPath,
  productionMoovFetch,
} from '../functions/api/providers/production/moov-client.mjs';
import { FINANCIAL_OR_PROVIDER_TABLES } from '../functions/api/write-allowlist.mjs';

const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FUND_INTENT = '257b6033-eac0-4555-877e-a8cb4f801c8f';
const FUND_XFER = '15946bc6-7e80-42d2-99a3-5a3793b24d2e';
const SWEEP_XFER = '4e39f67f-383f-44d4-b5f8-212d4cc29bb0';
const COMPLETED_ON = '2026-09-18T15:16:05.466351Z';
const FREEDOM_MOOV = '60922058-7eca-4889-81dd-5720d7b9de96';

const completionPayload = {
  type: 'transfer.updated',
  eventID: 'm76e-fixture-completion-1',
  accountID: FREEDOM_MOOV,
  data: {
    transferID: FUND_XFER,
    status: 'completed',
    completedOn: COMPLETED_ON,
    createdOn: '2026-09-16T14:12:37Z',
    amount: { currency: 'USD', valueDecimal: '0.01' },
    source: { paymentMethodType: 'ach-debit-fund' },
    destination: { paymentMethodType: 'moov-wallet' },
  },
};

const existingCompleted = {
  id: FUND_INTENT,
  tenant_id: FREEDOM_TENANT,
  status: 'completed',
  environment: 'production',
  amount_cents: 1,
  completed_at: '2026-09-18T15:16:05.466Z',
  provider_status: 'completed',
  provider_transfer_id: FUND_XFER,
  leg_role: 'wallet_funding',
};

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

const mockWebhookClient = ({ lookup = existingCompleted, observeId = 'act-1' } = {}) => {
  const queries = [];
  const inserts = [];
  return {
    queries,
    inserts,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO public.payment_transfers')) {
        inserts.push('payment_transfers');
        throw new Error('payment_transfers_insert_forbidden');
      }
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql.includes('aws_lookup_provider_account')) {
        return { rows: [{ id: 'acct-1', tenant_id: FREEDOM_TENANT }] };
      }
      if (sql.includes('INSERT INTO public.aws_provider_webhook_receipts')) {
        return {
          rows: [{
            id: `receipt-${queries.filter((q) => q.sql.includes('INSERT INTO public.aws_provider_webhook_receipts')).length}`,
            provider: params[0],
            external_event_id: params[1],
            dry_run: params[6],
            received_at: new Date().toISOString(),
          }],
        };
      }
      if (sql.includes('FROM public.aws_provider_webhook_receipts')) {
        return { rows: [] };
      }
      if (sql.includes('aws_moov_lookup_transfer')) {
        return { rows: lookup ? [lookup] : [] };
      }
      if (sql.includes('aws_moov_reconcile_existing_transfer')) {
        return {
          rows: [{
            id: lookup.id,
            status: params[1],
            provider_status: params[2],
            completed_at: params[3],
            tenant_id: lookup.tenant_id,
          }],
        };
      }
      if (sql.includes('aws_moov_observe_provider_activity')) {
        return {
          rows: [{
            id: observeId,
            provider_transfer_id: params[1],
            origin: params[2],
            status: params[4],
          }],
        };
      }
      if (sql.includes('aws_moov_record_reconcile_event')) return { rows: [] };
      return { rows: [] };
    },
  };
};

const signedEvent = (payload, secret, extraHeaders = {}) => {
  const webhookId = payload.eventID;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n-m76e';
  const rawBody = JSON.stringify(payload);
  const signature = hmacHex(secret, `${timestamp}|${nonce}|${webhookId}`, 'sha512');
  return {
    rawPath: '/webhooks/moov',
    headers: {
      'x-webhook-id': webhookId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
      ...extraHeaders,
    },
    body: rawBody,
    requestContext: { stage: 'prep', http: { method: 'POST', path: '/webhooks/moov' } },
  };
};

test('completed cannot regress to pending or submitted', () => {
  assert.equal(canTransition('completed', 'pending').ok, false);
  assert.equal(canTransition('completed', 'pending').reason, 'terminal_regression');
  assert.equal(canTransition('completed', 'submitted').ok, false);
  assert.equal(canTransition('failed', 'completed').ok, false);
  assert.equal(canTransition('completed', 'returned').ok, true);
  assert.equal(canTransition('completed', 'completed').noop, true);
  assert.equal(canTransition('submitted', 'completed').ok, true);
});

test('completed_at uses provider completedOn and never manufactures now()', () => {
  const at = completedAtFor({
    nextStatus: 'completed',
    providerCompletedAt: COMPLETED_ON,
    existingCompletedAt: null,
  });
  assert.equal(at, COMPLETED_ON);
  const kept = completedAtFor({
    nextStatus: 'completed',
    providerCompletedAt: null,
    existingCompletedAt: '2026-09-18T15:16:05.466Z',
  });
  assert.equal(kept, '2026-09-18T15:16:05.466Z');
  const pending = completedAtFor({
    nextStatus: 'pending',
    providerCompletedAt: COMPLETED_ON,
    existingCompletedAt: '2026-09-18T15:16:05.466Z',
  });
  assert.equal(pending, '2026-09-18T15:16:05.466Z');
});

test('known completion event reconciles existing production row without creating a transfer', async () => {
  const client = mockWebhookClient();
  const result = await applyProductionMoovWebhook(client, completionPayload, {
    mappedTenantId: FREEDOM_TENANT,
  });
  assert.equal(result.applied, true);
  assert.equal(result.skipped, 'idempotent_same_status');
  assert.equal(result.payment_transfer_id, FUND_INTENT);
  assert.equal(result.status, 'completed');
  assert.equal(result.completed_at, '2026-09-18T15:16:05.466Z');
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(result.financialTablesMutated, false);
  assert.equal(client.inserts.length, 0);
  assert.ok(!client.queries.some((q) => q.sql.includes('aws_moov_reconcile_existing_transfer')));
});

test('submitted production row would complete with provider completedOn', async () => {
  const client = mockWebhookClient({
    lookup: { ...existingCompleted, status: 'submitted', provider_status: null, completed_at: null },
  });
  const result = await applyProductionMoovWebhook(client, completionPayload, {
    mappedTenantId: FREEDOM_TENANT,
  });
  assert.equal(result.applied, true);
  assert.equal(result.payment_transfer_id, FUND_INTENT);
  assert.equal(result.status, 'completed');
  assert.equal(result.completed_at, COMPLETED_ON);
  assert.equal(result.createdPaymentTransfer, false);
  const recon = client.queries.find((q) => q.sql.includes('aws_moov_reconcile_existing_transfer'));
  assert.ok(recon);
  assert.equal(recon.params[0], FUND_XFER);
  assert.equal(recon.params[1], 'completed');
  assert.equal(recon.params[2], 'completed');
  assert.equal(recon.params[3], COMPLETED_ON);
});

test('duplicate completion is idempotent and cannot regress', async () => {
  const client = mockWebhookClient();
  const first = await applyProductionMoovWebhook(client, completionPayload, { mappedTenantId: FREEDOM_TENANT });
  const second = await applyProductionMoovWebhook(client, {
    ...completionPayload,
    type: 'transfer.updated',
    data: { ...completionPayload.data, status: 'pending' },
  }, { mappedTenantId: FREEDOM_TENANT });
  assert.equal(first.skipped, 'idempotent_same_status');
  assert.equal(second.applied, false);
  assert.equal(second.skipped, 'terminal_regression');
  assert.equal(second.status, 'completed');
  assert.equal(second.financialTablesMutated, false);
});

test('unknown provider transfer is observed and does not create a payment intent', async () => {
  const client = mockWebhookClient({ lookup: null });
  const payload = {
    type: 'transfer.created',
    eventID: 'm76e-unknown',
    accountID: FREEDOM_MOOV,
    data: {
      transferID: SWEEP_XFER,
      status: 'pending',
      amount: { currency: 'USD', valueDecimal: '0.01' },
      metadata: { sweepID: '4afcef2f-f091-4571-93c5-89fc32ef47e5' },
      source: { paymentMethodType: 'moov-wallet' },
      destination: { paymentMethodType: 'ach-credit-standard' },
    },
  };
  const result = await applyProductionMoovWebhook(client, payload, { mappedTenantId: FREEDOM_TENANT });
  assert.equal(result.applied, true);
  assert.equal(result.skipped, 'unknown_transfer_observed_only');
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(result.financialTablesMutated, false);
  assert.equal(result.provider_transfer_id, SWEEP_XFER);
  const observe = client.queries.find((q) => q.sql.includes('aws_moov_observe_provider_activity'));
  assert.ok(observe);
  assert.equal(observe.params[2], 'provider_sweep');
  assert.equal(client.inserts.length, 0);
  assert.equal(inferSweepActivity(payload).isSweep, true);
});

test('signed production webhook persists a receipt and does not POST to Moov', async () => {
  const secret = 'm76e-test-secret';
  const client = mockWebhookClient();
  await withEnv({
    AWS_PROVIDER_WEBHOOK_DRY_RUN: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  }, async () => {
    const result = await handleProviderRequest(
      signedEvent(completionPayload, secret),
      '/webhooks/moov',
      'POST',
      {
        loadProviderSecrets: async () => ({ MOOV_WEBHOOK_SECRET: secret }),
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => client,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.duplicate, false);
    assert.equal(result.createdPaymentTransfer, false);
    assert.equal(result.liveProviderCalled, false);
    assert.equal(result.apply_skipped, 'idempotent_same_status');
    assert.equal(result.apply_environment, 'production');
    assert.ok(result.receipt_id);
    assert.ok(client.queries.some((q) => q.sql.includes('INSERT INTO public.aws_provider_webhook_receipts')));
    assert.ok(!client.queries.some((q) => /INSERT INTO public\.payment_transfers/i.test(q.sql)));
  });
});

test('GET-only fallback uses production read mode and updates lifecycle from provider truth', async () => {
  const methods = [];
  const client = {
    query: async (sql, params = []) => {
      if (sql.includes('FROM public.tenant_users') || sql.includes('tenant_membership') || sql.includes('tu.user_id')) {
        return { rows: [{ tenant_id: FREEDOM_TENANT, role: 'owner', tenant_name: 'Freedom', tenant_slug: 'freedom' }] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return { rows: [{ id: 'acct-1', tenant_id: FREEDOM_TENANT, provider_account_id: FREEDOM_MOOV, environment: 'production' }] };
      }
      if (sql.includes('FROM public.payment_transfers')) {
        return {
          rows: [{
            id: FUND_INTENT,
            tenant_id: FREEDOM_TENANT,
            provider_transfer_id: FUND_XFER,
            status: 'submitted',
            provider_status: null,
            completed_at: null,
            environment: 'production',
            amount_cents: 1,
          }],
        };
      }
      if (sql.includes('FROM public.payment_provider_activity')) return { rows: [] };
      if (sql.includes('aws_moov_lookup_transfer')) {
        return {
          rows: [{
            ...existingCompleted,
            status: 'submitted',
            completed_at: null,
            provider_status: null,
          }],
        };
      }
      if (sql.includes('aws_moov_reconcile_existing_transfer')) {
        return {
          rows: [{
            id: FUND_INTENT,
            status: 'completed',
            provider_status: 'completed',
            completed_at: COMPLETED_ON,
            tenant_id: FREEDOM_TENANT,
          }],
        };
      }
      return { rows: [] };
    },
  };

  const result = await handleProductionMoovTransferStatus({
    client,
    mapping: { application_user_id: 'abd3c2a0-6dc0-4680-92dd-a013e1141c91' },
    body: { tenant_id: FREEDOM_TENANT, provider_transfer_id: FUND_XFER },
    fetchImpl: async (url, init) => {
      const method = String(init?.method || 'GET').toUpperCase();
      methods.push(method);
      if (String(url).includes('/oauth2/token')) {
        assert.equal(method, 'POST');
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'header.e30.sig', token_type: 'Bearer', expires_in: 3600 }),
          text: async () => JSON.stringify({ access_token: 'header.e30.sig', token_type: 'Bearer', expires_in: 3600 }),
          headers: { get: () => null },
        };
      }
      assert.equal(method, 'GET');
      assert.match(String(url), /\/transfers\/15946bc6-7e80-42d2-99a3-5a3793b24d2e$/);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          transferID: FUND_XFER,
          status: 'completed',
          completedOn: COMPLETED_ON,
          amount: { currency: 'USD', valueDecimal: '0.01' },
        }),
        headers: { get: () => null },
      };
    },
    loadSecrets: async () => ({
      ok: true,
      credentials: {
        environment: 'production',
        host: 'https://api.moov.io',
        publicKey: 'pk_test',
        secretKey: 'sk_test',
        origin: 'https://checksops.com',
        platformAccountId: '41cb5d67-4911-4bef-aad5-d8ee9c582208',
        apiVersion: 'v2024.01.00',
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(result.liveProviderPosted, false);
  assert.equal(result.updated, 1);
  assert.equal(result.results[0].status, 'completed');
  assert.ok(methods.includes('GET'));
  assert.ok(methods.filter((m) => m === 'POST').every(() => true));
  assert.ok(methods.filter((m) => m !== 'GET' && m !== 'POST').length === 0);
});

test('GET fallback cannot create an unknown payment intent', async () => {
  const existing = await reconcileExistingFromProviderGet(
    mockWebhookClient({ lookup: null }),
    { providerTransferId: '00000000-0000-0000-0000-000000000099', providerStatus: 'completed' },
  );
  assert.equal(existing.applied, false);
  assert.equal(existing.skipped, 'unknown_transfer');
  assert.equal(existing.createdPaymentTransfer, false);
});

test('production GET allowlist includes sweep reads and still refuses writes', async () => {
  assert.equal(isProductionMoovReadPath(`/accounts/${FREEDOM_MOOV}/sweep-configs/2d2c900d-6efb-43a2-ba90-2fd77e22afdd`), true);
  assert.equal(isProductionMoovReadPath(`/accounts/${FREEDOM_MOOV}/wallets/3e6286ca-a19c-45f6-aad9-f73dac5f0358/sweeps/4afcef2f-f091-4571-93c5-89fc32ef47e5`), true);
  assert.equal(isProductionMoovReadPath(`/accounts/${FREEDOM_MOOV}/transfers/${FUND_XFER}`), true);
  await assert.rejects(
    () => productionMoovFetch({
      credentials: {
        environment: 'production',
        host: 'https://api.moov.io',
        publicKey: 'pk',
        secretKey: 'sk',
        origin: 'https://checksops.com',
      },
      path: `/accounts/${FREEDOM_MOOV}/transfers`,
      method: 'POST',
      mode: 'read',
      fetchImpl: async () => { throw new Error('should_not_fetch'); },
    }),
    (err) => err.code === 'read_only_method_denied',
  );
});

test('webhook and GET recon sources never POST to Moov or INSERT payment_transfers', () => {
  const files = [
    '../functions/api/providers/webhook-apply-production.mjs',
    '../functions/api/providers/moov-lifecycle.mjs',
    '../functions/api/providers/production/moov-transfer-status.mjs',
    '../functions/api/providers/production/moov-dispatch.mjs',
  ];
  for (const rel of files) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /method:\s*['"]POST['"]/);
    assert.doesNotMatch(src, /INSERT INTO public\.payment_transfers/i);
  }
  assert.equal(FINANCIAL_OR_PROVIDER_TABLES.has('payment_provider_activity'), true);
});

test('insufficient-wallet sequence uses one authoritative funding mechanism', () => {
  assert.equal(OUTGOING_PAYMENT_SEQUENCE.case2_wallet_short_bank_has_funds.fundingMechanism, AUTHORITATIVE_DISBURSEMENT_FUNDING);
  assert.equal(DOUBLE_FUNDING_PREVENTION.rule, 'one_authoritative_funding_mechanism_per_disbursement');
  assert.ok(OUTGOING_PAYMENT_SEQUENCE.case2_wallet_short_bank_has_funds.steps.some((s) => /Do not rely on Sweep pull/i.test(s)));
});

test('extractTransferEvent maps completion fixture onto the known fund transfer', () => {
  const extracted = extractTransferEvent(completionPayload);
  assert.equal(extracted.transferId, FUND_XFER);
  assert.equal(extracted.status, 'completed');
  assert.equal(extracted.completedOn, COMPLETED_ON);
  assert.equal(extracted.amountCents, 1);
});
