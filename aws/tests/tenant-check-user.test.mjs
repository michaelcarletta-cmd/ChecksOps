import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canMoveTenantChecks } from '../functions/api/tenant-check-user.mjs';

test('operating tenant membership is enough to move checks', () => {
  assert.equal(canMoveTenantChecks({ roles: ['staff'], isTenantMember: true, tenantRole: 'operator' }), true);
  assert.equal(canMoveTenantChecks({ roles: [], isTenantMember: true, tenantRole: 'admin' }), true);
});

test('view-only tenant members cannot move checks', () => {
  assert.equal(canMoveTenantChecks({ roles: ['staff'], isTenantMember: true, tenantRole: 'viewer' }), false);
  assert.equal(canMoveTenantChecks({ roles: [], isTenantMember: true, tenantRole: 'read_only' }), false);
  assert.equal(canMoveTenantChecks({ roles: [], isTenantMember: true, tenantRole: null }), false);
});

test('platform admin can move checks without membership', () => {
  assert.equal(canMoveTenantChecks({ roles: new Set(['admin']), isTenantMember: false }), true);
});

test('client or contractor without membership cannot move checks', () => {
  assert.equal(canMoveTenantChecks({ roles: ['client'], isTenantMember: false }), false);
  assert.equal(canMoveTenantChecks({ roles: ['contractor'], isTenantMember: false }), false);
});

test('AWS override reads tenant role instead of any membership row', () => {
  const source = readFileSync('aws/functions/api/admin-override-check-status.mjs', 'utf8');
  assert.match(source, /SELECT role FROM public\.tenant_users/);
  assert.match(source, /tenantRole: member\?\.role/);
});
