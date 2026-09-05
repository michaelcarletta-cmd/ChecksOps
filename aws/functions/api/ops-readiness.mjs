/**
 * Read-only cutover readiness snapshot. No DNS, auth, webhook, or flag changes.
 * Safe to expose on staging. Production cutover remains forbidden.
 */

export const EXECUTION_FLAG_NAMES = [
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_MOOV_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'AWS_PLAID_ENABLED',
  'AWS_ACTUM_ENABLED',
  'AWS_QUICKBOOKS_ENABLED',
  'AWS_PROVIDER_LIVE_READS_ENABLED',
  'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
];

export const flagTrue = (name) => String(process.env[name] || '') === 'true';

export const readinessSnapshot = () => {
  const flags = Object.fromEntries(
    EXECUTION_FLAG_NAMES.map((name) => [name, flagTrue(name)]),
  );
  return {
    service: 'checksops-api',
    environment: process.env.CHECKSOPS_ENV || 'unknown',
    productionCutoverForbidden: true,
    productionSupabaseChanged: false,
    productionDnsChanged: false,
    productionAuthSwitched: false,
    productionWebhooksRedirected: false,
    financialActivationSqlApplied: false,
    plaidRequired: false,
    bridgesMustRemainDeployed: true,
    checkAltHandledSeparately: true,
    cognitoMfaPreferred: flagTrue('AWS_COGNITO_MFA_PREFERRED'),
    flags,
    webauthn: {
      origin: process.env.COGNITO_WEBAUTHN_ORIGIN || 'https://staging.checksops.com',
      rpId: process.env.COGNITO_WEBAUTHN_RP_ID || 'staging.checksops.com',
    },
    emailOtp: {
      authFlow: 'USER_AUTH',
      preferredChallenge: 'EMAIL_OTP',
    },
  };
};

export const stagingSafetyHolds = (snap = readinessSnapshot()) => {
  const failures = [];
  if (!snap.productionCutoverForbidden) failures.push('cutover_forbidden_cleared');
  if (snap.productionDnsChanged) failures.push('dns_changed');
  if (snap.productionAuthSwitched) failures.push('auth_switched');
  if (snap.productionWebhooksRedirected) failures.push('webhooks_redirected');
  if (snap.financialActivationSqlApplied) failures.push('financial_sql_applied');
  if (snap.plaidRequired) failures.push('plaid_treated_required');
  if (snap.cognitoMfaPreferred) failures.push('cognito_mfa_preferred_on');
  for (const name of EXECUTION_FLAG_NAMES) {
    if (snap.flags?.[name]) failures.push(`${name}=true`);
  }
  return {
    ok: failures.length === 0,
    failures,
  };
};
