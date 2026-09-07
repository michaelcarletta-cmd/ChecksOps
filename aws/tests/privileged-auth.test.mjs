import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluatePrivilegedEnrollment,
  isPrivilegedRoleList,
  privilegedAuthPolicy,
} from '../functions/api/privileged-auth.mjs';
import { handleMfaSetPreference } from '../functions/api/auth-mfa.mjs';

test('privileged roles are admin/staff/owner/manager only', () => {
  assert.equal(isPrivilegedRoleList(['user']), false);
  assert.equal(isPrivilegedRoleList(['mortgage_agent']), false);
  assert.equal(isPrivilegedRoleList(['admin']), true);
  assert.equal(isPrivilegedRoleList(['Staff']), true);
});

test('privileged enrollment accepts TOTP or a passkey and does not unlock money', () => {
  const missing = evaluatePrivilegedEnrollment({ roles: ['admin'] });
  assert.equal(missing.required, true);
  assert.equal(missing.error, 'privileged_step_up_enrollment_required');
  assert.equal(evaluatePrivilegedEnrollment({ roles: ['admin'], totpEnrolled: true }).satisfied, true);
  assert.equal(evaluatePrivilegedEnrollment({ roles: ['staff'], passkeyCount: 1 }).satisfied, true);
  assert.equal(evaluatePrivilegedEnrollment({ roles: ['user'] }).required, false);
  const policy = privilegedAuthPolicy();
  assert.equal(policy.preferredMfaAtLogin, false);
  assert.equal(policy.moneyMovementUnlocked, false);
  assert.equal(policy.financialPermissionsActivated, false);
  assert.equal(policy.apiBehindCloudFrontRequiredBeforeFinancial, true);
});

test('preferred MFA at login remains refused', async () => {
  const result = await handleMfaSetPreference();
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'cognito_preferred_mfa_disabled');
  assert.equal(result.moneyMovementUnlocked, false);
});
