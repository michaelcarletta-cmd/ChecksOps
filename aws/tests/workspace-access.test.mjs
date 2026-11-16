import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  decideWorkspaceAccess,
  identityListsTenant,
  identityTenantMemberships,
} from '../../src/lib/workspaceAccess.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TENANT_ID = '6f1c1a52-3a1e-4d0b-9a2f-0c4c2f1e7b10';
const OTHER_ID = '0a8f7a7e-5b55-4b6b-8f0c-3f3a0c9f9d21';

// /identity/me `tenants` rows (identity.mjs TENANT_MEMBERSHIP_SQL) as toUser keeps them.
const identityRows = [
  { tenant_id: TENANT_ID, role: 'owner', tenant_name: 'Freedom Adjustment', tenant_slug: 'freedom' },
];

const base = {
  tenantId: TENANT_ID,
  tenantSlug: 'freedom',
  identityTenants: [],
  tenantUsersRow: false,
  tenantUsersError: false,
  isMasterMerchant: false,
};

test('identity tenant list naming this tenant makes the user a member, even when the read failed', () => {
  const identityTenants = identityTenantMemberships(identityRows);
  assert.deepEqual(identityTenants, [{ tenant_id: TENANT_ID, tenant_slug: 'freedom', role: 'owner' }]);
  assert.equal(decideWorkspaceAccess({ ...base, identityTenants }), 'member');
  assert.equal(decideWorkspaceAccess({ ...base, identityTenants, tenantUsersError: true }), 'member');
  assert.equal(decideWorkspaceAccess({ ...base, identityTenants: identityRows }), 'member');
});

test('identity match is by id, or by slug when the entry carries one', () => {
  assert.equal(identityListsTenant([{ tenant_id: TENANT_ID.toUpperCase() }], TENANT_ID, null), true);
  assert.equal(identityListsTenant([{ tenant_id: null, tenant_slug: 'Freedom' }], OTHER_ID, 'freedom'), true);
  assert.equal(identityListsTenant([{ tenant_id: OTHER_ID, tenant_slug: 'other' }], TENANT_ID, 'freedom'), false);
  assert.equal(identityListsTenant(undefined, TENANT_ID, 'freedom'), false);
  assert.equal(identityListsTenant(['owner', 'admin'], TENANT_ID, 'freedom'), false);
  assert.equal(identityListsTenant(identityRows, null, null), false);
  assert.equal(
    decideWorkspaceAccess({ ...base, identityTenants: [{ tenant_id: OTHER_ID, tenant_slug: 'other', role: 'owner' }] }),
    'denied',
  );
});

test('a tenant_users row makes the user a member', () => {
  assert.equal(decideWorkspaceAccess({ ...base, tenantUsersRow: true }), 'member');
});

test('a failed read with the identity list missing this tenant is unconfirmed, not denied', () => {
  assert.equal(decideWorkspaceAccess({ ...base, tenantUsersError: true }), 'unconfirmed');
  assert.equal(decideWorkspaceAccess({ ...base, identityTenants: undefined, tenantUsersError: true }), 'unconfirmed');
});

test('no row and no error with the identity list missing this tenant is denied', () => {
  assert.equal(decideWorkspaceAccess(base), 'denied');
  assert.equal(decideWorkspaceAccess({ ...base, identityTenants: undefined }), 'denied');
});

test('the master merchant is a member of any tenant', () => {
  assert.equal(decideWorkspaceAccess({ ...base, isMasterMerchant: true }), 'member');
  assert.equal(decideWorkspaceAccess({ ...base, isMasterMerchant: true, tenantUsersError: true }), 'member');
});

test('the AWS user carries the identity tenant list (tenant_id, tenant_slug, role)', () => {
  for (const rel of ['src/integrations/aws/client.ts', 'src/lib/awsPasswordless.ts']) {
    const src = read(rel);
    assert.match(src, /import \{ identityTenantMemberships \} from "@\/lib\/workspaceAccess";/, rel);
    assert.match(src, /tenant_memberships: identityTenantMemberships\(identity\??\.tenants\)/, rel);
    // tenant_roles (role strings) is kept as it was for the other readers.
    assert.match(src, /tenant_roles: Array\.isArray\(identity\??\.tenants\)/, rel);
  }
});

for (const rel of ['src/pages/WhiteLabelApp.tsx', 'src/components/white-label/CustomDomainWhiteLabelApp.tsx']) {
  test(`${rel} decides access with the helper and has the Retry screen`, () => {
    const src = read(rel);
    assert.match(src, /import \{ decideWorkspaceAccess, identityListsTenant \} from "@\/lib\/workspaceAccess";/);
    assert.match(src, /decideWorkspaceAccess\(\{/);
    assert.match(src, /identityTenants: user\?\.app_metadata\?\.tenant_memberships/);
    assert.match(src, /const \{ data, error \} = await supabase\s*\.from\("tenant_users"\)/);
    assert.match(src, /return \{ row: !!data, failed: !!error \};/);
    assert.match(src, /const isMember = workspaceAccess === "member";/);
    // Retry screen on a failed read; Access Denied only for "denied".
    assert.match(src, /workspaceAccess === "unconfirmed"/);
    assert.match(src, /We couldn't confirm your access to \{tenant\.name\}\./);
    assert.match(src, /onClick=\{\(\) => void refetchMembership\(\)\}/);
    assert.match(src, />\s*\{memberFetching \? "Checking…" : "Retry"\}/);
    const denied = src.indexOf('<h1 className="text-2xl font-bold">Access Denied</h1>');
    assert.ok(denied > 0);
    const guard = src.lastIndexOf('workspaceAccess === "denied"', denied);
    assert.ok(guard > 0 && guard > src.lastIndexOf('workspaceAccess === "unconfirmed"', denied));
    // The old rule (any error read as "not a member") is gone.
    assert.doesNotMatch(src, /!!isTenantMember/);
    // Unchanged screens stay.
    assert.match(src, /Subscription Inactive/);
  });
}
