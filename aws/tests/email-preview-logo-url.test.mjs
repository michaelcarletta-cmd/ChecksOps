import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publicTenantLogoUrl } from '../functions/api/email-branding.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FREEDOM_LOGO = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/logo-1790801891632.png';
const API_BASE = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const RESOLVED = `${API_BASE}/storage/public?bucket=tenant-logos&path=${encodeURIComponent(FREEDOM_LOGO)}`;
const LIVE_PREVIEW_SRC = `https://staging.checksops.com/prep/branding/logo/2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('API resolver maps the stored Freedom object path to execute-api storage/public', () => {
  assert.equal(publicTenantLogoUrl(FREEDOM_LOGO, API_BASE), RESOLVED);
  assert.equal(publicTenantLogoUrl(RESOLVED, API_BASE), RESOLVED);
  assert.equal(publicTenantLogoUrl('javascript:alert(1)', API_BASE), null);
  assert.doesNotMatch(publicTenantLogoUrl(FREEDOM_LOGO, API_BASE) || '', /\/prep\/branding\/logo\//);
  assert.doesNotMatch(publicTenantLogoUrl(FREEDOM_LOGO, API_BASE) || '', /staging\.checksops\.com\/prep\//);
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
