/**
 * Read-only C1C staging identity investigation.
 * Does not AdminSetUserPassword, ForgotPassword, or disable/enable users.
 * Does not print passwords, tokens, or secrets.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const POOL_ID = 'us-east-1_vPmQ7cL1F';
const CLIENT_ID = '71bb7a192cbl6o6s8m259tl589';
const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const C1C_EMAILS = [
  'payments@condition1commercial.com',
  'asukanick@condition1commercial.com',
  'lhogan@condition1commercial.com',
];
const MASTER_EMAIL = 'staging-master@checksops.invalid';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const safeUser = (user) => {
  if (!user) return null;
  const attrs = Object.fromEntries((user.UserAttributes || []).map((a) => [a.Name, a.Value]));
  return {
    username: user.Username || null,
    enabled: user.Enabled ?? null,
    userStatus: user.UserStatus || null,
    userCreateDate: user.UserCreateDate || null,
    userLastModifiedDate: user.UserLastModifiedDate || null,
    emailVerified: attrs.email_verified || null,
    hasEmail: Boolean(attrs.email),
    emailMatchesExpected: C1C_EMAILS.includes(String(attrs.email || '').toLowerCase())
      || String(attrs.email || '').toLowerCase() === MASTER_EMAIL,
    mfaOptions: user.MFAOptions || [],
    sub: attrs.sub || null,
  };
};

const getUser = (email) => {
  try {
    return { ok: true, email, user: safeUser(awsJson(['cognito-idp', 'admin-get-user', '--user-pool-id', POOL_ID, '--username', email])) };
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    const denied = /AccessDenied|not authorized|explicit deny/i.test(text);
    const missing = /UserNotFoundException/i.test(text);
    return {
      ok: false,
      email,
      denied,
      missing,
      errorName: missing ? 'UserNotFoundException' : denied ? 'AccessDenied' : 'CognitoReadFailed',
    };
  }
};

const describeClient = () => {
  try {
    const raw = awsJson(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', POOL_ID, '--client-id', CLIENT_ID]);
    const client = raw.UserPoolClient || {};
    return {
      ok: true,
      clientIdMatches: client.ClientId === CLIENT_ID,
      explicitAuthFlows: client.ExplicitAuthFlows || [],
      preventUserExistenceErrors: client.PreventUserExistenceErrors || null,
      enableTokenRevocation: client.EnableTokenRevocation ?? null,
      hasUserPasswordAuth: (client.ExplicitAuthFlows || []).includes('ALLOW_USER_PASSWORD_AUTH'),
      hasSrp: (client.ExplicitAuthFlows || []).includes('ALLOW_USER_SRP_AUTH'),
      hasRefresh: (client.ExplicitAuthFlows || []).includes('ALLOW_REFRESH_TOKEN_AUTH'),
      hasAdminUserPasswordAuth: (client.ExplicitAuthFlows || []).includes('ALLOW_ADMIN_USER_PASSWORD_AUTH'),
    };
  } catch (error) {
    return { ok: false, errorName: /AccessDenied|not authorized/i.test(String(error.stderr || error.message)) ? 'AccessDenied' : 'DescribeClientFailed' };
  }
};

const loginProbe = async (email, password, label) => {
  if (!password) return { skipped: true, label, email, reason: 'password_not_supplied' };
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return {
    label,
    email,
    httpStatus: res.status,
    ok: body.ok === true,
    error: body.error || null,
    message: body.message ? String(body.message).slice(0, 200) : null,
    challenge: body.challenge || null,
    hasAuthentication: Boolean(body.authentication?.idToken),
  };
};

const client = describeClient();
const users = {};
for (const email of [...C1C_EMAILS, MASTER_EMAIL]) {
  users[email] = getUser(email);
}

const c1cPassword = process.env.CHECKSOPS_C1C_PROBE_PASSWORD || '';
const masterPassword = process.env.CHECKSOPS_MASTER_PROBE_PASSWORD || '';
const probes = {
  c1cPayments: await loginProbe(C1C_EMAILS[0], c1cPassword, 'c1c_payments_admin'),
  c1cAsukanick: await loginProbe(C1C_EMAILS[1], c1cPassword, 'c1c_asukanick'),
  masterUat: await loginProbe(MASTER_EMAIL, masterPassword, 'master_uat'),
};

const payments = users[C1C_EMAILS[0]];
const rootCause = (() => {
  if (payments?.denied) return 'cognito_admin_get_user_denied';
  if (payments?.missing) return 'cognito_user_missing';
  const status = payments?.user?.userStatus;
  const enabled = payments?.user?.enabled;
  if (enabled === false) return 'cognito_user_disabled';
  if (status === 'FORCE_CHANGE_PASSWORD') return 'force_change_password';
  if (status === 'RESET_REQUIRED') return 'password_reset_required';
  if (status && status !== 'CONFIRMED') return `cognito_status_${String(status).toLowerCase()}`;
  if (client.ok && client.hasUserPasswordAuth === false) return 'app_client_missing_user_password_auth';
  if (probes.c1cPayments.httpStatus === 400 || probes.c1cPayments.ok === false) {
    const msg = String(probes.c1cPayments.message || probes.c1cPayments.error || '');
    if (/NotAuthorizedException|incorrect username or password/i.test(msg)) return 'not_authorized_password_or_auth_flow';
    if (/PasswordResetRequiredException/i.test(msg)) return 'password_reset_required';
    if (/UserNotFoundException/i.test(msg)) return 'user_not_found_at_login';
    if (/InvalidParameterException/i.test(msg)) return 'invalid_parameter_auth_flow';
    if (probes.c1cPayments.httpStatus === 400) return 'login_http_400';
    return 'login_failed';
  }
  if (probes.c1cPayments.ok) return 'c1c_login_succeeded';
  return 'unknown_pending_login_probe';
})();

const report = {
  productionUntouched: true,
  cognitoMutations: 'none',
  poolId: POOL_ID,
  clientId: CLIENT_ID,
  client,
  users,
  probes: {
    c1cPayments: { ...probes.c1cPayments, passwordSupplied: Boolean(c1cPassword) },
    c1cAsukanick: { ...probes.c1cAsukanick, passwordSupplied: Boolean(c1cPassword) },
    masterUat: { ...probes.masterUat, passwordSupplied: Boolean(masterPassword) },
  },
  rootCause,
  proposedCognitoChange: null,
};
if (rootCause !== 'c1c_login_succeeded' && payments?.user?.enabled && ['CONFIRMED', 'FORCE_CHANGE_PASSWORD', 'RESET_REQUIRED'].includes(payments?.user?.userStatus)) {
  report.proposedCognitoChange = {
    action: 'STOP_DO_NOT_APPLY',
    minimal: 'Staging-only AdminSetUserPassword Permanent=true on payments@condition1commercial.com, then verify /auth/login and /identity/me. Do not touch Freedom A8-035 or production.',
    reason: rootCause,
  };
}

fs.writeFileSync('/opt/cursor/artifacts/phase2_c1c_cognito_inspect.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
