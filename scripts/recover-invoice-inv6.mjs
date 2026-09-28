#!/usr/bin/env node
/**
 * Local recovery of the existing Freedom invoice. GET + local persist only.
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
const INVOICE_ID = process.env.INV6_MOOV_INVOICE_ID || '3mwzr33igvd43nrbwuvb7mi4zi_inv';
const CUSTOMER_ID = process.env.INV6_MOOV_CUSTOMER_ID || '37995fe2-ad72-4a4b-a031-a8b9bce3c5e2';
const TESTER_SUB = 'f468b438-4081-7004-d865-a1b86eb19beb';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
}));

const jwtEvent = (rawPath, body) => ({
  rawPath,
  headers: { authorization: 'Bearer inspect-claims', 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
  requestContext: {
    stage: 'prep',
    requestId: `inv6-recover-${Date.now()}`,
    http: { method: 'POST', path: rawPath },
    authorizer: { jwt: { claims: { sub: TESTER_SUB, email: TESTER_EMAIL, token_use: 'id' } } },
  },
});

const invokeApi = (event) => {
  const tmp = path.join(os.tmpdir(), `inv6-rec-${Date.now()}`);
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

const query = (table, select) => invokeApi(jwtEvent('/data/query', {
  op: 'select',
  table,
  select,
  filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
  limit: 50,
}));

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv6-recover');
  const beforeCustomers = query('moov_invoice_customers', 'id,email,moov_account_id,environment');
  const beforeInvoices = query('moov_invoices', 'id,moov_invoice_id,status,customer_email,payment_link_url');
  const recovered = invokeApi(jwtEvent('/functions/v1/moov-invoice', {
    action: 'recover',
    tenant_id: FREEDOM,
    moov_invoice_id: INVOICE_ID,
  }));
  const afterCustomers = query('moov_invoice_customers', 'id,email,display_name,moov_account_id,customer_type,environment,created_at');
  const afterInvoices = query('moov_invoices', 'id,moov_invoice_id,invoice_number,customer_email,customer_name,status,total_amount,paid_amount,payment_link_url,sent_at,environment,moov_account_id,customer_moov_account_id');
  const report = {
    providerPost: false,
    providerPatch: false,
    expectedMerchant: FREEDOM_ACCOUNT,
    expectedInvoice: INVOICE_ID,
    expectedCustomer: CUSTOMER_ID,
    before: {
      customers: beforeCustomers.body?.data || [],
      invoices: beforeInvoices.body?.data || [],
    },
    recover: recovered,
    after: {
      customers: afterCustomers.body?.data || [],
      invoices: afterInvoices.body?.data || [],
    },
  };
  await writeFile(`${OUT}/production-recover.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const invoices = report.after.invoices.filter((row) => row.moov_invoice_id === INVOICE_ID);
  if (recovered.statusCode !== 200 || invoices.length !== 1) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
