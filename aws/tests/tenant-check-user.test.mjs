import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canMoveTenantChecks } from '../functions/api/tenant-check-user.mjs';

const MIGRATION = 'supabase/migrations/20261002200000_user_can_move_tenant_checks_membership_only.sql';
const PRIOR = 'supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql';

test('same-company tenant_users member is allowed regardless of legacy role label', () => {
  assert.equal(canMoveTenantChecks({ roles: ['staff'], isTenantMember: true }), true);
  assert.equal(canMoveTenantChecks({ roles: ['admin'], isTenantMember: true }), true);
  assert.equal(canMoveTenantChecks({ roles: ['read_only'], isTenantMember: true }), true);
  assert.equal(canMoveTenantChecks({ roles: ['client'], isTenantMember: true }), true);
});

test('same-company member with no privileged role is allowed', () => {
  assert.equal(canMoveTenantChecks({ roles: [], isTenantMember: true }), true);
  assert.equal(canMoveTenantChecks({ isTenantMember: true }), true);
});

test('other-company user labeled admin is denied', () => {
  assert.equal(canMoveTenantChecks({ roles: new Set(['admin']), isTenantMember: false }), false);
});

test('other-company user labeled staff is denied', () => {
  assert.equal(canMoveTenantChecks({ roles: ['staff'], isTenantMember: false }), false);
});

test('non-member platform admin is denied', () => {
  assert.equal(canMoveTenantChecks({ roles: ['admin'], isTenantMember: false }), false);
  assert.equal(canMoveTenantChecks({ roles: new Set(['admin']), isTenantMember: undefined }), false);
});

test('non-members without a tenant_users row cannot move checks', () => {
  assert.equal(canMoveTenantChecks({ roles: ['client'], isTenantMember: false }), false);
  assert.equal(canMoveTenantChecks({ roles: ['contractor'], isTenantMember: false }), false);
  assert.equal(canMoveTenantChecks({}), false);
});

test('canMoveTenantChecks ignores role arguments and has no admin escape', () => {
  const source = readFileSync('aws/functions/api/tenant-check-user.mjs', 'utf8');
  assert.match(source, /isTenantMember === true/);
  assert.doesNotMatch(source, /set\.has\(['"]admin['"]\)/);
  assert.doesNotMatch(source, /roles\.has\(/);
  assert.doesNotMatch(source, /staff/);
});

test('AWS override authorizes solely via tenant_users membership', () => {
  const source = readFileSync('aws/functions/api/admin-override-check-status.mjs', 'utf8');
  assert.match(source, /SELECT 1 FROM public\.tenant_users/);
  assert.match(source, /canMoveTenantChecks\(\{\s*isTenantMember: !!member\s*\}\)/);
  assert.doesNotMatch(source, /USER_ROLES_SQL/);
  assert.doesNotMatch(source, /tenantRole/);
  assert.doesNotMatch(source, /roles\.has\(/);
});

test('forward SQL migration replaces only user_can_move_tenant_checks membership helper', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const prior = readFileSync(PRIOR, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.user_can_move_tenant_checks\(_user_id uuid, _tenant_id uuid\)/);
  assert.match(sql, /SELECT public\.user_belongs_to_tenant\(_user_id, _tenant_id\)/);
  assert.doesNotMatch(sql, /has_role/);
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.admin_override_check_status/);
  assert.doesNotMatch(sql, /^\s*GRANT\b/m);
  assert.doesNotMatch(sql, /^\s*REVOKE\b/m);
  assert.doesNotMatch(sql, /^\s*(CREATE|ALTER|DROP|ENABLE)\s+POLICY\b/im);
  assert.doesNotMatch(sql, /\bENABLE ROW LEVEL\b/i);
  assert.match(prior, /admin_override_check_status/);
  assert.match(prior, /has_role\(_user_id, 'admin'::app_role\)/);
  const sha = createHash('sha256').update(sql).digest('hex');
  assert.equal(sha.length, 64);
});
