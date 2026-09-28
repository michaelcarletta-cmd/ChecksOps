#!/usr/bin/env node
/**
 * Staging acceptance for INV6. No production email. No live customer invoice.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv6';
const API = 'checksops-staging-api';
const SYNTHETIC = 'a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';
const TESTER_SUB = 'f468b438-4081-7004-d865-a1b86eb19beb';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' }));

const jwtEvent = (rawPath, body, tenantClaims = {}) => ({
  rawPath,
  headers: { authorization: 'Bearer inspect-claims', 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: rawPath },
    authorizer: { jwt: { claims: { sub: tenantClaims.sub || TESTER_SUB, email: tenantClaims.email || TESTER_EMAIL, token_use: 'id' } } },
  },
});

const invokeApi = (event) => {
  const tmp = path.join(os.tmpdir(), `inv6-st-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(tmp, { recursive: true });
  const payload = path.join(tmp, 'payload.json');
  const outfile = path.join(tmp, 'out.json');
  fs.writeFileSync(payload, JSON.stringify(event));
  execFileSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', API,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `fileb://${payload}`,
    outfile,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(fs.readFileSync(outfile, 'utf8'));
  let body = parsed?.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* keep */ }
  }
  return { statusCode: parsed?.statusCode ?? null, body };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv6-staging-accept');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API]);
  const validation = invokeApi(jwtEvent('/functions/v1/moov-invoice', {
    action: 'create',
    tenant_id: SYNTHETIC,
  }));
  const recoverMissing = invokeApi(jwtEvent('/functions/v1/moov-invoice', {
    action: 'recover',
    tenant_id: SYNTHETIC,
  }));
  const cross = invokeApi(jwtEvent('/functions/v1/moov-invoice', {
    action: 'recover',
    tenant_id: OTHER,
    moov_invoice_id: 'existing-inv-1',
  }));
  const preflight = invokeApi(jwtEvent('/functions/v1/moov-invoice', {
    action: 'preflight',
    tenant_id: SYNTHETIC,
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    stagingSha: cfg.CodeSha256,
    validation: { status: validation.statusCode, error: validation.body?.error || null },
    recoverMissing: { status: recoverMissing.statusCode, error: recoverMissing.body?.error || null },
    crossTenant: { status: cross.statusCode, error: cross.body?.error || null },
    preflight: { status: preflight.statusCode, merchant: preflight.body?.merchantAccountId || null },
    productionEmail: false,
    liveInvoiceCreated: false,
  };
  await writeFile(`${OUT}/staging-acceptance.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
