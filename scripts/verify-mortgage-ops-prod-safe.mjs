#!/usr/bin/env node
/**
 * Read-only production verification after Mortgage Ops safe-mode promotion.
 * No Pull Now, no ACH, no env rewrite, no synthetic accepts.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole, secretString } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/mortgage-ops-prod-safe';
const PROD_API_NAME = 'checksops-production-prep-api';
const REHEARSAL = 'checksops-staging-rehearsal-oneshot';
const ONESHOT = 'checksops-prod-mortgage-ops-audit-2d41';
const PROD_API = 'https://checksops.com/prep';
const PROD_POOL = 'us-east-1_h00WorYMT';
const PROD_CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const OWNER_EMAIL = 'checksopsadmin@gmail.com';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const EXPECTED_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const EXPECTED_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const awsTry = (args) => {
  try {
    return { ok: true, data: awsJson(args) };
  } catch (error) {
    const text = String(error.stderr || error.stdout || error.message || error);
    return { ok: false, error: text.replace(/\s+/g, ' ').trim().slice(0, 500) };
  }
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};
const api = async (pathname, { token, body, method = 'POST' } = {}) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${PROD_API}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
  return { ok: res.ok && data?.ok !== false, status: res.status, data };
};

const invokeAudit = async () => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', REHEARSAL]);
  const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API_NAME]);
  const adminSecretArn = rehearsal.Environment?.Variables?.PROD_ADMIN_SECRET_ARN;
  const rdsHost = rehearsal.Environment?.Variables?.PROD_RDS_HOST;
  const staging = path.join(os.tmpdir(), 'checksops-mortgage-ops-prod-verify-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/mortgage-ops-prod-audit/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/mortgage-ops-prod-audit/package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-mortgage-ops-prod-verify.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = { Variables: { ADMIN_SECRET_ARN: adminSecretArn, RDS_HOST: rdsHost, DATABASE_NAME: 'checksops' } };
  awsJson(['lambda', 'update-function-code', '--function-name', ONESHOT, '--zip-file', `fileb://${zip}`]);
  waitFn(ONESHOT);
  awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--timeout', '90', '--environment', JSON.stringify(env)]);
  waitFn(ONESHOT);
  const outFile = path.join(os.tmpdir(), `mortgage-ops-prod-verify-${Date.now()}.json`);
  awsJson(['lambda', 'invoke', '--function-name', ONESHOT, '--cli-binary-format', 'raw-in-base64-out', outFile]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('mortgage-ops-prod-verify');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API_NAME]);
  const vars = cfg.Environment?.Variables || {};
  const flags = {
    AWS_MOOV_MONTHLY_BILLING_ENABLED: vars.AWS_MOOV_MONTHLY_BILLING_ENABLED ?? null,
    AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
    AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID ?? null,
    AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID ?? null,
  };
  const sql = await invokeAudit();

  let token = null;
  let auth = { attempted: false };
  try {
    const password = secretString('checksops/staging/master-uat-password');
    const minted = awsTry([
      'cognito-idp', 'admin-initiate-auth',
      '--user-pool-id', PROD_POOL,
      '--client-id', PROD_CLIENT,
      '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH',
      '--auth-parameters', `USERNAME=${OWNER_EMAIL},PASSWORD=${password}`,
    ]);
    token = minted.data?.AuthenticationResult?.IdToken || null;
    auth = { attempted: true, ok: Boolean(token), error: token ? null : minted.error };
  } catch (error) {
    auth = { attempted: true, ok: false, error: String(error.message || error).slice(0, 300) };
  }

  const preview = token ? await api('/tenant-billing-admin', {
    token,
    body: { action: 'preview', tenant_id: FREEDOM },
  }) : null;
  const snapshot = token ? await api('/tenant-billing-authorize', {
    token,
    body: { action: 'snapshot', tenant_id: FREEDOM },
  }) : null;
  const invoice = preview?.data?.invoice || snapshot?.data?.invoice || null;
  const tenant = preview?.data?.tenant || snapshot?.data?.tenant || preview?.data || snapshot?.data || {};

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    pullExecuted: false,
    liveDebitCreated: false,
    lambda: {
      codeSha256: cfg.CodeSha256,
      lastModified: cfg.LastModified,
      revisionId: cfg.RevisionId,
      flags,
      productionPostIsFalse: flags.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST === 'false',
      destinationMatchesExpected:
        flags.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID === EXPECTED_ACCOUNT
        && flags.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID === EXPECTED_METHOD,
    },
    sql,
    auth,
    previewStatus: preview?.status ?? null,
    snapshotStatus: snapshot?.status ?? null,
    freedomRates: {
      mortgageOpsInitialRateCents: tenant.mortgage_ops_initial_rate_cents
        ?? preview?.data?.mortgage_ops_initial_rate_cents
        ?? snapshot?.data?.mortgage_ops_initial_rate_cents
        ?? invoice?.mortgage_ops_initial_rate_cents
        ?? null,
      mortgageOpsAdditionalRateCents: tenant.mortgage_ops_additional_rate_cents
        ?? preview?.data?.mortgage_ops_additional_rate_cents
        ?? snapshot?.data?.mortgage_ops_additional_rate_cents
        ?? invoice?.mortgage_ops_additional_rate_cents
        ?? null,
    },
    invoice,
    pendingCharge: preview?.data?.pending_charge || snapshot?.data?.pending_charge || null,
    destination: preview?.data?.destination || snapshot?.data?.destination || null,
    rawKeys: {
      preview: preview?.data ? Object.keys(preview.data) : [],
      snapshot: snapshot?.data ? Object.keys(snapshot.data) : [],
    },
  };
  await writeFile(path.join(OUT, 'production-verify.json'), JSON.stringify(report, null, 2));
  if (preview?.data || snapshot?.data) {
    await writeFile(path.join(OUT, 'production-freedom-preview-raw.json'), JSON.stringify({
      preview: preview?.data || null,
      snapshot: snapshot?.data || null,
    }, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
