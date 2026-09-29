#!/usr/bin/env node
/**
 * INV6 Phase 1: freeze production and identify the existing Freedom invoice.
 * GET only. No Moov POST/PATCH. No local writes.
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
const PROD_API = 'checksops-production-prep-api';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_ACCOUNT = '60922058-7eca-4889-81dd-5720d7b9de96';
const TESTER_SUB = 'f468b438-4081-7004-d865-a1b86eb19beb';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';
const TARGET_MS = Date.parse('2026-09-28T18:49:10Z');
const WINDOW_MS = 30 * 60 * 1000;

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
}));

const jwtEvent = (rawPath, body) => ({
  rawPath,
  headers: { authorization: 'Bearer inspect-claims', 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
  requestContext: {
    stage: 'prep',
    requestId: `inv6-ro-${Date.now()}`,
    http: { method: 'POST', path: rawPath },
    authorizer: { jwt: { claims: { sub: TESTER_SUB, email: TESTER_EMAIL, token_use: 'id' } } },
  },
});

const invokeApi = (event) => {
  const tmp = path.join(os.tmpdir(), `inv6-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(fs.readFileSync(outfile, 'utf8'));
  let body = parsed?.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* keep */ }
  }
  return { statusCode: parsed?.statusCode ?? null, body };
};

const invoiceTime = (inv) => {
  const raw = inv?.createdOn || inv?.createdAt || inv?.invoiceDate || inv?.sentOn || inv?.modifiedOn;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const flattenInvoices = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.invoices)) return data.invoices;
  if (Array.isArray(data?.data)) return data.data;
  return [];
};

const query = (table, select) => invokeApi(jwtEvent('/data/query', {
  op: 'select',
  table,
  select,
  filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
  limit: 50,
}));

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv6-identify');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const freeze = {
    generatedAt: new Date().toISOString(),
    functionName: PROD_API,
    codeSha256: cfg.CodeSha256,
    revisionId: cfg.RevisionId,
    lastModified: cfg.LastModified,
    monthlyPost: cfg.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
    verificationPost: cfg.Environment?.Variables?.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED ?? null,
  };
  await writeFile(`${OUT}/production-freeze.json`, JSON.stringify(freeze, null, 2));

  const list = invokeApi(jwtEvent('/functions/v1/moov-invoice', {
    action: 'list',
    tenant_id: FREEDOM,
  }));
  const invoices = flattenInvoices(list.body?.invoices ?? list.body);
  await writeFile(`${OUT}/provider-list-raw.json`, JSON.stringify({
    status: list.statusCode,
    error: list.body?.error || null,
    count: invoices.length,
    invoices,
  }, null, 2));

  const candidates = invoices.filter((inv) => {
    const ms = invoiceTime(inv);
    if (!ms) return false;
    return Math.abs(ms - TARGET_MS) <= WINDOW_MS;
  });
  const unpaidNear = invoices.filter((inv) => {
    const status = String(inv.status || '').toLowerCase();
    const ms = invoiceTime(inv);
    return (status === 'unpaid' || status === 'sent') && (!ms || Math.abs(ms - TARGET_MS) <= 24 * 60 * 60 * 1000);
  });

  const customers = query('moov_invoice_customers', 'id,email,display_name,moov_account_id,environment,created_at');
  const localInvoices = query('moov_invoices', 'id,moov_invoice_id,invoice_number,customer_email,status,total_amount,created_at,environment');

  const report = {
    mutated: false,
    providerPost: false,
    providerPatch: false,
    freeze,
    listStatus: list.statusCode,
    listError: list.body?.error || null,
    listMerchant: list.body?.environment || null,
    invoiceCount: invoices.length,
    candidateCount: candidates.length,
    unpaidNearCount: unpaidNear.length,
    candidates: candidates.map((inv) => ({
      invoiceID: inv.invoiceID || inv.id,
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      sentOn: inv.sentOn,
      createdOn: inv.createdOn || inv.createdAt || inv.invoiceDate,
      customerAccountID: inv.customerAccountID,
      totalAmount: inv.totalAmount,
      paidAmount: inv.paidAmount,
      paymentLinkURL: inv.paymentLinkURL,
      dueDate: inv.dueDate,
    })),
    unpaidNear: unpaidNear.map((inv) => ({
      invoiceID: inv.invoiceID || inv.id,
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      sentOn: inv.sentOn,
      createdOn: inv.createdOn || inv.createdAt || inv.invoiceDate,
      customerAccountID: inv.customerAccountID,
      totalAmount: inv.totalAmount,
    })),
    local: {
      customers: customers.body?.data || [],
      invoices: localInvoices.body?.data || [],
      customerError: customers.body?.error || null,
      invoiceError: localInvoices.body?.error || null,
    },
    stopIfAmbiguous: candidates.length > 1,
  };
  await writeFile(`${OUT}/identify.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
