#!/usr/bin/env node
/**
 * Production INV3 preflight only. Does not create an invoice or call Moov writes.
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv3';
const PROD_API = 'checksops-production-prep-api';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_ACCOUNT = '60922058-7eca-4889-81dd-5720d7b9de96';
const TESTER_SUB = 'f468b438-4081-7004-d865-a1b86eb19beb';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' }));

const jwtEvent = (rawPath, body) => ({
  rawPath,
  headers: { authorization: 'Bearer inspect-claims', 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
  requestContext: {
    stage: 'prep',
    http: { method: 'POST', path: rawPath },
    authorizer: { jwt: { claims: { sub: TESTER_SUB, email: TESTER_EMAIL, token_use: 'id' } } },
  },
});

const invokeApi = (event) => {
  const tmp = path.join(os.tmpdir(), `inv3-pre-${Date.now()}`);
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

const main = async () => {
  await assumeCursorRole('invoice-inv3-preflight');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const freedom = invokeApi(jwtEvent('/functions/v1/moov-invoice', { action: 'preflight', tenant_id: FREEDOM }));
  const isolation = invokeApi(jwtEvent('/functions/v1/moov-invoice', { action: 'preflight', tenant_id: OTHER }));
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
      status: freedom.statusCode,
      environment: freedom.body?.environment || null,
      merchantAccountId: freedom.body?.merchantAccountId || null,
      error: freedom.body?.error || null,
      liveProviderCalled: freedom.body?.liveProviderCalled ?? null,
      matchesExpected: freedom.statusCode === 200
        && freedom.body?.environment === 'production'
        && freedom.body?.merchantAccountId === FREEDOM_ACCOUNT
        && freedom.body?.liveProviderCalled === false,
    },
    isolation: {
      status: isolation.statusCode,
      error: isolation.body?.error || null,
      denied: isolation.statusCode === 403 || isolation.body?.error === 'cross_tenant_denied',
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
