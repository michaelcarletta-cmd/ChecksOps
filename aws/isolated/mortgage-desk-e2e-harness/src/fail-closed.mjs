import {
  AWS_ACCOUNT_ID,
  AWS_REGION,
  FORBIDDEN_HOST_PATTERNS,
  FORBIDDEN_SECRET_PATTERNS,
  HARNESS_FUNCTION_NAME,
  STAGING_DATABASE_NAME,
  STAGING_DB_USER,
  STAGING_RDS_HOST,
  STAGING_SECRET_ARN_PREFIX,
  STAGING_SECRET_NAME_PREFIX,
} from './constants.mjs';

const present = (value) => value != null && String(value).trim() !== '';

export const secretLooksProductionOrProvider = (value) => {
  const text = String(value || '');
  return FORBIDDEN_SECRET_PATTERNS.some((pattern) => pattern.test(text));
};

export const hostLooksUnsafe = (value) => {
  const text = String(value || '');
  if (!text) return true;
  return FORBIDDEN_HOST_PATTERNS.some((pattern) => pattern.test(text));
};

export const stagingSecretArnAllowed = (arn) => {
  const text = String(arn || '');
  if (!text.startsWith(STAGING_SECRET_ARN_PREFIX)) return false;
  if (secretLooksProductionOrProvider(text)) return false;
  if (/checksops_admin/i.test(text)) return false;
  return true;
};

export const evaluateFailClosed = (env = process.env, extras = {}) => {
  const errors = [];
  const functionName = extras.functionName || env.AWS_LAMBDA_FUNCTION_NAME || env.HARNESS_FUNCTION_NAME;
  if (functionName !== HARNESS_FUNCTION_NAME) {
    errors.push(`function_name_mismatch:${functionName || 'missing'}`);
  }
  if (String(env.CHECKSOPS_ENV || '') !== 'staging') {
    errors.push('checksops_env_not_staging');
  }
  if (String(env.DATABASE_NAME || '') !== STAGING_DATABASE_NAME) {
    errors.push('database_name_not_checksops');
  }
  if (String(env.RDS_HOST || '') !== STAGING_RDS_HOST) {
    errors.push('rds_host_not_staging');
  }
  if (hostLooksUnsafe(env.RDS_HOST)) {
    errors.push('rds_host_unsafe');
  }
  if (!stagingSecretArnAllowed(env.DATABASE_SECRET_ARN)) {
    errors.push('database_secret_arn_not_staging_app');
  }
  if (present(env.PROVIDER_SECRETS_ARN) || present(env.ADMIN_SECRET_ARN)) {
    errors.push('forbidden_secret_env_present');
  }
  for (const flag of [
    'AWS_PROVIDER_EXECUTION_ENABLED',
    'AWS_MOOV_ENABLED',
    'AWS_CHECKALT_ENABLED',
    'AWS_PLAID_ENABLED',
    'AWS_ACTUM_ENABLED',
    'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
    'ALLOW_SYNTHETIC_WRITES',
  ]) {
    if (String(env[flag] || '').toLowerCase() === 'true') {
      errors.push(`flag_enabled:${flag}`);
    }
  }
  if (extras.accountId && extras.accountId !== AWS_ACCOUNT_ID) {
    errors.push(`account_mismatch:${extras.accountId}`);
  }
  if (extras.region && extras.region !== AWS_REGION) {
    errors.push(`region_mismatch:${extras.region}`);
  }
  if (extras.currentDatabase && extras.currentDatabase !== STAGING_DATABASE_NAME) {
    errors.push(`current_database_mismatch:${extras.currentDatabase}`);
  }
  if (extras.currentUser && extras.currentUser !== STAGING_DB_USER) {
    errors.push(`current_user_mismatch:${extras.currentUser}`);
  }
  if (extras.secretUser && extras.secretUser !== STAGING_DB_USER) {
    errors.push(`secret_user_mismatch:${extras.secretUser}`);
  }
  if (extras.secretHost && extras.secretHost !== STAGING_RDS_HOST) {
    errors.push(`secret_host_mismatch:${extras.secretHost}`);
  }
  if (extras.secretName && !String(extras.secretName).startsWith(STAGING_SECRET_NAME_PREFIX)) {
    errors.push('secret_name_not_staging_app');
  }
  return {
    ok: errors.length === 0,
    errors,
  };
};

export const refuseWriteAction = (action) => ({
  ok: false,
  statusCode: 403,
  error: 'synthetic_writes_not_authorized',
  action,
  message: 'This harness deployment is authorized for READ-ONLY preflight only. run_initial, run_additional, and cleanup stay refused.',
  rowsCreated: 0,
  rowsUpdated: 0,
  rowsDeleted: 0,
});
