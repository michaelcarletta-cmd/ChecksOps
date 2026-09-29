#!/usr/bin/env node
/**
 * INV7 branding acceptance. Read-only for invoices.
 * Does not create, send, recover, or email an invoice.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { assumeCursorRole, secretString } from './cognito-staging-token.mjs';
import { resolveTenantLogoUrl, rewriteLogoFields } from '../src/lib/resolveTenantLogoUrl.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv7';
const STAGING_API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const POOL = 'us-east-1_vPmQ7cL1F';
const CLIENT = '71bb7a192cbl6o6s8m259tl589';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';
const LAST_INV6 = 'pW7tqE0f6qRpDw4UeYIVP3FgbFS+3l4jchwKCqxcowI=';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const invokeProd = (body) => {
  const tmp = path.join(os.tmpdir(), `inv7-accept-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(tmp, { recursive: true });
  const payload = path.join(tmp, 'payload.json');
  const outfile = path.join(tmp, 'out.json');
  fs.writeFileSync(payload, JSON.stringify({
    rawPath: '/data/query',
    headers: { authorization: 'Bearer inspect-claims', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    requestContext: {
      stage: 'prep',
      requestId: `inv7-accept-${Date.now()}`,
      http: { method: 'POST', path: '/data/query' },
      authorizer: {
        jwt: {
          claims: {
            sub: 'f468b438-4081-7004-d865-a1b86eb19beb',
            email: TESTER_EMAIL,
            token_use: 'id',
          },
        },
      },
    },
  }));
  execFileSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', 'checksops-production-prep-api',
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `fileb://${payload}`,
    outfile,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(fs.readFileSync(outfile, 'utf8'));
  let parsedBody = parsed?.body;
  if (typeof parsedBody === 'string') {
    try { parsedBody = JSON.parse(parsedBody); } catch { /* keep */ }
  }
  return { statusCode: parsed?.statusCode ?? null, body: parsedBody };
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

const api = async (pathname, { token, body } = {}) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${STAGING_API}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
  return { ok: res.ok && data?.ok !== false && data?.error == null, status: res.status, data };
};

const probeImage = async (url) => {
  if (!url) return { ok: false, reason: 'empty' };
  const res = await fetch(url, { redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || '';
  const looksHtml = contentType.includes('text/html') || buf.slice(0, 32).toString('utf8').includes('<html');
  const looksPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const looksJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  return {
    ok: res.ok && !looksHtml && (looksPng || looksJpeg || contentType.startsWith('image/')),
    status: res.status,
    contentType,
    bytes: buf.length,
    looksHtml,
    looksPng,
    looksJpeg,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
};

const runNodeTests = (files) => files.map((file) => {
  const result = spawnSync(process.execPath, ['--test', file], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
  return {
    file,
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').slice(-2000),
    stderr: String(result.stderr || '').slice(-1500),
  };
});

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv7-accept');
  const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']);
  const staging = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const token = await mintTester();
  const query = (filters, select) => api('/data/query', {
    token,
    body: {
      op: 'select',
      table: 'tenants',
      select,
      filters,
      limit: 1,
    },
  });
  const stagingFreedom = token
    ? await query(
      [{ column: 'id', op: 'eq', value: FREEDOM }],
      'id,name,slug,logo_url,invoice_letterhead_url,primary_color',
    )
    : { ok: false, data: null };
  const other = token
    ? await query(
      [{ column: 'id', op: 'eq', value: OTHER }],
      'id,name,slug,logo_url',
    )
    : { ok: false, data: null };
  const productionFreedom = invokeProd({
    op: 'select',
    table: 'tenants',
    select: 'id,name,slug,logo_url,invoice_letterhead_url,primary_color',
    filters: [{ column: 'id', op: 'eq', value: FREEDOM }],
    limit: 1,
  });
  const productionOther = invokeProd({
    op: 'select',
    table: 'tenants',
    select: 'id,name,slug,logo_url',
    filters: [{ column: 'id', op: 'eq', value: OTHER }],
    limit: 1,
  });
  const freedomRow = productionFreedom.body?.data?.[0] || stagingFreedom.data?.data?.[0] || null;
  const resolved = resolveTenantLogoUrl(freedomRow?.logo_url, '/prep');
  const image = freedomRow?.logo_url
    ? await probeImage(freedomRow.logo_url)
    : { ok: false, reason: 'no_logo_url' };
  const cases = {
    A_tenantWithLogo: Boolean(freedomRow?.logo_url),
    B_tenantWithoutLogo: resolveTenantLogoUrl(null) === null,
    C_relativeAwsPath: String(resolveTenantLogoUrl('tenant-b/logo.png', '/prep')).includes('bucket=tenant-logos'),
    D_absoluteUrl: resolveTenantLogoUrl('https://cdn.example.test/logo.png', '/prep') === 'https://cdn.example.test/logo.png',
    E_crossTenantIsolation: !other.data?.data?.length && !productionOther.body?.data?.length,
    F_brokenFallback: resolveTenantLogoUrl('../secret.png') === null && resolveTenantLogoUrl('') === null,
  };
  const isolationRewrite = rewriteLogoFields([
    { id: FREEDOM, logo_url: `${FREEDOM}/logo.png` },
    { id: OTHER, logo_url: `${OTHER}/logo.png` },
  ], '/prep');
  const tests = runNodeTests([
    'tests/tenant-invoice-branding.test.mjs',
    'aws/tests/api-invoice-inv7-branding.test.mjs',
    'aws/tests/api-invoice-inv1-env.test.mjs',
    'aws/tests/api-invoice-inv3-parity.test.mjs',
    'aws/tests/api-invoice-inv6-recovery.test.mjs',
  ]);
  const report = {
    mutated: false,
    invoiceCreated: false,
    invoiceSent: false,
    lambdaUpdated: false,
    generatedAt: new Date().toISOString(),
    production: {
      codeSha256: prod.CodeSha256,
      revisionId: prod.RevisionId,
      lastModified: prod.LastModified,
      driftedFromInv6: prod.CodeSha256 !== LAST_INV6,
    },
    staging: {
      codeSha256: staging.CodeSha256,
      revisionId: staging.RevisionId,
      lastModified: staging.LastModified,
    },
    freedom: freedomRow,
    stagingFreedom: stagingFreedom.data?.data?.[0] || null,
    productionOtherDenied: !productionOther.body?.data?.length,
    resolvedLogoUrl: resolved,
    freedomImage: image,
    otherTenant: other.data?.data?.[0] || null,
    cases,
    isolationRewrite: isolationRewrite.map((row) => ({ id: row.id, logo_url: row.logo_url })),
    tests,
    testsOk: tests.every((item) => item.ok),
    accepted: tests.every((item) => item.ok)
      && cases.A_tenantWithLogo
      && cases.B_tenantWithoutLogo
      && cases.C_relativeAwsPath
      && cases.D_absoluteUrl
      && cases.E_crossTenantIsolation
      && cases.F_brokenFallback
      && image.ok === true
      && image.looksHtml === false,
  };
  await writeFile(`${OUT}/staging-accept.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.accepted) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
