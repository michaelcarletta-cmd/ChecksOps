import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTenantLogoUrl, rewriteLogoFields } from '../src/lib/resolveTenantLogoUrl.mjs';

test('relative AWS tenant-logos path becomes the public storage resolver', () => {
  const url = resolveTenantLogoUrl('2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/logo-1.png', '/prep');
  assert.match(String(url), /\/storage\/public\?/);
  assert.match(String(url), /bucket=tenant-logos/);
  assert.match(String(url), /path=2eff5f1a-929d-4ce3-9a8b-cd96b98df42a%2Flogo-1\.png/);
});

test('already-absolute https logo URLs are kept', () => {
  const abs = 'https://cdn.freedomadj.com/logo.png';
  assert.equal(resolveTenantLogoUrl(abs, '/prep'), abs);
});

test('supabase tenant-logos URLs rewrite to the AWS public resolver', () => {
  const url = resolveTenantLogoUrl('https://xyz.supabase.co/storage/v1/object/public/tenant-logos/freedom/logo.png', '/prep');
  assert.match(String(url), /\/storage\/public\?/);
  assert.match(String(url), /bucket=tenant-logos/);
  assert.match(String(url), /path=freedom%2Flogo\.png/);
});

test('missing or traversal logo values fall back', () => {
  assert.equal(resolveTenantLogoUrl(null), null);
  assert.equal(resolveTenantLogoUrl(''), null);
  assert.equal(resolveTenantLogoUrl('../secret.png'), null);
});

test('rewriteLogoFields resolves logo_url without touching another tenant row', () => {
  const rows = rewriteLogoFields([
    { id: 'a', logo_url: 'tenant-a/logo.png' },
    { id: 'b', logo_url: null },
  ], '/prep');
  assert.match(rows[0].logo_url, /bucket=tenant-logos/);
  assert.match(rows[0].logo_url, /tenant-a%2Flogo\.png/);
  assert.equal(rows[1].logo_url, null);
});
