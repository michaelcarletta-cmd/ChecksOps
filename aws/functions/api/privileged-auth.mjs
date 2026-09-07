/**
 * Privileged / financial operator controls for Batch 3.
 * Does not change Cognito first-factor login (EMAIL_OTP / PASSWORD / WEB_AUTHN).
 * Does not set AWS_COGNITO_MFA_PREFERRED or unlock money flags.
 */
import { flagTrue } from './ops-readiness.mjs';

export const PRIVILEGED_ROLES = Object.freeze(['admin', 'staff', 'owner', 'manager']);

export const isPrivilegedRoleList = (roles = []) => roles
  .map((role) => String(role || '').toLowerCase())
  .some((role) => PRIVILEGED_ROLES.includes(role));

export const privilegedAuthPolicy = () => ({
  policy: 'totp_or_webauthn_before_privileged_and_financial',
  privilegedRoles: [...PRIVILEGED_ROLES],
  loginFirstFactorsUnchanged: ['EMAIL_OTP', 'PASSWORD', 'WEB_AUTHN'],
  preferredMfaAtLogin: false,
  poolMfaIntended: 'OPTIONAL',
  recovery: 'verified_email',
  financialPermissionsActivated: flagTrue('AWS_FINANCIAL_PERMISSIONS_ACTIVATED'),
  providerExecutionEnabled: flagTrue('AWS_PROVIDER_EXECUTION_ENABLED'),
  moneyMovementUnlocked: false,
  apiBehindCloudFrontRequiredBeforeFinancial: true,
});

export const evaluatePrivilegedEnrollment = ({
  roles = [],
  totpEnrolled = false,
  passkeyCount = 0,
} = {}) => {
  const privileged = isPrivilegedRoleList(roles);
  const satisfied = Boolean(totpEnrolled) || Number(passkeyCount) > 0;
  return {
    privileged,
    totpEnrolled: Boolean(totpEnrolled),
    passkeyCount: Number(passkeyCount) || 0,
    satisfied: !privileged || satisfied,
    required: privileged && !satisfied,
    error: privileged && !satisfied ? 'privileged_step_up_enrollment_required' : null,
  };
};
