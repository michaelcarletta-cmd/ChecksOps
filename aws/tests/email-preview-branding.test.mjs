import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyEmailPreviewBranding,
  isSafeEmailBrandColor,
  normalizeEmailBrandColor,
  resolvePreviewLogoUrl,
  shouldReplacePreviewLogoSrc,
  PLATFORM_EMAIL_BRAND_COLOR,
} from '../../src/lib/brandingPublicUrl.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FREEDOM_LOGO = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/logo-1790801891632.png';
const API_BASE = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const RESOLVED = `${API_BASE}/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_LOGO)}`;
const CLOUDFRONT_PREP = `https://staging.checksops.com/prep/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_LOGO)}`;

const layout = ({ src, color = '#13579b' }) => `<!DOCTYPE html>
<html><body>
  <img src="${src}" alt="ChecksOps" width="220">
  <td style="height:4px;background:${color};">&nbsp;</td>
  <td align="center" bgcolor="${color}"><a href="https://staging.checksops.com/h/preview">Open</a></td>
</body></html>`;

test('safe hex colors and 3-digit expansion', () => {
  assert.equal(isSafeEmailBrandColor('#13579b'), true);
  assert.equal(isSafeEmailBrandColor('#1a56db'), true);
  assert.equal(isSafeEmailBrandColor('#fff'), true);
  assert.equal(isSafeEmailBrandColor('red'), false);
  assert.equal(isSafeEmailBrandColor('#13579b;background:url(javascript:alert(1))'), false);
  assert.equal(normalizeEmailBrandColor('#13579b'), '#13579b');
  assert.equal(normalizeEmailBrandColor('#abc'), '#aabbcc');
  assert.equal(normalizeEmailBrandColor('nope'), PLATFORM_EMAIL_BRAND_COLOR);
});

test('preview logo resolution uses public storage and does not rewrite stored paths', () => {
  assert.equal(resolvePreviewLogoUrl(FREEDOM_LOGO, API_BASE), RESOLVED);
  assert.equal(resolvePreviewLogoUrl(RESOLVED, API_BASE), RESOLVED);
  assert.equal(resolvePreviewLogoUrl('/prep/storage/public?bucket=tenant-logos&path=already.png', API_BASE, 'https://staging.checksops.com'),
    'https://staging.checksops.com/prep/storage/public?bucket=tenant-logos&path=already.png');
  assert.equal(resolvePreviewLogoUrl('javascript:alert(1)', API_BASE), null);
  assert.equal(FREEDOM_LOGO.includes('storage/public'), false);
});

test('preview src replacement covers platform, raw, and CloudFront /prep logos', () => {
  assert.equal(shouldReplacePreviewLogoSrc('https://staging.checksops.com/checksops-logo.png', RESOLVED), true);
  assert.equal(shouldReplacePreviewLogoSrc('/checksops-logo.png', RESOLVED), true);
  assert.equal(shouldReplacePreviewLogoSrc(FREEDOM_LOGO, RESOLVED), true);
  assert.equal(shouldReplacePreviewLogoSrc(CLOUDFRONT_PREP, RESOLVED), true);
  assert.equal(shouldReplacePreviewLogoSrc(RESOLVED, RESOLVED), false);
  assert.equal(shouldReplacePreviewLogoSrc('javascript:alert(1)', RESOLVED), false);
  assert.equal(shouldReplacePreviewLogoSrc('https://cdn.acme.test/other.png', RESOLVED), false);
});

test('preview HTML uses the SPA-resolved tenant logo and live brand color', () => {
  const platform = applyEmailPreviewBranding(layout({
    src: 'https://staging.checksops.com/checksops-logo.png',
    color: '#1a56db',
  }), {
    logoUrl: FREEDOM_LOGO,
    primaryColor: '#13579b',
    previousColors: ['#1a56db'],
    apiBaseUrl: API_BASE,
  });
  assert.match(platform, /psr19uhop4\.execute-api\.us-east-1\.amazonaws\.com\/staging\/storage\/public\?bucket=tenant-logos/);
  assert.match(platform, /logo-1790801891632\.png/);
  assert.doesNotMatch(platform, /checksops-logo\.png/);
  assert.match(platform, /#13579b/);
  assert.doesNotMatch(platform, /#1a56db/);

  const raw = applyEmailPreviewBranding(layout({ src: FREEDOM_LOGO, color: '#13579b' }), {
    logoUrl: RESOLVED,
    primaryColor: '#0a3d73',
    previousColors: ['#13579b'],
    apiBaseUrl: API_BASE,
  });
  assert.match(raw, /src="https:\/\/psr19uhop4/);
  assert.equal(raw.includes(`src="${FREEDOM_LOGO}"`), false);
  assert.match(raw, /#0a3d73/);
  assert.doesNotMatch(raw, /#13579b/);

  const prep = applyEmailPreviewBranding(layout({ src: CLOUDFRONT_PREP, color: '#13579b' }), {
    logoUrl: RESOLVED,
    apiBaseUrl: API_BASE,
  });
  assert.match(prep, /execute-api\.us-east-1\.amazonaws\.com\/staging\/storage\/public/);
  assert.doesNotMatch(prep, /staging\.checksops\.com\/prep\/storage\/public/);
});

test('EmailSenderSettings preview and color stay on tenants.primary_color', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/settings/EmailSenderSettings.tsx'), 'utf8');
  assert.match(ui, /applyEmailPreviewBranding/);
  assert.match(ui, /awsApiBaseUrl\(\)/);
  assert.match(ui, /Email Brand Color/);
  assert.match(ui, /primary_color:\s*nextColor/);
  assert.match(ui, /\.from\("tenants"\)/);
  assert.match(ui, /resolvePublicBrandingUrl\(settings\?\.logoUrl \|\| tenant\?\.logo_url/);
  assert.doesNotMatch(ui, /Invoice Accent Color/);
  assert.doesNotMatch(ui, /Invoice Theme/);
  assert.doesNotMatch(ui, /invoice_accent_color/);
  assert.doesNotMatch(ui, /invoice_theme/);
  assert.doesNotMatch(ui, /secondary_color/);
  assert.doesNotMatch(ui, /checksops-logo\\\.png/);
});
