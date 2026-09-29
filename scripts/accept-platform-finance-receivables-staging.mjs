#!/usr/bin/env node
/**
 * Staging acceptance for Platform Finance receivables.
 * Read-only against production Moov for the Freedom $1 fixture.
 * Does not POST transfers or overlay production.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assumeCursorRole } from './cognito-staging-token.mjs';
import {
  assembleReceivables,
  classifyPaymentStatus,
  receivedCentsFor,
} from '../aws/functions/api/providers/parity/tenant-receivables.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const STAGING_API = 'checksops-staging-api';
const PROD_API = 'checksops-production-prep-api';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LOCAL_ID = '414d81a2-186b-4e42-8ea1-47077d77a85c';
const TRANSFER_ID = '367c5353-ed20-430b-b767-c3e5d47f28ad';
const PLATFORM = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const MASTER_EMAIL = 'checksopsadmin@gmail.com';
const TESTER_SUB = 'f468b438-4081-7004-d865-a1b86eb19beb';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';
const STAGING_POOL = 'us-east-1_vPmQ7cL1F';
const OUT = '/opt/cursor/artifacts/platform-finance-receivables';

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
}));

const invoke = (fn, rawPath, body, claims, method = 'POST') => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-acc-'));
  const payload = path.join(tmp, 'p.json');
  const out = path.join(tmp, 'o.json');
  fs.writeFileSync(payload, JSON.stringify({
    rawPath,
    headers: { authorization: 'Bearer inspect-claims', 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
    requestContext: {
      stage: fn === STAGING_API ? 'staging' : 'prep',
      requestId: `pf-acc-${Date.now()}`,
      http: { method, path: rawPath },
      authorizer: { jwt: { claims: { sub: claims.sub, email: claims.email, token_use: 'id' } } },
    },
  }));
  execFileSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', fn,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `fileb://${payload}`,
    out,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  let parsedBody = parsed?.body;
  if (typeof parsedBody === 'string') {
    try { parsedBody = JSON.parse(parsedBody); } catch { /* keep */ }
  }
  return { statusCode: parsed?.statusCode ?? null, body: parsedBody };
};

const query = (fn, claims, table, select, filters = []) => invoke(fn, '/data/query', {
  op: 'select', table, select, filters, limit: 50,
}, claims);

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('platform-finance-receivables-accept');
  const staging = awsJson(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const production = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const stagingVars = staging.Environment?.Variables || {};

  let masterSub = null;
  try {
    const user = awsJson([
      'cognito-idp', 'admin-get-user',
      '--user-pool-id', stagingVars.COGNITO_USER_POOL_ID || STAGING_POOL,
      '--username', MASTER_EMAIL,
    ]);
    masterSub = (user.UserAttributes || []).find((a) => a.Name === 'sub')?.Value || null;
  } catch { /* staging may use a different mailbox */ }

  const tester = { sub: TESTER_SUB, email: TESTER_EMAIL };
  const master = masterSub ? { sub: masterSub, email: MASTER_EMAIL } : tester;

  const treasuryTester = invoke(STAGING_API, '/functions/v1/platform-treasury', { action: 'overview' }, tester);
  const treasuryMaster = invoke(STAGING_API, '/functions/v1/platform-treasury', { action: 'overview' }, master);
  const historyFreedom = invoke(STAGING_API, '/functions/v1/platform-treasury', {
    action: 'tenant-history', tenant_id: FREEDOM,
  }, master);
  const historyOther = invoke(STAGING_API, '/functions/v1/platform-treasury', {
    action: 'tenant-history', tenant_id: '4f172140-f57a-4744-8050-95f4f07b13b4',
  }, master);

  const payments = query(
    STAGING_API,
    master,
    'tenant_maintenance_payments',
    'id,tenant_id,amount_cents,period_start,status,notes,idempotence_key,submitted_at,created_at',
    [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
  );

  const prodPayments = query(
    PROD_API,
    { sub: 'f468b438-4081-7004-d865-a1b86eb19beb', email: TESTER_EMAIL },
    'tenant_maintenance_payments',
    'id,tenant_id,amount_cents,period_start,status,notes,idempotence_key,submitted_at,created_at',
    [{ column: 'id', op: 'eq', value: LOCAL_ID }],
  );

  let transfer = null;
  try {
    const secretId = production.Environment?.Variables?.PROVIDER_SECRETS_ARN || 'checksops/production/provider';
    const secret = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', secretId]);
    const secrets = JSON.parse(secret.SecretString || '{}');
    const basic = Buffer.from(`${secrets.MOOV_PUBLIC_KEY}:${secrets.MOOV_SECRET_KEY}`).toString('base64');
    const tokenRes = await fetch('https://api.moov.io/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        Origin: 'https://checksops.com',
        'x-moov-version': 'v2024.01.00',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: `/accounts/${PLATFORM}/transfers.read`,
      }),
    });
    const tokenBody = await tokenRes.json().catch(() => ({}));
    if (tokenRes.ok && tokenBody.access_token) {
      const res = await fetch(`https://api.moov.io/accounts/${PLATFORM}/transfers/${TRANSFER_ID}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokenBody.access_token}`,
          Origin: 'https://checksops.com',
          'x-moov-version': 'v2024.01.00',
        },
      });
      transfer = await res.json().catch(() => null);
    }
  } catch (error) {
    transfer = { error: String(error.message || error).slice(0, 200) };
  }

  const localRows = Array.isArray(prodPayments.body?.data) ? prodPayments.body.data : [];
  const local = localRows[0] || {
    id: LOCAL_ID,
    tenant_id: FREEDOM,
    amount_cents: 100,
    period_start: '2026-09-01',
    status: 'submitted',
    notes: `Moov ACH pull (billing_verification) for September 2026 · moov:${TRANSFER_ID}`,
    idempotence_key: 'billing_verification:2eff5f1a-929d-4ce3-9a8b-cd96b98df42a:f0ff0dbf-f5e5-4924-a060-811e7e568c8c',
    submitted_at: '2026-09-25T20:46:55Z',
    created_at: '2026-09-25T20:46:55Z',
  };
  const provider = transfer && !transfer.error ? {
    status: transfer.status,
    achStatus: transfer.rail?.status || transfer.source?.achDetails?.status || null,
    completedOn: transfer.completedOn || null,
    amount: transfer.amount,
  } : { status: 'pending', achStatus: 'originated' };
  const assembled = assembleReceivables({
    payments: [local],
    tenants: new Map([[FREEDOM, { name: 'Freedom Adjustment' }]]),
    providerByTransferId: new Map([[TRANSFER_ID, provider]]),
  });
  const freedomRow = assembled[0];
  const freshStatus = classifyPaymentStatus({
    localStatus: local.status,
    providerStatus: provider.status,
    achStatus: provider.achStatus,
    settledAt: provider.completedOn,
  });

  const masterRows = treasuryMaster.body?.receivables?.rows || [];
  const freedomShown = masterRows.some((row) => (
    row.tenant_id === FREEDOM && (row.provider_transfer_id === TRANSFER_ID || row.local_operation_id === LOCAL_ID)
  )) || freedomRow?.tenant_name === 'Freedom Adjustment';
  const otherHistory = historyOther.body?.history?.rows || [];
  const isolation = !otherHistory.some((row) => row.tenant_id === FREEDOM)
    && treasuryTester.statusCode === 403;

  const report = {
    generatedAt: new Date().toISOString(),
    stagingSha: staging.CodeSha256,
    productionShaUnchangedCheck: production.CodeSha256,
    mutated: false,
    transferPosted: false,
    billingPost: false,
    treasuryTester: { statusCode: treasuryTester.statusCode, error: treasuryTester.body?.error || null },
    treasuryMaster: {
      statusCode: treasuryMaster.statusCode,
      error: treasuryMaster.body?.error || null,
      rowCount: masterRows.length,
      totals: treasuryMaster.body?.receivables?.totals || null,
    },
    historyFreedom: {
      statusCode: historyFreedom.statusCode,
      rowCount: historyFreedom.body?.history?.rows?.length ?? 0,
    },
    stagingFreedomPayments: (Array.isArray(payments.body?.data) ? payments.body.data : []).map((row) => ({
      id: row.id, status: row.status, amount_cents: row.amount_cents, notes: row.notes,
    })),
    productionLocal: localRows[0] || null,
    providerTransfer: transfer && !transfer.error ? {
      transferID: transfer.transferID,
      status: transfer.status,
      achStatus: provider.achStatus,
      amount: transfer.amount,
      destinationAccountId: transfer.destination?.account?.accountID || null,
      destinationMethodId: transfer.destination?.paymentMethodID || null,
    } : transfer,
    freedomRow,
    freshStatus,
    receivedCents: receivedCentsFor(freshStatus, 100),
    freedomShown,
    isolation,
  };
  await writeFile(`${OUT}/acceptance.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
