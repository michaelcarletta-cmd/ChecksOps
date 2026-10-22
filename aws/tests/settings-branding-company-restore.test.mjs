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

const ALLOWLISTED_TENANT_SAVE = [
  'invoice_default_terms',
  'invoice_footer_note',
  'invoice_letterhead_url',
  'logo_url',
];
const TENANT_COMPANY_INFO = [
  'company_address',
  'company_email',
  'company_phone',
  'letterhead_url',
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
const tenantPayload = extractObjectLiteral(saveSettings, '.from("tenants")');
const companyInfoPayload = extractObjectLiteral(saveSettings, '.from("tenants" as any)');
const logoUpload = company.slice(
  company.indexOf('const handleLogoUpload'),
  company.indexOf('const saveSettings'),
);
const letterheadUpload = company.slice(
  company.indexOf('const handleLetterheadUpload'),
  company.indexOf('const handleLogoUpload'),
);
const loadSettings = company.slice(
  company.indexOf('const loadSettings'),
  company.indexOf('const handleInvoiceLetterheadUpload'),
);
const brandingTab = settings.slice(
  settings.indexOf('<TabsContent value="branding"'),
  settings.indexOf('<TabsContent value="referrals"'),
);

test('Company Information and document letterhead save to the tenant, not company_branding', () => {
  assert.match(company, /title="Company Information"/);
  assert.match(company, /title="Company Settings"/);
  assert.match(company, /Save Company Settings/);
  assert.match(company, /Document Letterhead/);
  // Both cards are shown to every tenant member again (no gate, no role check).
  assert.doesNotMatch(company, /platformBranding/);
  assert.doesNotMatch(company, /\{[a-zA-Z]+ && \(\s*<SectionCard\s+title="Company Information"/);
  assert.doesNotMatch(company, /isPlatformOwner|useAuth|usePermissions|\brole\b/i);

  // The platform-owner-only table is never touched by tenant branding.
  assert.doesNotMatch(company, /\.from\("company_branding"/);
  assert.doesNotMatch(company, /setBrandingId|brandingId/);

  assert.deepEqual(objectKeys(companyInfoPayload), TENANT_COMPANY_INFO);
  assert.match(companyInfoPayload, /company_address:\s*address/);
  assert.match(companyInfoPayload, /company_phone:\s*phone/);
  assert.match(companyInfoPayload, /company_email:\s*email/);
  assert.match(companyInfoPayload, /letterhead_url:\s*letterheadUrl/);
  // Company name is the tenant's own name; never blanked.
  assert.match(saveSettings, /const trimmedName = companyName\.trim\(\);/);
  assert.match(tenantPayload, /\.\.\.\(trimmedName \? \{ name: trimmedName \} : \{\}\)/);

  const accepted = pickAllowlistedValues('tenants', {
    name: 'Acme Roofing',
    company_address: '1 Main',
    company_phone: '555',
    company_email: 'ops@acme.test',
    letterhead_url: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/letterhead-1.png',
  });
  assert.equal(accepted.error, undefined);
  assert.deepEqual(Object.keys(accepted.values).sort(), ['name', ...TENANT_COMPANY_INFO].sort());
});

test('company logo persists through tenants.logo_url, not company_branding.logo_url', () => {
  assert.match(logoUpload, /from\("tenant-logos"\)/);
  assert.match(logoUpload, /\$\{tenantId\}\/logo-\$\{Date\.now\(\)\}\./);
  assert.match(logoUpload, /upsert: true/);
  assert.doesNotMatch(logoUpload, /company-branding/);
  assert.doesNotMatch(logoUpload, /company_branding/);

  assert.deepEqual(objectKeys(tenantPayload), ALLOWLISTED_TENANT_SAVE);
  assert.match(tenantPayload, /logo_url:\s*logoUrl/);

  assert.match(loadSettings, /select\("name, logo_url, invoice_letterhead_url, invoice_footer_note, invoice_default_terms"\)/);
  assert.match(loadSettings, /if \(t\.logo_url\) setLogoUrl\(t\.logo_url\)/);
  assert.match(loadSettings, /setCompanyName\(t\.name \|\| ""\)/);

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

test('document letterhead uploads to the tenant-scoped branding path like the logo', () => {
  assert.match(letterheadUpload, /from\("tenant-logos"\)\.upload\(path, file, \{/);
  assert.match(letterheadUpload, /const path = `\$\{tenantId\}\/letterhead-\$\{Date\.now\(\)\}\.\$\{ext\}`/);
  assert.match(letterheadUpload, /upsert: true/);
  assert.match(letterheadUpload, /if \(!tenantId\)/);
  assert.match(letterheadUpload, /5 \* 1024 \* 1024/);
  assert.doesNotMatch(letterheadUpload, /company-branding/);
  assert.match(company, /brandingPublicUrl\(letterheadUrl, "tenant-logos"\)/);
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

test('tenant Branding tab mounts Company Branding and Email Branding without Sending Subdomain', () => {
  assert.match(brandingTab, /<CompanyBrandingSettings/);
  assert.match(brandingTab, /<EmailSenderSettings/);
  assert.match(brandingTab, /showSendingDomain=\{false\}/);
  assert.doesNotMatch(brandingTab, /<BrandingSettings/);
  assert.doesNotMatch(brandingTab, /Sending Subdomain/i);
  assert.match(settings, /from "@\/components\/settings\/EmailSenderSettings"/);

  assert.match(emailSender, /export function EmailSenderSettings/);
  assert.match(emailSender, /showSendingDomain/);
  assert.match(emailSender, /\{showSendingDomain && <SectionCard/);
  assert.match(emailSender, /title="Sending subdomain"/);
  assert.match(emailSender, /brandingPublicUrl\(storedLogo, "tenant-logos"\)/);
  assert.match(emailSender, /applyEmailPreviewLogo/);
  assert.match(emailSender, /srcDoc=\{previewHtml\}/);
  assert.doesNotMatch(emailSender, /srcDoc=\{preview\.html\}/);
  // Owner: only tenants control their branding. Tenant Management has no
  // branding or email-branding controls at all.
  assert.doesNotMatch(adminTenants, /EmailSenderSettings/);
  assert.doesNotMatch(adminTenants, /value="branding"/);
  assert.doesNotMatch(adminTenants, /function BrandingTab|<BrandingTab/);
  assert.doesNotMatch(adminTenants, /Branding & Email/);

  assert.match(settings, /function BrandingSettings/);
  assert.match(settings, /secondary_color:\s*secondaryColor/);
  assert.doesNotMatch(brandingTab, /secondary_color/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/components/settings/TenantBrandingSettings.tsx')), false);
});

test('failed AWS writes cannot produce a false success toast', () => {
  const successIdx = saveSettings.indexOf('toast({ title: "Company settings saved" }');
  const tenantThrowIdx = saveSettings.indexOf('if (tenantError) throw tenantError');
  const infoThrowIdx = saveSettings.indexOf('if (infoError) throw infoError');
  const catchIdx = saveSettings.indexOf('} catch');
  const refreshIdx = saveSettings.indexOf('await refreshTenant()');

  assert.ok(successIdx >= 0, 'expected success toast after a clean save');
  assert.ok(tenantThrowIdx >= 0, 'expected tenants write errors to throw');
  assert.ok(infoThrowIdx >= 0, 'expected company info write errors to throw');
  assert.ok(catchIdx >= 0, 'expected save catch');
  assert.ok(successIdx > tenantThrowIdx);
  assert.ok(successIdx > infoThrowIdx);
  assert.ok(successIdx < catchIdx);
  assert.ok(refreshIdx > tenantThrowIdx && refreshIdx < infoThrowIdx, 'refresh after the core save, even if company info fails');
  assert.match(saveSettings, /if \(logoUrl \|\| letterheadUrl\) throw new Error\("Unable to persist company logo without a tenant\."\)/);

  const catchBlock = saveSettings.slice(catchIdx);
  assert.doesNotMatch(catchBlock, /Company settings saved/);
  assert.match(catchBlock, /title: "Error saving settings"/);
  assert.match(catchBlock, /variant: "destructive"/);
});

test('logo tenant id comes from the current route-scoped tenant, not the first tenant_users membership', () => {
  assert.match(company, /const \{ tenant, refreshTenant \} = useTenant\(\)/);
  assert.match(company, /const tenantId = tenant\?\.id \?\? null/);
  assert.doesNotMatch(company, /from\("tenant_users"\)/);
  assert.doesNotMatch(company, /setTenantId/);
  assert.doesNotMatch(company, /supabase\.auth\.getUser\(\)/);
  assert.match(loadSettings, /if \(!tenantId\) return;/);
  assert.equal((loadSettings.match(/\.eq\("id", tenantId\)/g) || []).length, 2);
  assert.match(company, /useEffect\(\(\) => \{\s*loadSettings\(\);\s*\}, \[tenantId\]\)/);
  assert.match(logoUpload, /if \(!tenantId\)/);
  assert.match(logoUpload, /\$\{tenantId\}\/logo-\$\{Date\.now\(\)\}\./);
  assert.match(saveSettings, /const resolvedTenantId = tenantId;/);
  assert.equal((saveSettings.match(/\.eq\("id", resolvedTenantId\)/g) || []).length, 2);
});

// Execute the saveSettings body against a stub client so ordering and scoping
// are checked behaviourally, not only by source position.
const runSave = async ({ tenantId = 'tenant-current', infoError = null, companyName = 'Acme Roofing' } = {}) => {
  const bodyStart = saveSettings.indexOf('try {');
  const bodyEnd = saveSettings.indexOf('} catch');
  const body = saveSettings
    .slice(bodyStart + 'try {'.length, bodyEnd)
    .replace(/ as any/g, '');
  const calls = [];
  const toasts = [];
  let refreshed = 0;
  const supabase = {
    from(table) {
      const op = { table };
      const chain = {
        update(values) { op.op = 'update'; op.values = values; return chain; },
        eq(col, val) { op.eq = [col, val]; return chain; },
        then(resolve) {
          calls.push(op);
          const isInfo = 'company_address' in (op.values || {});
          resolve({ data: null, error: isInfo ? infoError : null });
        },
      };
      return chain;
    },
  };
  const fn = new Function(
    'supabase', 'tenantId', 'companyName', 'logoUrl', 'invoiceLetterheadUrl', 'invoiceFooterNote',
    'invoiceDefaultTerms', 'refreshTenant', 'address', 'phone', 'email', 'letterheadUrl', 'toast',
    `return (async () => { ${body} })();`,
  );
  let thrown = null;
  try {
    await fn(supabase, tenantId, companyName, 'tenant-current/logo-1.png', null, 'Thanks', 'Net 30',
      async () => { refreshed += 1; }, '1 Main St', '555-0100', 'ops@acme.test',
      'tenant-current/letterhead-2.png', (t) => toasts.push(t));
  } catch (error) {
    thrown = error;
  }
  return { calls, toasts, refreshed, thrown };
};

test('tenant Save writes only the current tenant row, including company info and letterhead', async () => {
  const saved = await runSave();
  assert.equal(saved.thrown, null);
  assert.deepEqual(saved.calls.map((c) => c.table), ['tenants', 'tenants']);
  for (const call of saved.calls) assert.deepEqual(call.eq, ['id', 'tenant-current']);
  assert.equal(saved.calls[0].values.name, 'Acme Roofing');
  assert.equal(saved.calls[0].values.logo_url, 'tenant-current/logo-1.png');
  assert.deepEqual(saved.calls[1].values, {
    company_address: '1 Main St',
    company_phone: '555-0100',
    company_email: 'ops@acme.test',
    letterhead_url: 'tenant-current/letterhead-2.png',
  });
  assert.equal(saved.refreshed, 1);
  assert.deepEqual(saved.toasts, [{ title: 'Company settings saved' }]);

  // A blank company name never blanks tenants.name.
  const blank = await runSave({ companyName: '   ' });
  assert.equal('name' in blank.calls[0].values, false);
});

test('core tenant branding still saves when the company info write fails', async () => {
  const failed = await runSave({ infoError: { message: 'column "company_address" does not exist' } });
  assert.deepEqual(failed.calls.map((c) => c.table), ['tenants', 'tenants']);
  assert.equal(failed.calls[0].values.logo_url, 'tenant-current/logo-1.png');
  assert.equal(failed.refreshed, 1);
  assert.match(failed.thrown?.message || '', /company_address/);
  assert.deepEqual(failed.toasts, []);

  const noTenant = await runSave({ tenantId: null });
  assert.deepEqual(noTenant.calls, []);
  assert.match(noTenant.thrown?.message || '', /without a tenant/);
});

test('write allowlist adds only the tenant company info columns', () => {
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
      // Live staging platform-admin tenant create (reconciled from the deployed allowlist).
      'slug',
      // Tenant's own Company Information + document letterhead (SQL 93).
      'company_address',
      'company_email',
      'company_phone',
      'letterhead_url',
    ].sort(),
  );
  // Create needs name + slug; billing/provider flags are never client-writable.
  assert.deepEqual([...WRITE_ALLOWLIST.tenants.ops].sort(), ['insert', 'update']);
  assert.deepEqual(WRITE_ALLOWLIST.tenants.requiredForWrite.insert, ['name', 'slug']);
  for (const column of ['payment_provider', 'moov_allowlisted', 'moov_environment', 'is_test_account',
    'mortgage_ops_initial_rate_cents', 'mortgage_ops_additional_rate_cents']) {
    assert.equal(WRITE_ALLOWLIST.tenants.columns.has(column), false, column);
    assert.equal(WRITE_ALLOWLIST.tenants.clientIgnored.has(column), true, column);
  }
  assert.equal(WRITE_ALLOWLIST.company_branding.columns.has('logo_url'), false);
  assert.equal(WRITE_ALLOWLIST.company_branding.columns.has('updated_at'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('invoice_accent_color'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('invoice_theme'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('secondary_color'), false);
});
