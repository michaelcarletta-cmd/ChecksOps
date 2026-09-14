import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handler } from '../functions/api/index.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { applyMoovWebhook, productionWebhookApplyEnabled, sandboxWebhookApplyEnabled } from '../functions/api/providers/webhook-apply.mjs';
import { hmacHex } from '../functions/api/providers/hmac.mjs';
import {
  PRODUCTION_MOOV_FUNCTIONS,
  productionMoovExecutionAllowed,
  productionWebhookApplyEnabled as holdApplyEnabled,
} from '../functions/api/providers/production/moov-holds.mjs';
import { productionCheckAltExecutionAllowed } from '../functions/api/providers/production/checkalt-holds.mjs';
import { moneyPathReadinessSnapshot } from '../functions/api/money-path-readiness.mjs';
import { loadProviderSecrets, resetProviderSecretsCache, webhookSecret } from '../functions/api/provider-secrets.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TRANSFER_ROW = {
  id: '55555555-5555-4555-8555-555555555555',
  tenant_id: FREEDOM_TENANT,
  status: 'submitted',
  destination_recipient_id: null,
  amount_cents: 1,
  wallet_id: null,
  leg_role: null,
  transfer_group_id: null,
  claim_id: null,
  check_id: null,
  description: 'production penny',
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetProviderSecretsCache();
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProviderSecretsCache();
  }
};

const jwtEvent = (pathName, method, body, extra = {}) => ({
  rawPath: pathName,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    ...(extra.headers || {}),
  },
  body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  requestContext: {
    stage: 'prep',
    http: { method, path: pathName },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || 'c4386408-60e1-70e2-abb6-e6194e8e635f', email: 'owner@freedomadj.com', token_use: 'id' } },
    },
  },
});

const productionMoneyFlags = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_CHECKALT_ENABLED: 'true',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
  AWS_PROVIDER_WEBHOOK_DRY_RUN: 'false',
};

test('staging templates keep money-movement flags false', () => {
  const template = fs.readFileSync(path.join(ROOT, 'aws/template.yaml'), 'utf8');
  assert.match(template, /AWS_CHECKALT_ENABLED: "false"/);
  assert.match(template, /AWS_MOOV_ENABLED: "false"/);
  assert.match(template, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  const api = fs.readFileSync(path.join(ROOT, 'aws/production/api-cfn.yaml'), 'utf8');
  assert.match(api, /AWS_CHECKALT_ENABLED: "false"/);
  assert.match(api, /AWS_PROVIDER_WEBHOOK_DRY_RUN: "true"/);
});

test('SQL 64/65 files remain NOT_APPLIED stubs', () => {
  const sql64 = fs.readFileSync(path.join(ROOT, 'aws/financial/sql/64_financial_activation_grants.sql'), 'utf8');
  const sql65 = fs.readFileSync(path.join(ROOT, 'aws/financial/sql/65_checkalt_production_writer.sql'), 'utf8');
  assert.match(sql64, /NOT_APPLIED/);
  assert.match(sql65, /DO NOT APPLY/);
});

test('dedicated Moov webhook secret ARN wins and empty values stay fail-closed', async () => {
  await withEnv({
    PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:provider',
    MOOV_WEBHOOK_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:moov-webhook',
    AWS_MOOV_WEBHOOK_SECRET: undefined,
  }, async () => {
    const secrets = await loadProviderSecrets(async (arn) => {
      if (String(arn).includes('moov-webhook')) return JSON.stringify({ MOOV_WEBHOOK_SECRET: 'dedicated-new-secret' });
      return JSON.stringify({ MOOV_PUBLIC_KEY: 'pk', MOOV_WEBHOOK_SECRET: 'should-not-win' });
    });
    assert.equal(webhookSecret(secrets, 'moov'), 'dedicated-new-secret');
  });
  await withEnv({
    MOOV_WEBHOOK_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:moov-webhook',
  }, async () => {
    const secrets = await loadProviderSecrets(async () => JSON.stringify({ MOOV_WEBHOOK_SECRET: '' }));
    assert.equal(webhookSecret(secrets, 'moov'), null);
  });
});

test('production webhook apply stays off unless money-path gates and dry-run=false', async () => {
  await withEnv({}, async () => {
    assert.equal(productionWebhookApplyEnabled(), false);
    assert.equal(holdApplyEnabled(), false);
    assert.equal(sandboxWebhookApplyEnabled(), false);
  });
  await withEnv({
    ...productionMoneyFlags,
    AWS_PROVIDER_WEBHOOK_DRY_RUN: 'true',
  }, async () => {
    assert.equal(productionWebhookApplyEnabled(), false);
    assert.equal(productionMoovExecutionAllowed(), true);
    assert.equal(productionCheckAltExecutionAllowed(), true);
  });
  await withEnv(productionMoneyFlags, async () => {
    assert.equal(productionWebhookApplyEnabled(), true);
    assert.equal(sandboxWebhookApplyEnabled(), false);
  });
});

test('production apply updates production transfers and still refuses when gates are off', async () => {
  const queries = [];
  const productionClient = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO public.payment_webhook_events')) {
        return { rows: [{ id: 'evt-1' }] };
      }
      if (sql.includes('FROM public.payment_provider_accounts') && sql.includes('environment = $2')) {
        return { rows: [{ id: 'acct-prod', tenant_id: FREEDOM_TENANT, environment: 'production', onboarding_status: 'active' }] };
      }
      if (sql.includes('FROM public.payment_transfers')) return { rows: [TRANSFER_ROW] };
      if (sql.includes('UPDATE public.payment_transfers')) return { rows: [{ id: TRANSFER_ROW.id }] };
      return { rows: [] };
    },
  };
  await withEnv(productionMoneyFlags, async () => {
    const applied = await applyMoovWebhook(productionClient, {
      type: 'transfer.updated',
      accountID: 'prod-acct',
      data: { transferID: 'tr_prod_1', status: 'completed' },
    }, { mappedTenantId: FREEDOM_TENANT, environment: 'production', eventId: 'wh_prod_1' });
    assert.equal(applied.applied, true);
    assert.equal(applied.environment, 'production');
    assert.equal(applied.productionRecordsMutated, true);
    assert.ok(applied.mutations.includes('payment_transfers'));
    assert.ok(queries.some((q) => q.sql.includes('INSERT INTO public.payment_webhook_events')));
  });

  const refused = await applyMoovWebhook({
    query: async (sql) => {
      if (sql.includes('environment = \'production\'')) return { rows: [{ id: 'prod-1', environment: 'production' }] };
      return { rows: [] };
    },
  }, {
    type: 'account.updated',
    accountID: 'prod-acct',
    data: {},
  }, { environment: 'production', eventId: 'wh_off' });
  assert.equal(refused.applied, false);
  assert.equal(refused.skipped, 'production_apply_disabled');
});

test('unsigned production webhook is rejected; valid signature applies production events', async () => {
  const secret = 'new-aws-moov-webhook-secret';
  const webhookId = 'evt_prod_apply';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n-prod';
  const rawBody = JSON.stringify({
    eventID: webhookId,
    type: 'transfer.updated',
    accountID: 'prod-acct',
    data: { transferID: 'tr_prod_1', status: 'completed' },
  });
  const signature = hmacHex(secret, `${timestamp}|${nonce}|${webhookId}`, 'sha512');
  const client = {
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql.includes('aws_lookup_provider_account')) {
        return { rows: [{ id: 'acct-1', tenant_id: FREEDOM_TENANT }] };
      }
      if (sql.includes('INSERT INTO public.aws_provider_webhook_receipts')) {
        return { rows: [{ id: 'receipt-prod', provider: params[0], external_event_id: params[1] }] };
      }
      if (sql.includes('INSERT INTO public.payment_webhook_events')) return { rows: [{ id: 'evt-1' }] };
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return { rows: [{ id: 'acct-1', tenant_id: FREEDOM_TENANT, environment: 'production' }] };
      }
      if (sql.includes('FROM public.payment_transfers')) return { rows: [TRANSFER_ROW] };
      if (sql.includes('UPDATE public.payment_transfers')) return { rows: [TRANSFER_ROW] };
      return { rows: [] };
    },
  };
  const unsigned = jwtEvent('/webhooks/moov', 'POST', rawBody, { auth: null });
  await withEnv(productionMoneyFlags, async () => {
    const rejected = await handleProviderRequest(unsigned, '/webhooks/moov', 'POST', {
      loadProviderSecrets: async () => ({ MOOV_WEBHOOK_SECRET: secret }),
      loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => client,
    });
    assert.equal(rejected.statusCode, 401);
    assert.ok(['invalid_signature', 'missing_signature_headers'].includes(rejected.error));
  });

  const signed = jwtEvent('/webhooks/moov', 'POST', rawBody, {
    auth: null,
    headers: { 'x-webhook-id': webhookId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': signature },
  });
  await withEnv(productionMoneyFlags, async () => {
    const applied = await handleProviderRequest(signed, '/webhooks/moov', 'POST', {
      loadProviderSecrets: async () => ({ MOOV_WEBHOOK_SECRET: secret }),
      loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => client,
    });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.applied, true);
    assert.equal(applied.dry_run, false);
    assert.equal(applied.productionRecordsMutated, true);
    assert.equal(applied.existingLovableWebhookUntouched, true);
  });
});

test('production Moov dispatch is registered and still blocked without financial activation', async () => {
  for (const name of PRODUCTION_MOOV_FUNCTIONS) {
    assert.ok(PRODUCTION_MOOV_FUNCTIONS.has(name));
  }
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'true',
    AWS_CHECKALT_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  }, async () => {
    assert.equal(productionMoovExecutionAllowed(), false);
    const transfer = await handler(jwtEvent('/functions/v1/moov-transfer-create', 'POST', { amount: 10 }));
    const transferBody = JSON.parse(transfer.body);
    assert.equal(transfer.statusCode, 403);
    assert.equal(transferBody.error, 'production_execution_blocked');
  });
});

test('SQL 67 gates payment_webhook_events writes to checksops + apply GUCs only', () => {
  const sql67 = fs.readFileSync(path.join(ROOT, 'aws/financial/sql/67_payment_webhook_events_apply_rls.sql'), 'utf8');
  assert.match(sql67, /TO checksops/);
  assert.match(sql67, /request\.provider_webhook_apply/);
  assert.match(sql67, /request\.aws_financial_permissions_activated/);
  assert.doesNotMatch(sql67, /TO authenticated/);
  assert.doesNotMatch(sql67, /TO PUBLIC/);
  assert.doesNotMatch(sql67, /TO anon/);
  assert.match(sql67, /environment = 'production'/);
});

test('Dashboard event.test is persistable and a swallowed events insert does not abort the receipt transaction', async () => {
  const ping = {
    eventID: 'd9d18a42-d1ea-4e4c-b671-0fa93e24d584',
    type: 'event.test',
    data: { ping: true },
    createdOn: '2026-09-14T13:22:04Z',
  };
  const queries = [];
  const client = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE') || sql.startsWith('ROLLBACK TO')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO public.payment_webhook_events')) {
        const err = new Error('new row violates row-level security policy for table "payment_webhook_events"');
        err.code = '42501';
        throw err;
      }
      return { rows: [] };
    },
  };
  await withEnv(productionMoneyFlags, async () => {
    const applied = await applyMoovWebhook(client, ping, {
      environment: 'production',
      eventId: ping.eventID,
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.note, 'event_recorded_no_financial_mutation');
    assert.equal(applied.financialTablesMutated, false);
    assert.ok(queries.some((q) => q.sql.startsWith('SAVEPOINT aws_record_webhook_event')));
    assert.ok(queries.some((q) => q.sql.startsWith('ROLLBACK TO SAVEPOINT aws_record_webhook_event')));
    const afterRollback = queries.findIndex((q) => q.sql.startsWith('ROLLBACK TO SAVEPOINT aws_record_webhook_event'));
    assert.ok(afterRollback >= 0);
    assert.ok(queries.slice(afterRollback + 1).some((q) => q.sql.startsWith('SAVEPOINT') || q.sql.includes('UPDATE public.payment_webhook_events')));
  });
});

test('money-path Class A equivalents exist for OCR and endorsement', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('check-ocr-intake'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('check-endorsement'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('checkalt-deposit-preflight'), true);
});

test('money-path readiness classifies unrelated holds separately and asks for a new webhook when secret is empty', async () => {
  await withEnv({
    ...productionMoneyFlags,
    CHECKSOPS_ENV: 'production-prep',
    MOOV_WEBHOOK_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/moov-webhook',
    PROVIDER_SECRETS_ARN: undefined,
  }, async () => {
    const snap = await moneyPathReadinessSnapshot();
    assert.equal(snap.unrelatedHolds.classifiedSeparately, true);
    assert.equal(snap.unrelatedHolds.doNotFailThisPhase, true);
    assert.equal(snap.existingLovableMoovWebhookUntouched, true);
    assert.equal(snap.moneyPath.checkIntake.ready, true);
    assert.equal(snap.moneyPath.endorsement.ready, true);
    assert.equal(snap.moneyPath.depositApproval.ready, true);
    assert.equal(snap.moneyPath.checkAlt.executable, true);
    assert.equal(snap.moneyPath.moovMoney.executable, true);
    assert.equal(snap.moneyPath.moovWebhookReceiver.secretValueConfigured, false);
    assert.equal(snap.verdict, 'OPERATOR ACTION REQUIRED — CREATE NEW MOOV WEBHOOK');
    assert.ok(snap.excludedFromThisPhase.includes('stripe'));
    assert.ok(snap.excludedFromThisPhase.includes('telnyx'));
    assert.ok(snap.excludedFromThisPhase.includes('resend'));
  });
});
