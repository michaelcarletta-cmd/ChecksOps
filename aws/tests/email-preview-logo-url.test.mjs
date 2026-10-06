import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyEmailPreviewLogo,
  brandingPublicUrl,
  isBrokenEmailPreviewLogoSrc,
  shouldReplacePreviewLogoSrc,
} from '../../src/lib/brandingPublicUrl.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FREEDOM_LOGO = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/logo-1790801891632.png';
const API_BASE = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const RESOLVED = `${API_BASE}/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_LOGO)}`;
const LIVE_PREVIEW_SRC = `https://staging.checksops.com/prep/branding/logo/2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`;

const layout = (src) => `<!DOCTYPE html>
<html><body>
  <img src="${src}" alt="ChecksOps" width="220" style="display:block;">
</body></html>`;

test('brandingPublicUrl rewrites the stored Freedom object path to execute-api storage/public', () => {
  assert.equal(brandingPublicUrl(FREEDOM_LOGO, 'tenant-logos', API_BASE), RESOLVED);
  assert.equal(brandingPublicUrl(RESOLVED, 'tenant-logos', API_BASE), RESOLVED);
  assert.equal(brandingPublicUrl('javascript:alert(1)', 'tenant-logos', API_BASE), null);
});

test('live SPA-host /prep/branding/logo src is treated as broken and replaced', () => {
  assert.equal(isBrokenEmailPreviewLogoSrc(LIVE_PREVIEW_SRC), true);
  assert.equal(isBrokenEmailPreviewLogoSrc('https://staging.checksops.com/checksops-logo.png'), true);
  assert.equal(isBrokenEmailPreviewLogoSrc(FREEDOM_LOGO), true);
  assert.equal(isBrokenEmailPreviewLogoSrc(RESOLVED), false);
  assert.equal(shouldReplacePreviewLogoSrc(LIVE_PREVIEW_SRC, RESOLVED), true);
  assert.equal(shouldReplacePreviewLogoSrc(RESOLVED, RESOLVED), false);
  assert.equal(shouldReplacePreviewLogoSrc('https://cdn.acme.test/other.png', RESOLVED), false);
});

test('preview HTML from live Lambda is rewritten to the working Branding-page URL', () => {
  const rewritten = applyEmailPreviewLogo(layout(LIVE_PREVIEW_SRC), FREEDOM_LOGO, API_BASE);
  assert.match(rewritten, /psr19uhop4\.execute-api\.us-east-1\.amazonaws\.com\/staging\/storage\/public\?bucket=tenant-logos/);
  assert.match(rewritten, /logo-1790801891632\.png/);
  assert.doesNotMatch(rewritten, /staging\.checksops\.com\/prep\/branding\/logo/);
  assert.doesNotMatch(rewritten, /checksops-logo\.png/);

  const platform = applyEmailPreviewLogo(
    layout('https://staging.checksops.com/checksops-logo.png'),
    FREEDOM_LOGO,
    API_BASE,
  );
  assert.match(platform, /\/storage\/public\?bucket=tenant-logos/);
  assert.doesNotMatch(platform, /checksops-logo\.png/);
});

test('EmailSenderSettings preview iframe uses the public-storage rewrite', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/settings/EmailSenderSettings.tsx'), 'utf8');
  assert.match(ui, /applyEmailPreviewLogo/);
  assert.match(ui, /brandingPublicUrl\(storedLogo, "tenant-logos"\)/);
  assert.match(ui, /srcDoc=\{previewHtml\}/);
  assert.doesNotMatch(ui, /srcDoc=\{preview\.html\}/);
  assert.doesNotMatch(ui, /Email Brand Color/);
  assert.doesNotMatch(ui, /invoice_accent_color/);
});
