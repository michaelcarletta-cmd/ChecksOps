import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  canonicalStoredTenantLogo,
  isAwsPublicStorageLogoUrl,
  normalizeTenantLogoObjectPath,
  resolveEmailTenantLogoUrl,
  storedLogoMatchesRequest,
} from '../functions/api/tenant-logo-path.mjs';
import { canonicalStoredTenantLogo as spaCanonical } from '../../src/lib/tenantLogoUrl.ts';
import { resolveTenantLogoUrl } from '../../src/lib/tenantLogoUrl.ts';
import { isPublicBrandingPath, handleStoragePublic, handleBrandingLogo } from '../functions/api/storage.mjs';
import { resolveEmailBranding } from '../functions/api/email-branding.mjs';
import { renderChecksOpsEmail } from '../functions/api/email-layout.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const FREEDOM_REL = `${FREEDOM}/logo-1790615777558.png`;
const C1C_REL = `${C1C}/1778078357240.png`;
const C1C_HTTPS = `https://nbcqwpysqgyxrrbgtmkw.supabase.co/storage/v1/object/public/tenant-logos/${C1C_REL}`;
const FREEDOM_PREP = `https://checksops.com/prep/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_REL)}`;
const STAGING_PREP = `https://staging.checksops.com/prep/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_REL)}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

const logoRows = (rows) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql) => {
    if (String(sql).includes('tenants_public')) return { rows };
    return { rows: [] };
  },
});

const depsFor = (client, keys = new Set()) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
  s3: {
    send: async (command) => {
      const name = command.constructor?.name || '';
      const key = command.input?.Key;
      if (!keys.has(key)) {
        const error = new Error('NotFound');
        error.name = 'NotFound';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      if (name === 'GetObjectCommand') {
        return { Body: PNG, ContentType: 'image/png' };
      }
      return {};
    },
  },
  getSignedUrl: async () => 'https://s3.example/presigned?X-Amz-Signature=test&X-Amz-Expires=300',
});

const sqlClient = (logoUrl, id = FREEDOM) => ({
  query: async (sql) => {
    if (String(sql).includes('FROM public.tenants')) {
      return { rows: [{ id, name: 'Freedom Adjustment', is_system_tenant: false, logo_url: logoUrl }] };
    }
    return { rows: [] };
  },
});

test('normalize supports relative, /prep/storage/public, and supabase logo URLs', () => {
  assert.equal(normalizeTenantLogoObjectPath(FREEDOM_REL), FREEDOM_REL);
  assert.equal(normalizeTenantLogoObjectPath(FREEDOM_PREP), FREEDOM_REL);
  assert.equal(normalizeTenantLogoObjectPath(STAGING_PREP), FREEDOM_REL);
  assert.equal(normalizeTenantLogoObjectPath(`/prep/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_REL)}`), FREEDOM_REL);
  assert.equal(normalizeTenantLogoObjectPath(`files/tenant-logos/${FREEDOM_REL}`), FREEDOM_REL);
  assert.equal(normalizeTenantLogoObjectPath(C1C_HTTPS), C1C_REL);
});

test('canonical persist stores relative AWS paths and keeps C1C HTTPS', () => {
  assert.equal(canonicalStoredTenantLogo(FREEDOM_REL), FREEDOM_REL);
  assert.equal(canonicalStoredTenantLogo(FREEDOM_PREP), FREEDOM_REL);
  assert.equal(canonicalStoredTenantLogo(STAGING_PREP), FREEDOM_REL);
  assert.equal(canonicalStoredTenantLogo(C1C_HTTPS), C1C_HTTPS);
  assert.equal(canonicalStoredTenantLogo('https://cdn.example.com/logos/freedom.png'), 'https://cdn.example.com/logos/freedom.png');
  assert.equal(canonicalStoredTenantLogo(''), null);
  assert.equal(spaCanonical(FREEDOM_PREP), FREEDOM_REL);
  assert.equal(spaCanonical(C1C_HTTPS), C1C_HTTPS);
});

test('exact matcher accepts supported representations and rejects traversal/cross-tenant/private files', () => {
  assert.equal(storedLogoMatchesRequest(FREEDOM_REL, FREEDOM_REL), true);
  assert.equal(storedLogoMatchesRequest(FREEDOM_PREP, FREEDOM_REL), true);
  assert.equal(storedLogoMatchesRequest(C1C_HTTPS, C1C_REL), true);
  assert.equal(storedLogoMatchesRequest(FREEDOM_REL, C1C_REL), false);
  assert.equal(storedLogoMatchesRequest(FREEDOM_REL, `${FREEDOM}/../${C1C}/x.png`), false);
  assert.equal(storedLogoMatchesRequest(FREEDOM_REL, `claim-files/${FREEDOM}/front.jpg`), false);
  assert.equal(storedLogoMatchesRequest(FREEDOM_REL, `files/claim-files/${FREEDOM}/front.jpg`), false);
  assert.equal(normalizeTenantLogoObjectPath(`${FREEDOM}/../../../etc/passwd`), null);
  assert.equal(normalizeTenantLogoObjectPath('https://evil.example/storage/public?bucket=claim-files&path=x'), null);
  assert.equal(isAwsPublicStorageLogoUrl(FREEDOM_PREP), true);
  assert.equal(isAwsPublicStorageLogoUrl(C1C_HTTPS), false);
});

test('isPublicBrandingPath authorizes only the stored tenant-logo object', async () => {
  const client = logoRows([{ logo_url: FREEDOM_PREP }, { logo_url: C1C_HTTPS }]);
  assert.equal(await isPublicBrandingPath(client, 'tenant-logos', FREEDOM_REL), true);
  assert.equal(await isPublicBrandingPath(client, 'tenant-logos', C1C_REL), true);
  assert.equal(await isPublicBrandingPath(client, 'tenant-logos', `${FREEDOM}/other.png`), false);
  assert.equal(await isPublicBrandingPath(client, 'tenant-logos', `${C1C}/not-the-logo.png`), false);
  assert.equal(await isPublicBrandingPath(client, 'claim-files', FREEDOM_REL), false);
  assert.equal(await isPublicBrandingPath(client, 'tenant-logos', `${FREEDOM}/../secret`), false);
});

test('GET /storage/public serves Freedom-shaped /prep URL after matcher repair', async () => {
  const key = `files/tenant-logos/${FREEDOM_REL}`;
  const allowed = await handleStoragePublic({
    rawPath: '/storage/public',
    queryStringParameters: { bucket: 'tenant-logos', path: FREEDOM_REL },
    requestContext: { stage: 'staging', http: { method: 'GET', path: '/storage/public' } },
  }, depsFor(logoRows([{ logo_url: FREEDOM_PREP }]), new Set([key])));
  assert.equal(allowed.statusCode, 302);
  assert.match(allowed.location, /presigned/);

  const denied = await handleStoragePublic({
    rawPath: '/storage/public',
    queryStringParameters: { bucket: 'tenant-logos', path: `${C1C}/1778078357240.png` },
    requestContext: { stage: 'staging', http: { method: 'GET', path: '/storage/public' } },
  }, depsFor(logoRows([{ logo_url: FREEDOM_PREP }]), new Set([`files/tenant-logos/${C1C_REL}`])));
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.error, 'storage_forbidden');
});

test('GET /branding/logo streams tenant image bytes and refuses other keys', async () => {
  const key = `files/tenant-logos/${FREEDOM_REL}`;
  const ok = await handleBrandingLogo({
    rawPath: `/branding/logo/${FREEDOM}`,
    requestContext: { stage: 'staging', http: { method: 'GET', path: `/branding/logo/${FREEDOM}` } },
  }, depsFor(logoRows([{ id: FREEDOM, logo_url: FREEDOM_REL }]), new Set([key])));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.binary, true);
  assert.equal(ok.contentType, 'image/png');
  assert.equal(Buffer.isBuffer(ok.body), true);
  assert.equal(ok.body[0], 0x89);
  assert.equal(ok.path, FREEDOM_REL);
  assert.doesNotMatch(String(ok.body), /X-Amz-Signature/);

  const missingTenant = await handleBrandingLogo({
    rawPath: `/branding/logo/${C1C}`,
    requestContext: { stage: 'staging', http: { method: 'GET', path: `/branding/logo/${C1C}` } },
  }, depsFor(logoRows([]), new Set([key])));
  assert.equal(missingTenant.statusCode, 404);

  const badId = await handleBrandingLogo({
    rawPath: '/branding/logo/not-a-uuid',
    requestContext: { stage: 'staging', http: { method: 'GET', path: '/branding/logo/not-a-uuid' } },
  }, depsFor(logoRows([]), new Set()));
  assert.equal(badId.statusCode, 400);
});

test('email resolver emits stable /branding/logo URL, keeps C1C HTTPS, and falls back', async () => {
  process.env.SIGN_BASE_URL = 'https://staging.checksops.com';
  const relative = await resolveEmailBranding(sqlClient(FREEDOM_REL), { tenantId: FREEDOM });
  assert.equal(relative.logoUrl, `https://staging.checksops.com/prep/branding/logo/${FREEDOM}`);
  const prep = await resolveEmailBranding(sqlClient(FREEDOM_PREP), { tenantId: FREEDOM });
  assert.equal(prep.logoUrl, `https://staging.checksops.com/prep/branding/logo/${FREEDOM}`);
  const c1c = await resolveEmailBranding(sqlClient(C1C_HTTPS, C1C), { tenantId: C1C });
  assert.equal(c1c.logoUrl, C1C_HTTPS);
  const missing = await resolveEmailBranding(sqlClient(null), { tenantId: FREEDOM });
  assert.match(missing.logoUrl, /checksops-logo\.png/);
  const malformed = await resolveEmailBranding(sqlClient('javascript:alert(1)'), { tenantId: FREEDOM });
  assert.match(malformed.logoUrl, /checksops-logo\.png/);

  const html = renderChecksOpsEmail({ title: 'Hi', logoUrl: relative.logoUrl });
  assert.match(html.html, /https:\/\/staging\.checksops\.com\/prep\/branding\/logo\/2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/);
  assert.doesNotMatch(html.html, /\/storage\/public\?/);
  assert.doesNotMatch(html.html, /X-Amz-Signature/);
  assert.doesNotMatch(html.html, /logo-1790615777558\.png/);

  assert.equal(
    resolveEmailTenantLogoUrl({ tenantId: FREEDOM, logoUrl: FREEDOM_REL, origin: 'https://staging.checksops.com' }),
    `https://staging.checksops.com/prep/branding/logo/${FREEDOM}`,
  );
});

test('R4A resolver still turns canonical relative paths into /prep/storage/public', () => {
  const url = resolveTenantLogoUrl(FREEDOM_REL, '/prep');
  assert.equal(url, `/prep/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_REL)}`);
  assert.match(url, /^\/prep\/storage\/public\?/);
  assert.doesNotMatch(url, /^(assets|src)\//);
});

test('GET /branding/logo uses the tenant stored logo and ignores path spoofing', async () => {
  const key = `files/tenant-logos/${FREEDOM_REL}`;
  const legacy = await handleBrandingLogo({
    rawPath: `/branding/logo/${FREEDOM}`,
    queryStringParameters: { path: C1C_REL, bucket: 'claim-files' },
    requestContext: { stage: 'staging', http: { method: 'GET', path: `/branding/logo/${FREEDOM}` } },
  }, depsFor(logoRows([{ id: FREEDOM, logo_url: FREEDOM_PREP }]), new Set([key])));
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.path, FREEDOM_REL);
  assert.equal(legacy.body[0], 0x89);

  const spoofDenied = await handleBrandingLogo({
    rawPath: `/branding/logo/${FREEDOM}`,
    queryStringParameters: { path: `${C1C}/1778078357240.png` },
    requestContext: { stage: 'staging', http: { method: 'GET', path: `/branding/logo/${FREEDOM}` } },
  }, depsFor(logoRows([{ id: FREEDOM, logo_url: FREEDOM_REL }]), new Set([`files/tenant-logos/${C1C_REL}`])));
  assert.equal(spoofDenied.statusCode, 404);
});

test('public matcher SQL does not use unrestricted LIKE against logo_url', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/storage.mjs'), 'utf8');
  const fn = src.slice(src.indexOf('export const isPublicBrandingPath'), src.indexOf('export const handleStoragePublic'));
  const tenantLogos = fn.slice(fn.indexOf("if (bucket === 'tenant-logos')"), fn.indexOf("if (bucket === 'company-branding')"));
  assert.match(tenantLogos, /storedLogoMatchesRequest/);
  assert.doesNotMatch(tenantLogos, /LIKE/);
  assert.match(fs.readFileSync(path.join(ROOT, 'aws/functions/api/index.mjs'), 'utf8'), /brandingLogoPath/);
});

test('write paths persist the uploaded object path instead of getPublicUrl', () => {
  const branding = fs.readFileSync(path.join(ROOT, 'src/components/settings/TenantBrandingSettings.tsx'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'src/pages/admin/AdminTenants.tsx'), 'utf8');
  const management = fs.readFileSync(path.join(ROOT, 'src/components/settings/TenantManagement.tsx'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'src/components/white-label/WhiteLabelSettings.tsx'), 'utf8');
  for (const src of [branding, admin, management]) {
    assert.match(src, /canonicalStoredTenantLogo/);
    assert.doesNotMatch(src, /setLogoUrl\(.*publicUrl/);
    assert.doesNotMatch(src, /logo_url:\s*.*publicUrl/);
  }
  assert.match(branding, /setLogoUrl\(path\)/);
  assert.match(admin, /setLogoUrl\(path\)/);
  assert.match(management, /logo_url: path/);
  assert.match(settings, /<TenantBrandingSettings tenant=\{tenant\} \/>/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/components/branding/TenantLogo.tsx'), 'utf8'), /resolveTenantLogoUrl/);
});
