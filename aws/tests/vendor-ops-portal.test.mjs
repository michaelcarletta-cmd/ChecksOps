import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isVendorOpsPath,
  resolveVendorWorkspace,
  VENDOR_OPS_HOME_PATH,
  VENDOR_OPS_LOGIN_PATH,
  VENDOR_OPS_MEMBERSHIP_SELECT,
  VENDOR_OPS_NAV,
} from '../../src/lib/vendorOps.ts';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('vendor portal paths are static /vendor-ops paths', () => {
  assert.equal(VENDOR_OPS_LOGIN_PATH, '/vendor-ops/login');
  assert.equal(VENDOR_OPS_HOME_PATH, '/vendor-ops/wallet');
  assert.deepEqual(VENDOR_OPS_NAV.map((n) => n.to), ['/vendor-ops/wallet', '/vendor-ops/payments', '/vendor-ops/settings']);
  assert.equal(isVendorOpsPath('/vendor-ops'), true);
  assert.equal(isVendorOpsPath('/vendor-ops/payments'), true);
  assert.equal(isVendorOpsPath('/vendor-opsx'), false);
  assert.equal(isVendorOpsPath('/acme/wallet-ops'), false);
});

test('vendor workspace resolves like the ChecksOps login: active slug, inactive, or none', () => {
  assert.deepEqual(
    resolveVendorWorkspace([{ tenant_id: 't1', tenants: { slug: 'acme', subscription_status: 'active' } }]),
    { kind: 'active', slug: 'acme' },
  );
  assert.deepEqual(resolveVendorWorkspace([{ tenant_id: 't1', tenants: null }]), { kind: 'inactive' });
  assert.deepEqual(resolveVendorWorkspace([]), { kind: 'none' });
  assert.doesNotMatch(VENDOR_OPS_MEMBERSHIP_SELECT, /!inner/);
});

test('App declares /vendor-ops routes before the /:slug/* tenant catch-all', () => {
  const src = read('src/App.tsx');
  const vendorAt = src.indexOf('path="/vendor-ops"');
  const loginAt = src.indexOf('path="/vendor-ops/login"');
  const slugAt = src.indexOf('path="/:slug/*"');
  assert.ok(vendorAt > 0 && loginAt > 0 && slugAt > 0);
  assert.ok(vendorAt < slugAt && loginAt < slugAt);
});

test('vendor portal uses the main ChecksOps session and mounts its own TenantProvider', () => {
  const layout = read('src/pages/vendor-ops/VendorOpsLayout.tsx');
  const login = read('src/pages/vendor-ops/VendorOpsLogin.tsx');
  for (const src of [layout, login]) {
    assert.match(src, /from "@\/integrations\/supabase\/client"/);
    assert.match(src, /from "@\/hooks\/useAuth"/);
    assert.doesNotMatch(src, /createClient\(/);
    assert.doesNotMatch(src, /vendorClient|useVendorAuth/);
  }
  assert.match(layout, /<TenantProvider slug=\{workspace\.slug\}>/);
  assert.doesNotMatch(layout, /useParams/);
});
