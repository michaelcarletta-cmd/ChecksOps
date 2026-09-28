#!/usr/bin/env node
/**
 * READ-ONLY INV7 freeze + Freedom logo identify. No invoice send. No logo write.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv7';
const PROD_API = 'checksops-production-prep-api';
const STAGING_API = 'checksops-staging-api';
const PROD_BUCKET = 'checksops-production-frontend-806168576068';
const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
const LAST_INV6 = 'pW7tqE0f6qRpDw4UeYIVP3FgbFS+3l4jchwKCqxcowI=';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TESTER_SUB = 'f468b438-4081-7004-d865-a1b86eb19beb';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
}));
const awsTry = (args) => {
  try { return { ok: true, data: awsJson(args) }; }
  catch (error) {
    return { ok: false, error: String(error.stderr || error.message || error).slice(0, 400) };
  }
};

const spaSnapshot = (bucket) => {
  const index = awsTry(['s3api', 'head-object', '--bucket', bucket, '--key', 'index.html']);
  let indexHtml = null;
  if (index.ok) {
    try {
      indexHtml = execFileSync(AWS, ['--region', REGION, 's3', 'cp', `s3://${bucket}/index.html`, '-'], {
        encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      });
    } catch { /* ignore */ }
  }
  return {
    bucket,
    index: index.ok
      ? {
        etag: index.data.ETag || null,
        lastModified: index.data.LastModified || null,
        sha256: indexHtml ? createHash('sha256').update(indexHtml).digest('hex') : null,
        js: (indexHtml || '').match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/)?.[1] || null,
        css: (indexHtml || '').match(/\/assets\/(index-[A-Za-z0-9._-]+\.css)/)?.[1] || null,
      }
      : { error: index.error },
  };
};

const jwtEvent = (rawPath, body) => ({
  rawPath,
  headers: { authorization: 'Bearer inspect-claims', 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
  requestContext: {
    stage: 'prep',
    requestId: `inv7-ro-${Date.now()}`,
    http: { method: 'POST', path: rawPath },
    authorizer: { jwt: { claims: { sub: TESTER_SUB, email: TESTER_EMAIL, token_use: 'id' } } },
  },
});

const invokeApi = (event) => {
  const tmp = path.join(os.tmpdir(), `inv7-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv7-freeze');
  const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const staging = awsJson(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const vars = prod.Environment?.Variables || {};
  const tenants = invokeApi(jwtEvent('/data/query', {
    op: 'select',
    table: 'tenants',
    select: 'id,name,slug,logo_url,invoice_letterhead_url,primary_color',
    filters: [{ column: 'id', op: 'eq', value: FREEDOM }],
    limit: 1,
  }));
  const other = invokeApi(jwtEvent('/data/query', {
    op: 'select',
    table: 'tenants',
    select: 'id,name,slug,logo_url',
    filters: [{ column: 'id', op: 'eq', value: '4f172140-f57a-4744-8050-95f4f07b13b4' }],
    limit: 1,
  }));
  const report = {
    mutated: false,
    invoiceCreated: false,
    generatedAt: new Date().toISOString(),
    lastAcceptedInv6Sha: LAST_INV6,
    production: {
      name: PROD_API,
      codeSha256: prod.CodeSha256,
      revisionId: prod.RevisionId,
      lastModified: prod.LastModified,
      driftedFromInv6: prod.CodeSha256 !== LAST_INV6,
      monthlyPost: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
      verificationPost: vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
      spa: spaSnapshot(PROD_BUCKET),
    },
    staging: {
      name: STAGING_API,
      codeSha256: staging.CodeSha256,
      revisionId: staging.RevisionId,
      lastModified: staging.LastModified,
      spa: spaSnapshot(STAGING_BUCKET),
    },
    freedom: tenants.body?.data?.[0] || null,
    otherTenant: other.body?.data?.[0] || null,
    otherTenantDeniedOrEmpty: !other.body?.data?.length,
  };
  await writeFile(`${OUT}/baseline.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
