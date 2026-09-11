/**
 * Financial TOTP routes. Enrollment and step-up are application-level.
 * Cognito SOFTWARE_TOKEN_MFA is not used for login or financial authorization.
 * Does NOT set AWS_FINANCIAL_PERMISSIONS_ACTIVATED. Money stays off.
 */
import {
  handleMfaAssociate,
  handleMfaSetPreference,
  handleMfaStatus,
  handleMfaStepUp,
  handleMfaVerify,
} from './auth-financial-totp.mjs';

const POOL_ID = () => process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = () => process.env.COGNITO_CLIENT_ID;

/**
 * Diagnostic only. Financial authorization must not use this.
 * Login MFA on the Cognito user is independent of app-level financial TOTP.
 */
export const evaluateCognitoTotpEnrollment = (user = {}) => {
  const list = user.UserMFASettingList || user.userMFASettingList || [];
  const preferred = user.PreferredMfaSetting || user.preferredMfaSetting || null;
  return {
    totpEnrolled: Array.isArray(list) && list.includes('SOFTWARE_TOKEN_MFA'),
    preferredMfa: preferred || null,
    userMfaSettingList: Array.isArray(list) ? list : [],
  };
};

export {
  handleMfaAssociate,
  handleMfaSetPreference,
  handleMfaStatus,
  handleMfaStepUp,
  handleMfaVerify,
};

export const MFA_AUTH_ROUTES = {
  '/auth/mfa/status': handleMfaStatus,
  '/auth/mfa/associate': handleMfaAssociate,
  '/auth/mfa/verify': handleMfaVerify,
  '/auth/mfa/step-up': handleMfaStepUp,
  '/auth/mfa/set-preference': handleMfaSetPreference,
};

export const MFA_PREP = {
  userPoolIdConfigured: Boolean(POOL_ID()),
  clientIdConfigured: Boolean(CLIENT_ID()),
  preferredMfaEnabled: false,
  financialPermissionsActivated: false,
};
