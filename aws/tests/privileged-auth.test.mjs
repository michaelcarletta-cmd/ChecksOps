import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluatePrivilegedEnrollment,
  isPrivilegedIdentity,
  privilegedAuthPolicy,
} from '../functions/api/privileged-auth.mjs';
import { handleMfaSetPreference } from '../functions/api/auth-mfa.mjs';

// Owner policy: every member of a tenant is a user with the same rights (money
// movement included), so every member is privileged for step-up purposes;
// platform user_roles admin/staff and role tiers are not consulted.
test('privileged identity is any tenant membership or the platform owner', () => {
  assert.equal(isPrivilegedIdentity({ tenants: [{ tenant_id: 't1', role: 'viewer' }] }), true);
  assert.equal(isPrivilegedIdentity({ tenants: [], isPlatformOwner: true }), true);
  assert.equal(isPrivilegedIdentity({ tenants: [] }), false);
  assert.equal(isPrivilegedIdentity(), false);
});

test('privileged enrollment accepts TOTP or a passkey and does not unlock money', () => {
  const tenants = [{ tenant_id: 't1', role: 'viewer' }];
  const missing = evaluatePrivilegedEnrollment({ tenants });
  assert.equal(missing.required, true);
  assert.equal(missing.error, 'privileged_step_up_enrollment_required');
  assert.equal(evaluatePrivilegedEnrollment({ tenants, totpEnrolled: true }).satisfied, true);
  assert.equal(evaluatePrivilegedEnrollment({ isPlatformOwner: true, passkeyCount: 1 }).satisfied, true);
  assert.equal(evaluatePrivilegedEnrollment({ tenants: [] }).required, false);
  const policy = privilegedAuthPolicy();
  assert.equal(policy.preferredMfaAtLogin, false);
  assert.equal(policy.moneyMovementUnlocked, false);
  assert.equal(policy.financialPermissionsActivated, false);
  assert.equal(policy.apiBehindCloudFrontRequiredBeforeFinancial, true);
  assert.equal('privilegedRoles' in policy, false);
});

test('preferred MFA at login remains refused', async () => {
  const result = await handleMfaSetPreference();
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'cognito_preferred_mfa_disabled');
  assert.equal(result.moneyMovementUnlocked, false);
});
