import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  classifyLoginMemberships,
  INACTIVE_ORG_LOGIN_MESSAGE,
  NO_MEMBERSHIP_LOGIN_MESSAGE,
} from '../../src/lib/loginMembership.ts';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('active membership resolves to its tenant slug', () => {
  assert.deepEqual(
    classifyLoginMemberships([
      { tenant_id: 't0', tenants: null },
      { tenant_id: 't1', tenants: { slug: 'acme', subscription_status: 'active' } },
    ]),
    { kind: 'active', slug: 'acme' },
  );
});

test('membership whose tenant is hidden by tenants_public (null embed) is inactive, not missing', () => {
  assert.deepEqual(classifyLoginMemberships([{ tenant_id: 't1', tenants: null }]), { kind: 'inactive' });
});

test('membership whose tenant row is not active is inactive', () => {
  assert.deepEqual(
    classifyLoginMemberships([{ tenant_id: 't1', tenants: { slug: 'acme', subscription_status: 'inactive' } }]),
    { kind: 'inactive' },
  );
});

test('no membership rows means no account access', () => {
  assert.deepEqual(classifyLoginMemberships([]), { kind: 'none' });
  assert.deepEqual(classifyLoginMemberships(null), { kind: 'none' });
  assert.deepEqual(classifyLoginMemberships(undefined), { kind: 'none' });
});

test('messages distinguish inactive organization from no membership', () => {
  assert.match(INACTIVE_ORG_LOGIN_MESSAGE.description, /organization isn't active yet/);
  assert.match(INACTIVE_ORG_LOGIN_MESSAGE.description, /administrator to activate it/);
  assert.match(NO_MEMBERSHIP_LOGIN_MESSAGE.description, /isn't a member of any active organization/);
});

test('CheckOpsLogin membership query keeps inactive-tenant rows (no !inner) and uses the classifier', () => {
  const src = read('src/pages/checkops/CheckOpsLogin.tsx');
  assert.doesNotMatch(src, /tenants!inner/);
  assert.match(src, /select\("tenant_id, tenants\(slug, subscription_status\)"\)/);
  assert.match(src, /classifyLoginMemberships\(/);
  assert.match(src, /INACTIVE_ORG_LOGIN_MESSAGE/);
});

test('WhiteLabelApp shows Subscription Inactive before Organization Not Found for hidden inactive tenants', () => {
  const src = read('src/pages/WhiteLabelApp.tsx');
  const inactiveAt = src.indexOf('if (tenantInactive)');
  const notFoundAt = src.indexOf('if (error || !tenant)');
  assert.ok(inactiveAt > 0 && notFoundAt > inactiveAt);
  assert.match(src, /\.from\("tenants"\)\s*\.select\("subscription_status"\)/);
});
