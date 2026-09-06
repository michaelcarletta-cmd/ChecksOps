#!/usr/bin/env node
/**
 * Attach the flags-off production-prep API to RDS and enable application writes.
 * Never enables Moov, CheckAlt, provider execution, or financial grants.
 */
import { execFileSync } from 'node:child_process';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const PREP = 'checksops-production-prep-api';
const STAGING = 'checksops-staging-api';

if (!process.argv.includes('--confirm-t0-api')) {
  console.error(JSON.stringify({ error: 'refusing_prod_api_attach' }));
  process.exit(2);
}

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' }) || '{}');

const staging = awsJson(['lambda', 'get-function-configuration', '--function-name', STAGING]);
const prep = awsJson(['lambda', 'get-function-configuration', '--function-name', PREP]);
const stagingVars = staging.Environment?.Variables || {};
const prepVars = { ...(prep.Environment?.Variables || {}) };

prepVars.DATABASE_NAME = stagingVars.DATABASE_NAME || 'checksops';
prepVars.DATABASE_SECRET_ARN = stagingVars.DATABASE_SECRET_ARN;
prepVars.FILES_BUCKET = stagingVars.FILES_BUCKET;
prepVars.AWS_WRITES_ENABLED = 'true';
prepVars.AWS_CHECK_WORKFLOW_WRITES_ENABLED = 'true';
prepVars.AWS_STORAGE_WRITES_ENABLED = 'true';
prepVars.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
prepVars.AWS_PROVIDER_EXECUTION_ENABLED = 'false';
prepVars.AWS_MOOV_ENABLED = 'false';
prepVars.AWS_CHECKALT_ENABLED = 'false';
prepVars.AWS_PLAID_ENABLED = 'false';
prepVars.AWS_ACTUM_ENABLED = 'false';
prepVars.AWS_QUICKBOOKS_ENABLED = 'false';
prepVars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED = 'false';
prepVars.AWS_PROVIDER_LIVE_READS_ENABLED = 'false';
prepVars.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED = 'false';
prepVars.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED = 'false';
prepVars.COGNITO_USER_POOL_ID = 'us-east-1_h00WorYMT';
prepVars.COGNITO_CLIENT_ID = prepVars.COGNITO_CLIENT_ID || '3ja9fqaq2fjkv3i6up2varcqpe';
prepVars.COGNITO_WEBAUTHN_ORIGIN = 'https://checksops.com';
prepVars.COGNITO_WEBAUTHN_RP_ID = 'checksops.com';
prepVars.SIGN_BASE_URL = 'https://checksops.com';

if (!prepVars.DATABASE_SECRET_ARN) {
  console.error(JSON.stringify({ error: 'missing_database_secret_arn' }));
  process.exit(1);
}

const vpc = staging.VpcConfig || {};
const stagingRole = staging.Role;
awsJson([
  'lambda', 'update-function-configuration',
  '--function-name', PREP,
  '--role', stagingRole,
  '--vpc-config', `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`,
  '--environment', JSON.stringify({ Variables: prepVars }),
]);
execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', PREP], { encoding: 'utf8' });

const after = awsJson(['lambda', 'get-function-configuration', '--function-name', PREP]);
const vars = after.Environment?.Variables || {};
const report = {
  ok: vars.COGNITO_USER_POOL_ID === 'us-east-1_h00WorYMT'
    && vars.AWS_PROVIDER_EXECUTION_ENABLED === 'false'
    && vars.AWS_MOOV_ENABLED === 'false'
    && vars.AWS_CHECKALT_ENABLED === 'false'
    && vars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED === 'false'
    && vars.AWS_WRITES_ENABLED === 'true'
    && vars.DATABASE_NAME === 'checksops'
    && (after.VpcConfig?.SubnetIds || []).length > 0,
  functionName: PREP,
  databaseName: vars.DATABASE_NAME,
  vpcSubnets: after.VpcConfig?.SubnetIds || [],
  cognitoPool: vars.COGNITO_USER_POOL_ID,
  writesEnabled: vars.AWS_WRITES_ENABLED,
  providerExecution: vars.AWS_PROVIDER_EXECUTION_ENABLED,
  moov: vars.AWS_MOOV_ENABLED,
  checkalt: vars.AWS_CHECKALT_ENABLED,
  financial: vars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
