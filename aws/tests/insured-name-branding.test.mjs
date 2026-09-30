import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const insuredNameFromDeposit = (row) => {
  const item = row?.check_intake_items;
  if (!item?.claim_id) return '—';
  const linked = Array.isArray(item.claims) ? item.claims[0] : item.claims;
  const name = linked?.policyholder_name ?? item.policyholder_name;
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed || '—';
};

test('bank deposits join insured name through claim_id and never use payee_line', () => {
  const src = read('src/components/deposit-ops/BankDepositReconciliation.tsx');
  assert.match(src, /Insured Name/);
  assert.match(src, /claims:claim_id\(policyholder_name\)/);
  assert.match(src, /from\("claims"\)/);
  assert.match(src, /\.select\("id, policyholder_name"\)/);
  assert.match(src, /insuredNameFromDeposit/);
  assert.match(src, /Never falls back to payee_line/);
  assert.doesNotMatch(src, /payee_line\s*\|\||\?\?.*payee_line|payee_line\s*\?\?/);
  assert.doesNotMatch(src, />Payee</);
  assert.match(src, /Check #,Carrier,Insured Name,Claim #,Reference,Status,Amount/);
  assert.match(src, /not\("status", "in", "\(rejected,returned,error,declined\)"\)/);

  assert.equal(
    insuredNameFromDeposit({
      check_intake_items: {
        claim_id: TENANT,
        claims: { policyholder_name: 'Jane Insured' },
        payee_line: 'Jane Insured AND Freedom Adjustment LLC AND Bank',
      },
    }),
    'Jane Insured',
  );
  assert.equal(
    insuredNameFromDeposit({
      check_intake_items: {
        claim_id: null,
        claims: { policyholder_name: 'Should Not Use' },
        payee_line: 'Long Payee Line',
      },
    }),
    '—',
  );
  assert.equal(
    insuredNameFromDeposit({
      check_intake_items: {
        claim_id: TENANT,
        claims: { policyholder_name: '   ' },
        payee_line: 'Long Payee Line',
      },
    }),
    '—',
  );
});

test('company logo display prefers branding binary route over storage 302 hops', () => {
  const src = read('src/lib/tenantLogoUrl.ts');
  assert.match(src, /branding\/logo\/\$\{tenantId/);
  assert.match(src, /export function persistableLogoField/);
  assert.match(src, /export function resolveTenantAssetUrl/);
  assert.match(src, /export function tenantIdFromStoredLogo/);
  assert.match(src, /company-branding/);
  assert.match(src, /blob:/);
  assert.match(src, /return undefined;/);

  const stored = `https://checksops.com/prep/storage/public?bucket=tenant-logos&path=${TENANT}/logo-1790615777558.png`;
  const pathFromStored = new URL(stored).searchParams.get('path');
  assert.equal(pathFromStored, `${TENANT}/logo-1790615777558.png`);
  assert.match(src, new RegExp(String.raw`brandingLogoUrl\(tenantId, base\)`));
  assert.match(src, /if \(canonical\) return canonical;/);
  assert.match(src, /return undefined;/);
});

test('login, header, invoice, and save paths keep independent invoice logo and omit blank logos', () => {
  const login = read('src/components/white-label/WhiteLabelLogin.tsx');
  const header = read('src/components/white-label/WhiteLabelCheckCenter.tsx');
  const settingsHeader = read('src/components/white-label/WhiteLabelSettings.tsx');
  const company = read('src/components/settings/CompanyBrandingSettings.tsx');
  const email = read('src/components/settings/EmailSenderSettings.tsx');
  const invoice = read('src/pages/PublicInvoicePage.tsx');
  const invoiceTab = read('src/pages/payments/InvoicesTab.tsx');
  const handlers = read('aws/functions/api/tenant-settings-handlers.mjs');
  const emailHandlers = read('aws/functions/api/tenant-email-domain-handlers.mjs');

  assert.match(login, /tenantId=\{tenant\.id\}/);
  assert.match(header, /tenantId=\{tenant\?\.id\}/);
  assert.match(settingsHeader, /tenantId=\{tenant\?\.id\}/);
  assert.match(company, /from\(bucket\)/);
  assert.match(company, /"tenant-logos"/);
  assert.match(company, /"company-branding"/);
  assert.match(company, /persistableLogoField/);
  assert.match(company, /persistLogo \? \{ logo_url: persistLogo \}/);
  assert.match(company, /persistInvoice \? \{ invoice_letterhead_url: persistInvoice \}/);
  assert.match(email, /persistLogo \? \{ logoUrl: persistLogo \}/);
  assert.match(invoice, /assetBucket="company-branding"/);
  assert.match(invoice, /TenantLogo/);
  assert.match(invoiceTab, /logo_url/);
  assert.match(invoiceTab, /TenantLogo/);
  assert.match(handlers, /if \(value === undefined \|\| value === null \|\| value === ''\) return undefined;/);
  assert.match(emailHandlers, /if \(raw !== null && raw !== ''\) \{/);
  assert.doesNotMatch(email, /Sending subdomain/);
  assert.doesNotMatch(email, /Sending Subdomain/);
});
