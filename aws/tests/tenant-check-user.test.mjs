import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canMoveTenantChecks } from '../functions/api/tenant-check-user.mjs';

test('tenant membership is enough to move checks', () => {
  assert.equal(canMoveTenantChecks({ roles: ['staff'], isTenantMember: true }), true);
  assert.equal(canMoveTenantChecks({ roles: [], isTenantMember: true }), true);
});

test('platform admin can move checks without membership', () => {
  assert.equal(canMoveTenantChecks({ roles: new Set(['admin']), isTenantMember: false }), true);
});

test('client or contractor without membership cannot move checks', () => {
  assert.equal(canMoveTenantChecks({ roles: ['client'], isTenantMember: false }), false);
  assert.equal(canMoveTenantChecks({ roles: ['contractor'], isTenantMember: false }), false);
});
