import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  publicApiBaseUrl,
  publicTenantLogoUrl,
  resolveEmailBranding,
  resolveRuntimeApiBaseUrl,
} from '../functions/api/email-branding.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FREEDOM_LOGO = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/logo-1790801891632.png';
const STAGING_API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const PRODUCTION_PREP = 'https://checksops.com/prep';
const PRODUCTION_EXECUTE_API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';
const RESOLVED_STAGING = `${STAGING_API}/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_LOGO)}`;
const RESOLVED_PRODUCTION = `${PRODUCTION_PREP}/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_LOGO)}`;
const LIVE_PREVIEW_SRC = `https://staging.checksops.com/prep/branding/logo/2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`;
const SUPABASE_LOGO = 'https://xyzcompany.supabase.co/storage/v1/object/public/tenant-logos/acme/logo.png';
const API_ENV_KEYS = [
  'CHECKSOPS_API_URL',
  'VITE_CHECKSOPS_API_URL',
  'CHECKSOPS_API_PUBLIC_URL',
  'CHECKSOPS_ENV',
  'SIGN_BASE_URL',
  'APP_PUBLIC_URL',
  'VITE_APP_URL',
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const withEnv = async (overrides, fn) => {
  const previous = Object.fromEntries(API_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of API_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of API_ENV_KEYS) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
};

const tenantClient = (logoUrl) => ({
  query: async (sql) => {
    if (String(sql).includes('FROM public.tenants')) {
      return {
        rows: [{
          name: 'Freedom Adjustment',
          is_system_tenant: false,
          logo_url: logoUrl,
        }],
      };
    }
    return { rows: [] };
  },
});

test('API resolver maps the stored Freedom object path to execute-api storage/public', () => {
  assert.equal(publicTenantLogoUrl(FREEDOM_LOGO, STAGING_API), RESOLVED_STAGING);
  assert.equal(publicTenantLogoUrl(RESOLVED_STAGING, STAGING_API), RESOLVED_STAGING);
  assert.equal(publicTenantLogoUrl('javascript:alert(1)', STAGING_API), null);
  assert.doesNotMatch(publicTenantLogoUrl(FREEDOM_LOGO, STAGING_API) || '', /\/prep\/branding\/logo\//);
  assert.doesNotMatch(publicTenantLogoUrl(FREEDOM_LOGO, STAGING_API) || '', /staging\.checksops\.com\/prep\//);
});

test('SPA preview rewrite treats live /prep/branding/logo as a broken src', () => {
  const helper = read('src/lib/brandingPublicUrl.ts');
  assert.match(helper, /export function isBrokenEmailPreviewLogoSrc/);
  assert.match(helper, /export function applyEmailPreviewLogo/);
  assert.match(helper, /isBrokenEmailPreviewLogoSrc/);
  assert.match(helper, /shouldReplacePreviewLogoSrc/);
  assert.match(helper, /brandingPublicUrl\(storedLogo, "tenant-logos"/);
  assert.doesNotMatch(helper, /invoice_accent_color/);
  assert.equal(LIVE_PREVIEW_SRC.includes('/prep/branding/logo/'), true);
});

test('EmailSenderSettings preview iframe uses the public-storage rewrite', () => {
  const ui = read('src/components/settings/EmailSenderSettings.tsx');
  assert.match(ui, /applyEmailPreviewLogo/);
  assert.match(ui, /brandingPublicUrl\(storedLogo, "tenant-logos"\)/);
  assert.match(ui, /srcDoc=\{previewHtml\}/);
  assert.doesNotMatch(ui, /srcDoc=\{preview\.html\}/);
  assert.doesNotMatch(ui, /Email Brand Color/);
  assert.doesNotMatch(ui, /invoice_accent_color/);
});

test('runtime API origin uses existing CHECKSOPS_API_URL / VITE_CHECKSOPS_API_URL and awsApiBase tokens', async () => {
  const source = read('aws/functions/api/email-branding.mjs');
  assert.match(source, /process\.env\.CHECKSOPS_API_URL \|\| process\.env\.VITE_CHECKSOPS_API_URL/);
  assert.match(source, /resolveRuntimeApiBaseUrl/);
  assert.match(source, /same-origin:\/prep/);
  assert.doesNotMatch(source, /STAGING_API_PUBLIC_URL/);
  assert.doesNotMatch(source, /CHECKSOPS_API_PUBLIC_URL/);
  assert.doesNotMatch(source, /https:\/\/psr19uhop4\.execute-api\.us-east-1\.amazonaws\.com\/staging/);
  const { resolveAwsApiBaseUrl } = await import('../../src/lib/awsApiBase.ts');
  assert.equal(
    resolveRuntimeApiBaseUrl('/prep', 'https://checksops.com'),
    resolveAwsApiBaseUrl('/prep', 'https://checksops.com'),
  );
  assert.equal(
    resolveRuntimeApiBaseUrl('same-origin', 'https://www.checksops.com'),
    resolveAwsApiBaseUrl('same-origin', 'https://www.checksops.com'),
  );
  assert.equal(
    resolveRuntimeApiBaseUrl(STAGING_API),
    resolveAwsApiBaseUrl(STAGING_API),
  );
});

test('staging configuration resolves tenant logos to staging execute-api /storage/public', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'staging',
    CHECKSOPS_API_URL: STAGING_API,
    SIGN_BASE_URL: 'https://staging.checksops.com',
  }, async () => {
    assert.equal(publicApiBaseUrl(), STAGING_API);
    assert.equal(publicTenantLogoUrl(FREEDOM_LOGO), RESOLVED_STAGING);
    assert.equal(
      publicTenantLogoUrl(SUPABASE_LOGO),
      `${STAGING_API}/storage/public?bucket=tenant-logos&path=${encodeURIComponent('acme/logo.png')}`,
    );
    assert.equal(publicTenantLogoUrl('https://cdn.acme.test/brand.png'), 'https://cdn.acme.test/brand.png');
    const branding = await resolveEmailBranding(tenantClient(FREEDOM_LOGO), {
      tenantId: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
    });
    assert.equal(branding.logoUrl, RESOLVED_STAGING);
    assert.doesNotMatch(branding.logoUrl, /staging\.checksops\.com/);
    assert.doesNotMatch(branding.logoUrl, /\/prep\/branding\/logo\//);
  });

  await withEnv({
    CHECKSOPS_ENV: 'staging',
    VITE_CHECKSOPS_API_URL: STAGING_API,
    SIGN_BASE_URL: 'https://staging.checksops.com',
  }, () => {
    assert.equal(publicApiBaseUrl(), STAGING_API);
    assert.equal(publicTenantLogoUrl(FREEDOM_LOGO), RESOLVED_STAGING);
  });
});

test('production configuration resolves tenant logos to production /storage/public', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'production',
    VITE_CHECKSOPS_API_URL: '/prep',
    SIGN_BASE_URL: 'https://checksops.com',
  }, async () => {
    assert.equal(publicApiBaseUrl(), PRODUCTION_PREP);
    assert.equal(publicTenantLogoUrl(FREEDOM_LOGO), RESOLVED_PRODUCTION);
    const branding = await resolveEmailBranding(tenantClient(FREEDOM_LOGO), {
      tenantId: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
    });
    assert.equal(branding.logoUrl, RESOLVED_PRODUCTION);
    assert.doesNotMatch(branding.logoUrl, /staging\.checksops\.com/);
    assert.doesNotMatch(branding.logoUrl, /psr19uhop4/);
  });

  await withEnv({
    CHECKSOPS_ENV: 'production-prep',
    SIGN_BASE_URL: 'https://checksops.com',
  }, () => {
    assert.equal(publicApiBaseUrl(), PRODUCTION_PREP);
    assert.equal(publicTenantLogoUrl(FREEDOM_LOGO), RESOLVED_PRODUCTION);
  });

  await withEnv({
    CHECKSOPS_ENV: 'production',
    CHECKSOPS_API_URL: PRODUCTION_EXECUTE_API,
    SIGN_BASE_URL: 'https://checksops.com',
  }, () => {
    assert.equal(publicApiBaseUrl(), PRODUCTION_EXECUTE_API);
    assert.equal(
      publicTenantLogoUrl(FREEDOM_LOGO),
      `${PRODUCTION_EXECUTE_API}/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_LOGO)}`,
    );
  });
});

test('production can never emit staging.checksops.com or the staging execute-api host', async () => {
  const leaks = [
    {
      CHECKSOPS_ENV: 'production',
      CHECKSOPS_API_URL: STAGING_API,
      SIGN_BASE_URL: 'https://checksops.com',
    },
    {
      CHECKSOPS_ENV: 'production',
      VITE_CHECKSOPS_API_URL: '/prep',
      SIGN_BASE_URL: 'https://staging.checksops.com',
    },
    {
      CHECKSOPS_ENV: 'production-prep',
      CHECKSOPS_API_URL: 'https://staging.checksops.com/prep',
      SIGN_BASE_URL: 'https://checksops.com',
    },
  ];
  for (const env of leaks) {
    await withEnv(env, async () => {
      assert.equal(publicApiBaseUrl(), null);
      assert.equal(publicTenantLogoUrl(FREEDOM_LOGO), null);
      const branding = await resolveEmailBranding(tenantClient(FREEDOM_LOGO), {
        tenantId: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
      });
      assert.match(branding.logoUrl, /checksops-logo\.png/);
      assert.doesNotMatch(branding.logoUrl, /staging\.checksops\.com/);
      assert.doesNotMatch(branding.logoUrl, /psr19uhop4/);
      assert.doesNotMatch(branding.logoUrl, /\/prep\/branding\/logo\//);
      assert.doesNotMatch(branding.logoUrl, /\/storage\/public/);
    });
  }
});

test('missing or invalid API-origin configuration fails closed to the platform logo', async () => {
  const invalid = [
    {
      CHECKSOPS_ENV: 'staging',
      SIGN_BASE_URL: 'https://staging.checksops.com',
    },
    {
      CHECKSOPS_ENV: 'staging',
      VITE_CHECKSOPS_API_URL: '/prep',
      SIGN_BASE_URL: 'https://staging.checksops.com',
    },
    {
      CHECKSOPS_ENV: 'production',
    },
    {
      CHECKSOPS_ENV: 'production',
      VITE_CHECKSOPS_API_URL: '/prep',
    },
    {
      CHECKSOPS_ENV: 'staging',
      CHECKSOPS_API_URL: 'not-a-url',
    },
    {
      CHECKSOPS_ENV: 'staging',
      CHECKSOPS_API_URL: 'http://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging',
    },
  ];
  for (const env of invalid) {
    await withEnv(env, async () => {
      assert.equal(publicApiBaseUrl(), null);
      assert.equal(publicTenantLogoUrl(FREEDOM_LOGO), null);
      const branding = await resolveEmailBranding(tenantClient(FREEDOM_LOGO), {
        tenantId: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
      });
      assert.match(branding.logoUrl, /checksops-logo\.png/);
      assert.doesNotMatch(branding.logoUrl, /\/prep\/branding\/logo\//);
      assert.doesNotMatch(branding.logoUrl, /\/storage\/public/);
      assert.doesNotMatch(branding.logoUrl, /staging\.checksops\.com\/prep/);
    });
  }
});
