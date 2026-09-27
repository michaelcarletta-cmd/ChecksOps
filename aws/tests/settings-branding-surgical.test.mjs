import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pickAllowlistedValues, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const branding = read('src/components/settings/CompanyBrandingSettings.tsx');
const adminTenants = read('src/pages/admin/AdminTenants.tsx');
const profile = read('src/components/white-label/WhiteLabelSettings.tsx');
const users = read('src/components/white-label/TenantUserManager.tsx');
const partners = read('src/components/white-label/TenantPartnerManager.tsx');
const bank = read('src/components/settings/TenantBankAccountSettings.tsx');

const brandingSave = branding.slice(
  branding.indexOf('const saveSettings'),
  branding.indexOf('toast({ title: "Company settings saved" }'),
);
const brandingHero = branding.slice(
  branding.indexOf('<SettingsHero'),
  branding.indexOf('</SettingsHero>') + '</SettingsHero>'.length,
);
const adminSave = adminTenants.slice(
  adminTenants.indexOf('function BrandingTab'),
  adminTenants.indexOf('Save Branding') + 'Save Branding'.length,
);

test('Branding Settings hero matches the other Settings tab pattern', () => {
  assert.match(brandingHero, /title="Branding Settings"/);
  assert.match(brandingHero, /icon=\{<Palette className="h-4 w-4 text-primary" \/>\}/);
  assert.match(brandingHero, /badge="Identity & Branding"/);
  for (const src of [profile, users, partners, bank]) {
    assert.match(src, /<SettingsHero/);
    assert.match(src, /icon=\{</);
  }
});

test('Save Branding / company branding payloads omit the rejected columns', () => {
  assert.match(adminSave, /Save Branding/);
  assert.match(adminSave, /save\(\{ logo_url: logoUrl \|\| null, primary_color: primary \}\)/);
  assert.equal(adminSave.includes('secondary_color'), false);

  assert.match(brandingSave, /company_name: companyName/);
  assert.match(brandingSave, /letterhead_url: letterheadUrl/);
  assert.doesNotMatch(brandingSave, /logo_url: logoUrl,\s*letterhead_url/);
  assert.doesNotMatch(brandingSave, /updated_at:/);
  assert.doesNotMatch(brandingSave, /invoice_accent_color/);
  assert.doesNotMatch(brandingSave, /invoice_theme/);
  assert.match(brandingSave, /logo_url: logoUrl/);
  assert.match(brandingSave, /invoice_letterhead_url: invoiceLetterheadUrl/);
});

test('current branding write payloads are allowlisted; prior extras are the rejected columns', () => {
  const previousCompanyBranding = pickAllowlistedValues('company_branding', {
    company_name: 'Acme',
    company_address: '1 Main',
    company_phone: '555',
    company_email: 'ops@acme.test',
    logo_url: 'https://cdn.example/logo.png',
    letterhead_url: 'https://cdn.example/letter.png',
    updated_at: '2026-09-27T00:00:00.000Z',
  });
  assert.equal(previousCompanyBranding.error, 'column_not_allowlisted');
  assert.deepEqual(previousCompanyBranding.columns.sort(), ['logo_url', 'updated_at']);

  const currentCompanyBranding = pickAllowlistedValues('company_branding', {
    company_name: 'Acme',
    company_address: '1 Main',
    company_phone: '555',
    company_email: 'ops@acme.test',
    letterhead_url: 'https://cdn.example/letter.png',
  });
  assert.equal(currentCompanyBranding.error, undefined);
  assert.deepEqual(
    Object.keys(currentCompanyBranding.values).sort(),
    ['company_address', 'company_email', 'company_name', 'company_phone', 'letterhead_url'],
  );

  const previousTenants = pickAllowlistedValues('tenants', {
    logo_url: 'https://cdn.example/logo.png',
    primary_color: '#3B82F6',
    secondary_color: '#1E40AF',
  });
  assert.equal(previousTenants.error, 'column_not_allowlisted');
  assert.deepEqual(previousTenants.columns, ['secondary_color']);

  const currentAdminBranding = pickAllowlistedValues('tenants', {
    logo_url: 'https://cdn.example/logo.png',
    primary_color: '#3B82F6',
  });
  assert.equal(currentAdminBranding.error, undefined);

  const previousInvoiceExtras = pickAllowlistedValues('tenants', {
    logo_url: 'https://cdn.example/logo.png',
    invoice_letterhead_url: 'https://cdn.example/inv.png',
    invoice_footer_note: 'Thanks',
    invoice_default_terms: 'Net 30',
    invoice_accent_color: '#3B82F6',
    invoice_theme: 'light',
  });
  assert.equal(previousInvoiceExtras.error, 'column_not_allowlisted');
  assert.deepEqual(previousInvoiceExtras.columns.sort(), ['invoice_accent_color', 'invoice_theme']);

  const currentInvoice = pickAllowlistedValues('tenants', {
    logo_url: 'https://cdn.example/logo.png',
    invoice_letterhead_url: 'https://cdn.example/inv.png',
    invoice_footer_note: 'Thanks',
    invoice_default_terms: 'Net 30',
  });
  assert.equal(currentInvoice.error, undefined);
});

test('tenant write allowlist was not broadened', () => {
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('secondary_color'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('invoice_accent_color'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('invoice_theme'), false);
  assert.equal(WRITE_ALLOWLIST.company_branding.columns.has('logo_url'), false);
  assert.equal(WRITE_ALLOWLIST.company_branding.columns.has('updated_at'), false);
  assert.ok(WRITE_ALLOWLIST.tenants.columns.has('logo_url'));
  assert.ok(WRITE_ALLOWLIST.tenants.columns.has('primary_color'));
});
