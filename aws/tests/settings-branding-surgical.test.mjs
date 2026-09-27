import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pickAllowlistedValues, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const branding = read('src/components/settings/CompanyBrandingSettings.tsx');
const tenantBranding = read('src/components/settings/TenantBrandingSettings.tsx');
const adminTenants = read('src/pages/admin/AdminTenants.tsx');
const profile = read('src/components/white-label/WhiteLabelSettings.tsx');
const users = read('src/components/white-label/TenantUserManager.tsx');
const partners = read('src/components/white-label/TenantPartnerManager.tsx');
const bank = read('src/components/settings/TenantBankAccountSettings.tsx');
const banner = read('src/components/AwsStagingBanner.tsx');
const deleteBridge = read('src/integrations/aws/deleteCheckBridge.ts');
const logoResolver = read('src/lib/tenantLogoUrl.ts');
const emailPreview = read('src/components/settings/SignatureRequestEmailPreview.tsx');
const commandCenter = read('src/pages/CheckCommandCenter.tsx');
const imageInvariants = read('src/lib/checkImageInvariants.ts');
const writeAllowlist = read('aws/functions/api/write-allowlist.mjs');

const brandingSave = branding.slice(
  branding.indexOf('const saveSettings'),
  branding.indexOf('toast({ title: "Company settings saved" }'),
);
const brandingHero = branding.slice(
  branding.indexOf('<SettingsHero'),
  branding.indexOf('title="Company Information"'),
);
const tenantHero = tenantBranding.slice(
  tenantBranding.indexOf('<SettingsHero'),
  tenantBranding.indexOf('data-testid="tenant-branding-settings"'),
);
const tenantSave = tenantBranding.slice(
  tenantBranding.indexOf('const handleSave'),
  tenantBranding.indexOf('toast({ title: "Branding updated"'),
);
const adminBrandingTab = adminTenants.slice(
  adminTenants.indexOf('function BrandingTab'),
  adminTenants.indexOf('/* ---------------- Users Tab ---------------- */'),
);

test('Branding Settings hero matches the other Settings tab pattern', () => {
  assert.match(brandingHero, /title="Branding Settings"/);
  assert.match(brandingHero, /icon=\{<Palette className="h-4 w-4 text-primary" \/>\}/);
  assert.match(brandingHero, /badge="Identity & Branding"/);
  assert.match(tenantHero, /title="Branding Settings"/);
  assert.match(tenantHero, /icon=\{<Palette className="h-4 w-4 text-primary" \/>\}/);
  assert.match(tenantHero, /badge="Identity & Branding"/);
  for (const src of [profile, users, partners, bank]) {
    assert.match(src, /<SettingsHero/);
    assert.match(src, /icon=\{</);
  }
});

test('Save Branding / company branding payloads omit the rejected columns', () => {
  assert.match(adminBrandingTab, /Save Branding/);
  assert.match(adminBrandingTab, /save\(\{ logo_url: logoUrl \|\| null, primary_color: primary \}\)/);
  assert.equal(/save\(\{[^}]*secondary_color/.test(adminBrandingTab), false);

  assert.match(tenantSave, /primary_color: primaryColor/);
  assert.match(tenantSave, /logo_url: logoUrl \|\| null/);
  assert.doesNotMatch(tenantSave, /secondary_color/);
  assert.doesNotMatch(tenantSave, /invoice_accent_color/);
  assert.doesNotMatch(tenantSave, /invoice_theme/);

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

test('unsavable branding controls are not presented as editable saved settings', () => {
  assert.doesNotMatch(adminBrandingTab, /Secondary Color/);
  assert.doesNotMatch(adminBrandingTab, /setSecondary/);
  assert.match(adminBrandingTab, /Primary Color/);
  assert.match(adminBrandingTab, /Logo/);
  assert.doesNotMatch(tenantBranding, /Secondary Color/);
  assert.doesNotMatch(tenantBranding, /setSecondaryColor/);
  assert.match(tenantBranding, /Primary Color/);
  assert.match(tenantBranding, /Logo/);
  assert.doesNotMatch(branding, /Invoice Accent Color/);
  assert.doesNotMatch(branding, /Invoice Theme/);
  assert.doesNotMatch(branding, /invoiceAccentColor/);
  assert.doesNotMatch(branding, /invoiceTheme/);
});

test('tenant write allowlist was not broadened', () => {
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('secondary_color'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('invoice_accent_color'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('invoice_theme'), false);
  assert.equal(WRITE_ALLOWLIST.company_branding.columns.has('logo_url'), false);
  assert.equal(WRITE_ALLOWLIST.company_branding.columns.has('updated_at'), false);
  assert.ok(WRITE_ALLOWLIST.tenants.columns.has('logo_url'));
  assert.ok(WRITE_ALLOWLIST.tenants.columns.has('primary_color'));
  assert.equal(writeAllowlist.includes('secondary_color'), false);
});

test('live production overlays remain present after the branding surgical delta', () => {
  assert.match(deleteBridge, /p_reason/);
  assert.match(deleteBridge, /delete_reason/);
  assert.match(deleteBridge, /args\["p_reason"\] \?\? args\["reason"\] \?\? args\["delete_reason"\]/);
  assert.match(logoResolver, /export function resolveTenantLogoUrl/);
  assert.match(logoResolver, /storage\/public\?bucket=/);
  assert.match(emailPreview, /data-testid="signature-request-email-preview"/);
  assert.match(emailPreview, /Email Preview/);
  assert.match(tenantBranding, /SignatureRequestEmailPreview/);
  assert.match(tenantBranding, /resolveTenantLogoUrl/);
  assert.match(profile, /TenantBrandingSettings/);
  assert.match(commandCenter, /check-linked-claims/);
  assert.match(commandCenter, /Unlinked claim/);
  assert.match(imageInvariants, /assertCleanBackOriginalPath|depositImagePersistPatch|clean back/);
  assert.match(banner, /isProductionChecksOpsHost/);
  assert.match(banner, /checksops\.com/);
});
