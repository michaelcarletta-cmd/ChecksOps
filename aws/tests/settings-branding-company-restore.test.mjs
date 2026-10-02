import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pickAllowlistedValues, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const company = read('src/components/settings/CompanyBrandingSettings.tsx');
const settings = read('src/components/white-label/WhiteLabelSettings.tsx');
const emailSender = read('src/components/settings/EmailSenderSettings.tsx');
const adminTenants = read('src/pages/admin/AdminTenants.tsx');
const tenantContext = read('src/contexts/TenantContext.tsx');
const checkCenter = read('src/components/white-label/WhiteLabelCheckCenter.tsx');

const ALLOWLISTED_COMPANY_BRANDING = [
  'company_address',
  'company_email',
  'company_name',
  'company_phone',
  'letterhead_url',
];
const ALLOWLISTED_TENANT_SAVE = [
  'invoice_default_terms',
  'invoice_footer_note',
  'invoice_letterhead_url',
  'logo_url',
];

function objectKeys(literal) {
  return [...literal.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((match) => match[1]).sort();
}

function extractObjectLiteral(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `missing marker ${marker}`);
  const brace = src.indexOf('{', start);
  assert.ok(brace >= 0, `missing object after ${marker}`);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(brace, i + 1);
    }
  }
  throw new Error(`unbalanced object after ${marker}`);
}

const saveSettings = company.slice(
  company.indexOf('const saveSettings'),
  company.indexOf('return ('),
);
const brandingPayload = extractObjectLiteral(saveSettings, 'const brandingData =');
const tenantPayload = extractObjectLiteral(saveSettings, '.from("tenants")');
const logoUpload = company.slice(
  company.indexOf('const handleLogoUpload'),
  company.indexOf('const saveSettings'),
);
const loadSettings = company.slice(
  company.indexOf('const loadSettings'),
  company.indexOf('const handleInvoiceLetterheadUpload'),
);
const brandingTab = settings.slice(
  settings.indexOf('<TabsContent value="branding"'),
  settings.indexOf('<TabsContent value="referrals"'),
);

test('Company Information payload contains only allowlisted company_branding fields', () => {
  assert.match(company, /title="Company Information"/);
  assert.match(company, /title="Company Settings"/);
  assert.match(company, /Save Company Settings/);
  assert.deepEqual(objectKeys(brandingPayload), ALLOWLISTED_COMPANY_BRANDING);

  const accepted = pickAllowlistedValues('company_branding', {
    company_name: 'Acme',
    company_address: '1 Main',
    company_phone: '555',
    company_email: 'ops@acme.test',
    letterhead_url: 'https://cdn.example/letter.png',
  });
  assert.equal(accepted.error, undefined);
  assert.deepEqual(Object.keys(accepted.values).sort(), ALLOWLISTED_COMPANY_BRANDING);

  const rejected = pickAllowlistedValues('company_branding', {
    company_name: 'Acme',
    company_address: '1 Main',
    company_phone: '555',
    company_email: 'ops@acme.test',
    letterhead_url: 'https://cdn.example/letter.png',
    logo_url: 'https://cdn.example/logo.png',
    updated_at: '2026-10-02T00:00:00.000Z',
  });
  assert.equal(rejected.error, 'column_not_allowlisted');
  assert.deepEqual(rejected.columns.sort(), ['logo_url', 'updated_at']);
});

test('company logo persists through tenants.logo_url, not company_branding.logo_url', () => {
  assert.match(logoUpload, /from\("tenant-logos"\)/);
  assert.match(logoUpload, /\$\{tenantId\}\/logo-\$\{Date\.now\(\)\}\./);
  assert.match(logoUpload, /upsert: true/);
  assert.doesNotMatch(logoUpload, /company-branding/);
  assert.doesNotMatch(logoUpload, /company_branding/);

  assert.doesNotMatch(brandingPayload, /logo_url/);
  assert.doesNotMatch(brandingPayload, /updated_at/);
  assert.deepEqual(objectKeys(tenantPayload), ALLOWLISTED_TENANT_SAVE);
  assert.match(tenantPayload, /logo_url:\s*logoUrl/);

  assert.match(loadSettings, /select\("logo_url, invoice_letterhead_url, invoice_footer_note, invoice_default_terms"\)/);
  assert.match(loadSettings, /if \(t\.logo_url\) setLogoUrl\(t\.logo_url\)/);
  assert.doesNotMatch(loadSettings, /setLogoUrl\(branding\.logo_url/);
  const brandingLoad = loadSettings.slice(
    loadSettings.indexOf('.from("company_branding"'),
    loadSettings.indexOf('Application/sidebar logo'),
  );
  assert.doesNotMatch(brandingLoad, /setLogoUrl/);
  assert.doesNotMatch(brandingLoad, /logo_url/);

  const persisted = pickAllowlistedValues('tenants', {
    logo_url: 'https://cdn.example/logo.png',
    invoice_letterhead_url: 'https://cdn.example/inv.png',
    invoice_footer_note: 'Thanks',
    invoice_default_terms: 'Net 30',
  });
  assert.equal(persisted.error, undefined);
  assert.deepEqual(Object.keys(persisted.values).sort(), ALLOWLISTED_TENANT_SAVE);

  const brandingLogo = pickAllowlistedValues('company_branding', { logo_url: 'https://cdn.example/logo.png' });
  assert.equal(brandingLogo.error, 'column_not_allowlisted');
  assert.deepEqual(brandingLogo.columns, ['logo_url']);

  assert.match(saveSettings, /await refreshTenant\(\)/);
  assert.match(tenantContext, /logo_url:/);
  assert.match(settings, /tenant\?\.logo_url/);
  assert.match(checkCenter, /tenant\?\.logo_url/);
});

test('unsupported invoice fields are not submitted or shown', () => {
  assert.doesNotMatch(company, /invoice_accent_color/);
  assert.doesNotMatch(company, /invoice_theme/);
  assert.doesNotMatch(company, /invoiceAccentColor/);
  assert.doesNotMatch(company, /invoiceTheme/);
  assert.doesNotMatch(company, /Invoice Accent Color/);
  assert.doesNotMatch(company, /Invoice Theme/);
  assert.ok(!objectKeys(tenantPayload).includes('invoice_accent_color'));
  assert.ok(!objectKeys(tenantPayload).includes('invoice_theme'));

  const extras = pickAllowlistedValues('tenants', {
    logo_url: 'https://cdn.example/logo.png',
    invoice_letterhead_url: 'https://cdn.example/inv.png',
    invoice_footer_note: 'Thanks',
    invoice_default_terms: 'Net 30',
    invoice_accent_color: '#3B82F6',
    invoice_theme: 'light',
  });
  assert.equal(extras.error, 'column_not_allowlisted');
  assert.deepEqual(extras.columns.sort(), ['invoice_accent_color', 'invoice_theme']);
});

test('tenant Branding tab does not mount Sending Subdomain or EmailSenderSettings', () => {
  assert.match(brandingTab, /<CompanyBrandingSettings/);
  assert.doesNotMatch(brandingTab, /<EmailSenderSettings/);
  assert.doesNotMatch(brandingTab, /<BrandingSettings/);
  assert.doesNotMatch(brandingTab, /Sending Subdomain/i);
  assert.doesNotMatch(settings, /from "@\/components\/settings\/EmailSenderSettings"/);
  assert.doesNotMatch(settings, /EmailSenderSettings/);

  assert.match(emailSender, /export function EmailSenderSettings/);
  assert.match(emailSender, /Sending subdomain/i);
  assert.match(adminTenants, /from "@\/components\/settings\/EmailSenderSettings"/);
  assert.match(adminTenants, /<EmailSenderSettings/);

  assert.match(settings, /function BrandingSettings/);
  assert.match(settings, /secondary_color:\s*secondaryColor/);
  assert.doesNotMatch(brandingTab, /secondary_color/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/components/settings/TenantBrandingSettings.tsx')), false);
});

test('failed AWS writes cannot produce a false success toast', () => {
  const successIdx = saveSettings.indexOf('toast({ title: "Company settings saved" }');
  const brandingThrowIdx = saveSettings.indexOf('if (error) throw error');
  const tenantThrowIdx = saveSettings.indexOf('if (tenantError) throw tenantError');
  const catchIdx = saveSettings.indexOf('} catch');
  const refreshIdx = saveSettings.indexOf('await refreshTenant()');

  assert.ok(successIdx >= 0, 'expected success toast after a clean save');
  assert.ok(brandingThrowIdx >= 0, 'expected company_branding write errors to throw');
  assert.ok(tenantThrowIdx >= 0, 'expected tenants write errors to throw');
  assert.ok(catchIdx >= 0, 'expected save catch');
  assert.ok(successIdx > brandingThrowIdx);
  assert.ok(successIdx > tenantThrowIdx);
  assert.ok(successIdx < catchIdx);
  assert.ok(refreshIdx > tenantThrowIdx && refreshIdx < successIdx);
  assert.match(saveSettings, /if \(logoUrl\) throw new Error\("Unable to persist company logo without a tenant\."\)/);

  const catchBlock = saveSettings.slice(catchIdx);
  assert.doesNotMatch(catchBlock, /Company settings saved/);
  assert.match(catchBlock, /title: "Error saving settings"/);
  assert.match(catchBlock, /variant: "destructive"/);
});

test('write allowlist was not broadened for branding restoration', () => {
  assert.deepEqual(
    [...WRITE_ALLOWLIST.company_branding.columns].sort(),
    [
      'company_address',
      'company_email',
      'company_name',
      'company_phone',
      'endorsement_email_body',
      'endorsement_email_subject',
      'letterhead_url',
    ],
  );
  assert.deepEqual(
    [...WRITE_ALLOWLIST.tenants.columns].sort(),
    [
      'invoice_default_terms',
      'invoice_footer_note',
      'invoice_letterhead_url',
      'logo_url',
      'name',
      'primary_color',
    ],
  );
  assert.equal(WRITE_ALLOWLIST.company_branding.columns.has('logo_url'), false);
  assert.equal(WRITE_ALLOWLIST.company_branding.columns.has('updated_at'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('invoice_accent_color'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('invoice_theme'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('secondary_color'), false);
});
