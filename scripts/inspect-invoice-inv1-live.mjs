#!/usr/bin/env node
/**
 * READ-ONLY INV1 inspect: download live Lambda zip, hash invoice + W2 files,
 * and invoke moov-invoice with a non-creating payload (no line items).
 * Never creates/sends an invoice, never emails, never moves money.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const PLATFORM_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const TESTER_SUB = 'f468b438-4081-7004-d865-a1b86eb19beb';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const invokeApi = (functionName, event) => {
  const tmp = path.join(os.tmpdir(), `inv1-invoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(tmp, { recursive: true });
  const payload = path.join(tmp, 'payload.json');
  const outfile = path.join(tmp, 'out.json');
  fs.writeFileSync(payload, JSON.stringify(event));
  execFileSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', functionName,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `fileb://${payload}`,
    outfile,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const raw = fs.readFileSync(outfile, 'utf8');
  let parsed = raw;
  try { parsed = JSON.parse(raw); } catch { /* keep */ }
  let body = parsed?.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* keep */ }
  }
  return {
    statusCode: parsed?.statusCode ?? null,
    body,
    headers: parsed?.headers || null,
  };
};

const jwtEvent = (rawPath, body, { sub, email } = {}) => ({
  rawPath,
  headers: { authorization: 'Bearer inspect-claims', 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
  requestContext: {
    stage: 'prep',
    http: { method: 'POST', path: rawPath },
    authorizer: {
      jwt: {
        claims: {
          sub: sub || TESTER_SUB,
          email: email || TESTER_EMAIL,
          token_use: 'id',
        },
      },
    },
  },
});

const extractInvoiceBlock = (text) => {
  const start = text.indexOf('export const invoice = {');
  const end = text.indexOf('export const platformBank = {');
  if (start < 0 || end < 0 || end <= start) return null;
  return text.slice(start, end);
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv1-inspect');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const loc = awsJson(['lambda', 'get-function', '--function-name', PROD_API]);
  const tmp = path.join(os.tmpdir(), `inv1-live-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const zipIn = path.join(tmp, 'live.zip');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  const unpacked = path.join(tmp, 'live');
  fs.mkdirSync(unpacked, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', unpacked]);

  const files = {
    'providers/parity/moov-onboard.mjs': path.join(unpacked, 'providers/parity/moov-onboard.mjs'),
    'providers/parity/moov-provider-env.mjs': path.join(unpacked, 'providers/parity/moov-provider-env.mjs'),
    'providers/parity/sweep-read.mjs': path.join(unpacked, 'providers/parity/sweep-read.mjs'),
    'providers/parity/moov-money.mjs': path.join(unpacked, 'providers/parity/moov-money.mjs'),
    'providers/parity/db.mjs': path.join(unpacked, 'providers/parity/db.mjs'),
    'providers/parity/caller.mjs': path.join(unpacked, 'providers/parity/caller.mjs'),
    'providers/parity/moov-functions.mjs': path.join(unpacked, 'providers/parity/moov-functions.mjs'),
    'providers/parity/moov-client.mjs': path.join(unpacked, 'providers/parity/moov-client.mjs'),
    'providers/parity/moov-rails.mjs': path.join(unpacked, 'providers/parity/moov-rails.mjs'),
    'providers/parity/rail-router.mjs': path.join(unpacked, 'providers/parity/rail-router.mjs'),
    'tenant-billing-engine.mjs': path.join(unpacked, 'tenant-billing-engine.mjs'),
    'tenant-billing-destination.mjs': path.join(unpacked, 'tenant-billing-destination.mjs'),
    'tenant-billing-handlers.mjs': path.join(unpacked, 'tenant-billing-handlers.mjs'),
  };
  const hashes = {};
  for (const [rel, file] of Object.entries(files)) {
    hashes[rel] = fs.existsSync(file) ? sha256(file) : null;
  }

  const onboard = fs.existsSync(files['providers/parity/moov-onboard.mjs'])
    ? fs.readFileSync(files['providers/parity/moov-onboard.mjs'], 'utf8')
    : '';
  const invoiceBlock = extractInvoiceBlock(onboard) || '';
  await writeFile(`${OUT}/production-invoice-handler.mjs.txt`, invoiceBlock || onboard.slice(0, 4000));

  const invoiceLookup = {
    hardcodedSandbox: /export const invoice = \{[\s\S]*?loadMoovAccount\(client, ctx\.tenantId, 'sandbox'\)/.test(onboard),
    usesProviderEnv: /export const invoice = \{[\s\S]*?requireMoovProviderEnvironment/.test(onboard),
    usesFailClosed: /export const invoice = \{[\s\S]*?failClosedMissingAccount/.test(onboard),
    setupMessage: (invoiceBlock.match(/fail\('([^']+payment account[^']*)'/) || [])[1] || null,
    apiVersion: (invoiceBlock.match(/INVOICE_API_VERSION = '([^']+)'/) || onboard.match(/const INVOICE_API_VERSION = '([^']+)'/) || [])[1] || null,
    scopesRead: invoiceBlock.includes('invoices.read'),
    scopesWrite: invoiceBlock.includes('invoices.write'),
    mentionsPlatformAccount: invoiceBlock.includes(PLATFORM_ACCOUNT),
    mentionsFreedomAccount: invoiceBlock.includes(FREEDOM_ACCOUNT),
  };

  const createNoItems = invokeApi(PROD_API, jwtEvent('/functions/v1/moov-invoice', {
    action: 'create',
    tenant_id: FREEDOM,
  }));
  const createAndSendNoItems = invokeApi(PROD_API, jwtEvent('/functions/v1/moov-invoice', {
    action: 'create_and_send',
    tenant_id: FREEDOM,
  }));
  const preflight = invokeApi(PROD_API, jwtEvent('/functions/v1/moov-invoice', {
    action: 'preflight',
    tenant_id: FREEDOM,
  }));
  const cross = invokeApi(PROD_API, jwtEvent('/functions/v1/moov-invoice', {
    action: 'create',
    tenant_id: OTHER,
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    invoiceCreated: false,
    emailSent: false,
    moneyMoved: false,
    production: {
      name: PROD_API,
      codeSha256: cfg.CodeSha256,
      revisionId: cfg.RevisionId,
      lastModified: cfg.LastModified,
      monthlyPost: cfg.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
      verificationPost: cfg.Environment?.Variables?.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED ?? null,
    },
    liveFileHashes: hashes,
    invoiceLookup,
    reproduce: {
      path: '/functions/v1/moov-invoice',
      frontendAction: 'create / create_and_send',
      functionName: 'moov-invoice',
      handler: 'providers/parity/moov-onboard.mjs#invoice',
      tenant_id: FREEDOM,
      createNoItems,
      createAndSendNoItems,
      preflight,
      crossTenant: {
        tenant_id: OTHER,
        statusCode: cross.statusCode,
        error: cross.body?.error || null,
      },
    },
    exactError: createNoItems.body?.error || createNoItems.body?.message || null,
    exactStatus: createNoItems.statusCode,
  };
  await writeFile(`${OUT}/live-inspect.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
