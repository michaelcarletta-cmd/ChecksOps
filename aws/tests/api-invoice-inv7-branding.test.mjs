import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { invoice, INVOICE_API_VERSION } from '../functions/api/providers/parity/moov-onboard.mjs';
import { resetMoovTokenCache, withMoovContext } from '../functions/api/providers/parity/moov-client.mjs';
import {
  STAGING_ACCOUNT,
  STAGING_TENANT,
  accountRow,
  ctxOf,
  fakeInvoiceClient,
  invoiceStore,
  recordingFetch,
  sandboxMoovCtx,
} from './invoice-test-harness.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const runInvoice = async (store, body, fetchImpl) => {
  resetMoovTokenCache();
  return withMoovContext(sandboxMoovCtx(fetchImpl), () => invoice.run({
    client: fakeInvoiceClient(store),
    body,
    ctx: ctxOf(STAGING_TENANT, 'sandbox'),
    fetchImpl,
  }));
};

test('create_and_send still does not send an invented invoice logo field', async () => {
  const store = invoiceStore({
    accounts: [accountRow(STAGING_TENANT, 'sandbox', STAGING_ACCOUNT)],
    tenants: [{ id: STAGING_TENANT, invoice_footer_note: 'Pay within 15 days' }],
  });
  const { calls, fetchImpl } = recordingFetch();
  const result = await runInvoice(store, {
    action: 'create_and_send',
    tenant_id: STAGING_TENANT,
    customer_name: 'Acme Adjusting',
    customer_email: 'billing@acme.test',
    customer_type: 'business',
    line_items: [{ name: 'Fee', unit_price: 1, quantity: 1 }],
  }, fetchImpl);
  assert.equal(result.statusCode, 200);
  const invoicePost = calls.find((call) => call.method === 'POST' && call.url.includes('/invoices') && !call.url.includes('/oauth2/token'));
  assert.ok(invoicePost);
  assert.equal(invoicePost.body.logo, undefined);
  assert.equal(invoicePost.body.logoUrl, undefined);
  assert.equal(invoicePost.body.logoURL, undefined);
  assert.equal(invoicePost.body.imageURL, undefined);
  assert.equal(invoicePost.body.branding, undefined);
  assert.equal(invoicePost.body.footer, 'Pay within 15 days');
  assert.equal(INVOICE_API_VERSION, 'v2026.07.00');
});

test('invoice branding UI uses tenants.logo_url and does not add invoice_logo_url', () => {
  const invoicesTab = readFileSync(path.join(ROOT, '../../src/pages/payments/InvoicesTab.tsx'), 'utf8');
  assert.match(invoicesTab, /select\("name, logo_url, invoice_footer_note, invoice_default_terms"\)/);
  assert.match(invoicesTab, /tab=branding/);
  assert.equal(/invoice_letterhead_url/.test(invoicesTab), false);
  assert.equal(/invoice_logo_url/.test(invoicesTab), false);
  const branding = readFileSync(path.join(ROOT, '../../src/components/settings/CompanyBrandingSettings.tsx'), 'utf8');
  assert.match(branding, /No logo configured\. Add one in Branding & Appearance\./);
  assert.match(invoicesTab, /InvoiceBrandingLogoPreview/);
  assert.equal(/invoice-letterhead-upload/.test(branding), false);
  assert.equal(/invoice_logo_url/.test(branding), false);
  const onboard = readFileSync(path.join(ROOT, '../functions/api/providers/parity/moov-onboard.mjs'), 'utf8');
  assert.equal(/logoUrl|logoURL|imageURL/.test(onboard.slice(onboard.indexOf('action === \'create\''))), false);
});
