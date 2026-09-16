import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Manager CheckAlt Settings is mounted on the live /:slug/checks command center', () => {
  const ccc = read('src/pages/CheckCommandCenter.tsx');
  const settings = read('src/components/settings/CheckAltAutoDepositSettings.tsx');
  const wl = read('src/components/white-label/WhiteLabelCheckCenter.tsx');
  const app = read('src/pages/WhiteLabelApp.tsx');
  const manager = read('src/components/deposit-ops/DepositManagerCommandCenter.tsx');
  const rails = read('src/lib/depositRails.ts');

  assert.match(app, /path="checks"/);
  assert.match(app, /WhiteLabelCheckCenter/);
  assert.match(wl, /CheckCommandCenter/);
  assert.match(ccc, /label: "Manager"/);
  assert.match(ccc, /CheckAlt Settings/);
  assert.match(ccc, /value="checkalt_settings"/);
  assert.match(ccc, /<CheckAltAutoDepositSettings/);
  assert.match(ccc, /Auto-Deposit Eligible Checks|canConfigure=\{isAdmin \|\| isTenantOwnerOrAdmin\}/);
  assert.match(settings, /Auto-Deposit Eligible Checks/);
  assert.match(settings, /Maximum Auto-Deposit Amount/);
  assert.match(rails, /export const SHOW_CHECKALT = true/);

  // Dead command-center is not a production route and must not be the only mount.
  assert.doesNotMatch(ccc, /DepositManagerCommandCenter/);
  assert.doesNotMatch(manager, /CheckAltAutoDepositSettings/);
  assert.equal(
    (read('src/components/white-label/WhiteLabelSettings.tsx').includes('CheckAltAutoDepositSettings')),
    false,
    'Do not duplicate Auto-Deposit onto the Settings gear page',
  );
});

test('Manager access and Auto-Deposit edit use tenant owner/admin, not white-label-only gating', () => {
  const ccc = read('src/pages/CheckCommandCenter.tsx');
  const settings = read('src/components/settings/CheckAltAutoDepositSettings.tsx');

  assert.match(ccc, /enabled: !!tenantId && !!user\?\.id,/);
  assert.doesNotMatch(ccc, /enabled: !!tenantId && !!user\?\.id && isWhiteLabel/);
  assert.match(ccc, /const isTenantOwnerOrAdmin/);
  assert.match(ccc, /const canAccessManager = isAdmin \|\| isTenantOwnerOrAdmin/);
  assert.doesNotMatch(ccc, /isWhiteLabel && \["admin", "owner"\]/);

  assert.match(settings, /useTenantFilter/);
  assert.match(settings, /const isTenantOwnerOrAdmin/);
  assert.match(settings, /const canEdit = isTenantOwnerOrAdmin;/);
  assert.doesNotMatch(settings, /if \(!allowed\) return null/);
  assert.match(settings, /Staff and operators\s+cannot edit these settings/);
});

test('existing CheckAlt platform config stays on AdminTenants, not Manager', () => {
  const admin = read('src/pages/admin/AdminTenants.tsx');
  const platform = read('src/components/settings/CheckAltSettings.tsx');
  assert.match(admin, /<CheckAltSettings \/>/);
  assert.match(platform, /Admin-only configuration panel for the CheckAlt/);
  assert.doesNotMatch(admin, /CheckAltAutoDepositSettings/);
});
