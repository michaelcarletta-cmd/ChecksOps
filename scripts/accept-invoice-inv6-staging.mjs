#!/usr/bin/env node
/**
 * Staging INV6 acceptance. Validation / isolation / recover-guard only.
 * No production email. No live customer invoice. No Moov POST/PATCH.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { assumeCursorRole, secretString } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv6';
const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const POOL = 'us-east-1_vPmQ7cL1F';
const CLIENT = '71bb7a192cbl6o6s8m259tl589';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_PROD = '60922058-7eca-4889-81dd-5720d7b9de96';
const SYNTHETIC = 'a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';
const PLATFORM = '41cb5d67-4911-4bef-aad5-d8ee9c582208';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};

const mintTester = async () => {
  const password = secretString('checksops/staging/master-uat-password');
  try {
    awsJson([
      'cognito-idp', 'admin-set-user-password',
      '--user-pool-id', POOL,
      '--username', TESTER_EMAIL,
      '--password', password,
      '--permanent',
    ]);
  } catch { /* already set */ }
  const auth = awsJson([
    'cognito-idp', 'admin-initiate-auth',
    '--user-pool-id', POOL,
    '--client-id', CLIENT,
    '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH',
    '--auth-parameters', `USERNAME=${TESTER_EMAIL},PASSWORD=${password}`,
  ]);
  return auth.AuthenticationResult?.IdToken || null;
};

const api = async (pathname, { token, body, method = 'POST' } = {}) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
  return { ok: res.ok && data?.ok !== false && data?.error == null, status: res.status, data };
};

const mentions = (data, id) => JSON.stringify(data || {}).includes(id);

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv6-staging-accept');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const token = await mintTester();
  const invoice = (body) => api('/functions/v1/moov-invoice', { token, body });
  const synthetic = token ? await invoice({ action: 'preflight', tenant_id: SYNTHETIC }) : { ok: false, error: 'no_token' };
  const freedom = token ? await invoice({ action: 'preflight', tenant_id: FREEDOM }) : { ok: false, error: 'no_token' };
  const recoverMissing = token
    ? await invoice({ action: 'recover', tenant_id: SYNTHETIC })
    : { ok: false, error: 'no_token' };
  const recoverOther = token
    ? await invoice({ action: 'recover', tenant_id: OTHER, moov_invoice_id: 'existing-inv-1' })
    : { ok: false, error: 'no_token' };
  const missingName = token
    ? await invoice({
      action: 'create',
      tenant_id: SYNTHETIC,
      customer_email: 'staging-inv6@example.test',
      line_items: [{ name: 'x', unit_price: 1, quantity: 1 }],
    })
    : { ok: false, error: 'no_token' };
  const unknownTenant = '00000000-0000-4000-8000-000000000001';
  const cross = token ? await invoice({ action: 'preflight', tenant_id: OTHER }) : { ok: false, error: 'no_token' };
  const unknown = token ? await invoice({ action: 'preflight', tenant_id: unknownTenant }) : { ok: false, error: 'no_token' };
  const merchant = synthetic.data?.merchantAccountId || null;
  const liveMoovSafe = !merchant || !/^[0-9a-f-]{36}$/i.test(String(merchant));

  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    invoiceCreated: false,
    emailSent: false,
    moneyMoved: false,
    liveMoovWrites: false,
    productionEmail: false,
    liveMoovWritesSkipped: liveMoovSafe
      ? 'Synthetic merchant is not a live sandbox account UUID; create/send/recover-GET not invoked on staging.'
      : null,
    stagingSha: cfg.CodeSha256,
    tokenOk: Boolean(token),
    synthetic: {
      tenant_id: SYNTHETIC,
      status: synthetic.status,
      environment: synthetic.data?.environment || null,
      merchantAccountId: merchant,
      usedProductionAccount: mentions(synthetic.data, FREEDOM_PROD),
      usedPlatformAccount: mentions(synthetic.data, PLATFORM),
    },
    freedomStaging: {
      tenant_id: FREEDOM,
      status: freedom.status,
      environment: freedom.data?.environment || null,
      merchantAccountId: freedom.data?.merchantAccountId || null,
      error: freedom.data?.error || freedom.error || null,
      usedProductionAccount: mentions(freedom.data, FREEDOM_PROD),
    },
    recoverMissing: {
      status: recoverMissing.status,
      error: recoverMissing.data?.error || recoverMissing.error || null,
      surfaced: recoverMissing.data?.error === 'moov_invoice_id is required'
        || recoverMissing.data?.message === 'moov_invoice_id is required',
    },
    isolation: {
      recoverOther: { status: recoverOther.status, error: recoverOther.data?.error || recoverOther.error || null },
      otherTenant: { status: cross.status, error: cross.data?.error || cross.error || null },
      unknownTenant: { status: unknown.status, error: unknown.data?.error || unknown.error || null },
      denied: [recoverOther, cross, unknown].some((row) => (
        row.status === 403
        || row.status === 404
        || row.data?.error === 'cross_tenant_denied'
        || row.data?.error === 'Organization not found'
      )),
    },
    validation: {
      missingName: {
        status: missingName.status,
        error: missingName.data?.error || missingName.error || null,
        surfaced: missingName.data?.error === 'Customer name is required',
      },
    },
    productionAccountNeverUsed: !mentions(synthetic.data, FREEDOM_PROD)
      && !mentions(freedom.data, FREEDOM_PROD)
      && !mentions(recoverMissing.data, FREEDOM_PROD)
      && !mentions(recoverOther.data, FREEDOM_PROD)
      && !mentions(missingName.data, FREEDOM_PROD),
  };
  await writeFile(`${OUT}/staging-acceptance.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.productionAccountNeverUsed) process.exit(2);
  if (!report.isolation.denied) process.exit(2);
  if (!report.recoverMissing.surfaced) process.exit(2);
  if (!report.validation.missingName.surfaced) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
