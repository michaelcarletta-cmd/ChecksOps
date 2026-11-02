import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FREEDOM_ADJUSTMENT_TENANT_ID,
  isVendorOpsPath,
  VENDOR_OPS_ENABLED_TENANT_IDS,
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

const FA = FREEDOM_ADJUSTMENT_TENANT_ID;

test('only Freedom Adjustment is enabled, and its id matches the API constant', () => {
  assert.deepEqual([...VENDOR_OPS_ENABLED_TENANT_IDS], [FA]);
  const api = read('aws/functions/api/authorization.mjs');
  assert.match(api, new RegExp(`FREEDOM_TENANT_ID = '${FA}'`));
});

test('Freedom Adjustment member opens its workspace; inactive and none behave like the login', () => {
  assert.deepEqual(
    resolveVendorWorkspace([{ tenant_id: FA, tenants: { slug: 'freedom', subscription_status: 'active' } }]),
    { kind: 'active', slug: 'freedom' },
  );
  assert.deepEqual(resolveVendorWorkspace([{ tenant_id: FA, tenants: null }]), { kind: 'inactive' });
  assert.deepEqual(resolveVendorWorkspace([]), { kind: 'none' });
  assert.deepEqual(resolveVendorWorkspace(null), { kind: 'none' });
  assert.doesNotMatch(VENDOR_OPS_MEMBERSHIP_SELECT, /!inner/);
});

test('regular tenant members are refused, even with an active organization', () => {
  assert.deepEqual(
    resolveVendorWorkspace([{ tenant_id: 't-acme', tenants: { slug: 'acme', subscription_status: 'active' } }]),
    { kind: 'not_enabled' },
  );
});

test('a member of a regular tenant and Freedom Adjustment opens Freedom Adjustment, never the other', () => {
  assert.deepEqual(
    resolveVendorWorkspace([
      { tenant_id: 't-acme', tenants: { slug: 'acme', subscription_status: 'active' } },
      { tenant_id: FA, tenants: { slug: 'freedom', subscription_status: 'active' } },
    ]),
    { kind: 'active', slug: 'freedom' },
  );
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
  assert.match(layout, /VENDOR_OPS_NOT_ENABLED_MESSAGE/);
  assert.doesNotMatch(layout, /useParams/);
});
