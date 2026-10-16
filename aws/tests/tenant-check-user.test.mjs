import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canMoveTenantChecks } from '../functions/api/tenant-check-user.mjs';

test('any company user can move checks', () => {
  assert.equal(canMoveTenantChecks({ roles: ['staff'], isTenantMember: true }), true);
  assert.equal(canMoveTenantChecks({ roles: [], isTenantMember: true }), true);
  assert.equal(canMoveTenantChecks({ roles: ['read_only'], isTenantMember: true }), true);
});

test('a global user_roles admin/staff without membership of the check tenant cannot move checks', () => {
  assert.equal(canMoveTenantChecks({ roles: new Set(['admin']), isTenantMember: false }), false);
  assert.equal(canMoveTenantChecks({ roles: ['staff'], isTenantMember: false }), false);
  assert.equal(canMoveTenantChecks({ roles: ['admin'] }), false);
});

test('client or contractor without membership cannot move checks', () => {
  assert.equal(canMoveTenantChecks({ roles: ['client'], isTenantMember: false }), false);
  assert.equal(canMoveTenantChecks({ roles: ['contractor'], isTenantMember: false }), false);
});

test('AWS override treats any tenant_users row as a company user', () => {
  const source = readFileSync('aws/functions/api/admin-override-check-status.mjs', 'utf8');
  assert.match(source, /SELECT 1 FROM public\.tenant_users/);
  assert.match(source, /isTenantMember: !!member/);
  assert.doesNotMatch(source, /tenantRole/);
});
