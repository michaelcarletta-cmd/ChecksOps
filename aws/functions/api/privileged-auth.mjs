/**
 * Privileged / financial operator controls for Batch 3.
 * Does not change Cognito first-factor login (EMAIL_OTP / PASSWORD / WEB_AUTHN).
 * Does not set AWS_COGNITO_MFA_PREFERRED or unlock money flags.
 */
import { flagTrue } from './ops-readiness.mjs';

// Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act.
// Every tenant member can move money, so every member (and the platform owner)
// is privileged for step-up purposes. Role tiers and platform user_roles
// admin/staff are not consulted.
export const isPrivilegedIdentity = ({ tenants = [], isPlatformOwner = false } = {}) => (
  isPlatformOwner === true || (Array.isArray(tenants) && tenants.length > 0)
);

export const privilegedAuthPolicy = () => ({
  policy: 'totp_or_webauthn_before_privileged_and_financial',
  privileged: 'any_tenant_member_or_platform_owner',
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
  tenants = [],
  isPlatformOwner = false,
  totpEnrolled = false,
  passkeyCount = 0,
} = {}) => {
  const privileged = isPrivilegedIdentity({ tenants, isPlatformOwner });
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
