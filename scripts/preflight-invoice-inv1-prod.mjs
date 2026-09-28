#!/usr/bin/env node
/**
 * Production INV1 preflight only. Never creates/sends an invoice.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv1';
const PROD_API = 'checksops-production-prep-api';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_ACCOUNT = '60922058-7eca-4889-81dd-5720d7b9de96';
const PLATFORM = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const TESTER_SUB = 'f468b438-4081-7004-d865-a1b86eb19beb';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const invokeApi = (event) => {
  const tmp = path.join(os.tmpdir(), `inv1-prod-preflight-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const payload = path.join(tmp, 'payload.json');
  const outfile = path.join(tmp, 'out.json');
  fs.writeFileSync(payload, JSON.stringify(event));
  execFileSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', PROD_API,
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

const jwtEvent = (body, sub = TESTER_SUB, email = TESTER_EMAIL) => ({
  rawPath: '/functions/v1/moov-invoice',
  headers: { authorization: 'Bearer inspect-claims', 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
  requestContext: {
    stage: 'prep',
    http: { method: 'POST', path: '/functions/v1/moov-invoice' },
    authorizer: { jwt: { claims: { sub, email, token_use: 'id' } } },
  },
});

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv1-prod-preflight');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const preflight = invokeApi(jwtEvent({ action: 'preflight', tenant_id: FREEDOM }));
  const cross = invokeApi(jwtEvent({ action: 'preflight', tenant_id: OTHER }));
  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    invoiceCreated: false,
    emailSent: false,
    moneyMoved: false,
    production: {
      codeSha256: cfg.CodeSha256,
      revisionId: cfg.RevisionId,
      lastModified: cfg.LastModified,
      monthlyPost: cfg.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
      verificationPost: cfg.Environment?.Variables?.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED ?? null,
    },
    freedom: {
      tenant_id: FREEDOM,
      status: preflight.statusCode,
      environment: preflight.body?.environment || null,
      merchantAccountId: preflight.body?.merchantAccountId || null,
      error: preflight.body?.error || null,
      liveProviderCalled: preflight.body?.liveProviderCalled ?? null,
      matchesExpected: preflight.body?.environment === 'production'
        && preflight.body?.merchantAccountId === FREEDOM_ACCOUNT
        && preflight.body?.merchantAccountId !== PLATFORM
        && preflight.statusCode === 200,
    },
    isolation: {
      status: cross.statusCode,
      error: cross.body?.error || null,
      denied: cross.statusCode === 403 || cross.body?.error === 'cross_tenant_denied',
    },
  };
  await writeFile(`${OUT}/production-preflight.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.freedom.matchesExpected) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
