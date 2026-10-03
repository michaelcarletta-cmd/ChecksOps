import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  brandingBucketForField,
  isRawBrandingObjectPath,
  resolvePublicBrandingUrl,
  rewriteBrandingStorageFields,
} from '../../src/lib/brandingPublicUrl.ts';

const FREEDOM_LOGO = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/logo-1790615777558.png';
const LETTERHEAD = 'invoice_letterhead_1790615777558.png';
const PUBLIC_LOGO = '/prep/storage/public?bucket=tenant-logos&path=already.png';
const ABSOLUTE = 'https://cdn.acme.test/brand.png';
const SUPABASE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/storage/v1/object/public/tenant-logos/4f172140-f57a-4744-8050-95f4f07b13b4/1778078357240.png';
const BASE = '/prep';

test('branding field names map to public buckets', () => {
  assert.equal(brandingBucketForField('logo_url'), 'tenant-logos');
  assert.equal(brandingBucketForField('logoUrl'), 'tenant-logos');
  assert.equal(brandingBucketForField('invoice_letterhead_url'), 'company-branding');
  assert.equal(brandingBucketForField('letterhead_url'), 'company-branding');
  assert.equal(brandingBucketForField('payment_link_url'), null);
});

test('raw AWS object paths resolve through /storage/public without rewriting stored shape', () => {
  assert.equal(isRawBrandingObjectPath(FREEDOM_LOGO), true);
  assert.equal(isRawBrandingObjectPath(LETTERHEAD), true);
  assert.equal(isRawBrandingObjectPath(ABSOLUTE), false);
  assert.equal(isRawBrandingObjectPath(PUBLIC_LOGO), false);
  assert.equal(isRawBrandingObjectPath('javascript:alert(1)'), false);
  assert.equal(isRawBrandingObjectPath('../secret.png'), false);

  const logo = resolvePublicBrandingUrl(FREEDOM_LOGO, 'tenant-logos', BASE);
  assert.equal(logo, `${BASE}/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_LOGO)}`);

  const letterhead = resolvePublicBrandingUrl(LETTERHEAD, 'company-branding', BASE);
  assert.equal(letterhead, `${BASE}/storage/public?bucket=company-branding&path=${encodeURIComponent(LETTERHEAD)}`);

  assert.equal(resolvePublicBrandingUrl(ABSOLUTE, 'tenant-logos', BASE), ABSOLUTE);
  assert.equal(resolvePublicBrandingUrl(PUBLIC_LOGO, 'tenant-logos', BASE), PUBLIC_LOGO);
  assert.equal(resolvePublicBrandingUrl('javascript:alert(1)', 'tenant-logos', BASE), null);
});

test('rewriteStorageFields normalizes branding URLs on read only', () => {
  const rewritten = rewriteBrandingStorageFields({
    logo_url: FREEDOM_LOGO,
    invoice_letterhead_url: LETTERHEAD,
    letterhead_url: 'letterhead_1.png',
    payment_link_url: 'https://pay.example/invoice/1',
    name: 'Freedom Adjustment',
  }, BASE);
  assert.equal(rewritten.logo_url, `${BASE}/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_LOGO)}`);
  assert.equal(rewritten.invoice_letterhead_url, `${BASE}/storage/public?bucket=company-branding&path=${encodeURIComponent(LETTERHEAD)}`);
  assert.equal(rewritten.letterhead_url, `${BASE}/storage/public?bucket=company-branding&path=${encodeURIComponent('letterhead_1.png')}`);
  assert.equal(rewritten.payment_link_url, 'https://pay.example/invoice/1');
  assert.equal(rewritten.name, 'Freedom Adjustment');

  const supabase = rewriteBrandingStorageFields({ logo_url: SUPABASE }, BASE);
  assert.equal(
    supabase.logo_url,
    `${BASE}/storage/public?bucket=tenant-logos&path=${encodeURIComponent('4f172140-f57a-4744-8050-95f4f07b13b4/1778078357240.png')}`,
  );

  const preserved = rewriteBrandingStorageFields({ logo_url: PUBLIC_LOGO }, BASE);
  assert.equal(preserved.logo_url, PUBLIC_LOGO);
});
