#!/usr/bin/env node
/**
 * Create or reuse a dedicated production API execution role and attach it
 * to checksops-production-prep-api. Does not grant staging provider secrets.
 * Does not enable financial/provider execution. Staging Lambda is left unchanged.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const PREP = 'checksops-production-prep-api';
const STAGING = 'checksops-staging-api';
const ROLE_NAME = 'checksops-production-api-execution';
const ROLE_ARN = `arn:aws:iam::806168576068:role/${ROLE_NAME}`;
const STAGING_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-ApiFunctionRole-7E7XRyLe3nyi';
const APP_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/1788286468693-b4U0Rn';
const PROVIDER_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/staging/providers-W1DqaY';
const FILES_BUCKET = 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const ROLE_STACK = 'checksops-production-api-role';
const ROLE_TEMPLATE = path.join(ROOT, 'aws/production/api-execution-role.yaml');

if (!process.argv.includes('--confirm-prod-role')) {
  console.error(JSON.stringify({ error: 'refusing_prod_role_separation' }));
  process.exit(2);
}

const run = (args) => {
  try {
    return { ok: true, data: JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' }) || '{}') };
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    return {
      ok: false,
      action: (text.match(/perform: ([a-z0-9:]+)/i) || [])[1] || null,
      denied: /AccessDenied|not authorized/i.test(text),
      alreadyExists: /EntityAlreadyExists|AlreadyExists/i.test(text),
      message: text.slice(0, 500),
    };
  }
};

const minimumAgentIam = {
  note: 'Grant these on ChecksOpsCursorCloudStaging for this role only. Do not broaden the agent role.',
  actions: [
    'iam:CreateRole',
    'iam:TagRole',
    'iam:GetRole',
    'iam:ListAttachedRolePolicies',
    'iam:ListRolePolicies',
    'iam:GetRolePolicy',
    'iam:PutRolePolicy',
    'iam:AttachRolePolicy',
    'iam:PassRole',
    'lambda:GetFunctionConfiguration',
    'lambda:UpdateFunctionConfiguration',
  ],
  resources: [
    ROLE_ARN,
    `arn:aws:lambda:${REGION}:806168576068:function:${PREP}`,
  ],
  passRoleCondition: { 'iam:PassedToService': 'lambda.amazonaws.com' },
  alternative: `Operator can deploy ${ROLE_TEMPLATE} as stack ${ROLE_STACK} with CAPABILITY_NAMED_IAM, then rerun this script.`,
};

const trust = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
});
const inline = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AppDatabaseSecretRead',
      Effect: 'Allow',
      Action: ['secretsmanager:GetSecretValue'],
      Resource: APP_SECRET,
    },
    {
      Sid: 'PrivateCheckImageBucket',
      Effect: 'Allow',
      Action: [
        's3:GetObject', 's3:GetObjectVersion', 's3:GetBucketLocation', 's3:ListBucket',
        's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:AbortMultipartUpload',
      ],
      Resource: [`arn:aws:s3:::${FILES_BUCKET}`, `arn:aws:s3:::${FILES_BUCKET}/*`],
    },
  ],
});

const beforePrep = run(['lambda', 'get-function-configuration', '--function-name', PREP]);
const beforeStaging = run(['lambda', 'get-function-configuration', '--function-name', STAGING]);
const attempts = [];

const created = run([
  'iam', 'create-role',
  '--role-name', ROLE_NAME,
  '--assume-role-policy-document', trust,
  '--description', 'Dedicated ChecksOps production API execution. No staging provider secrets.',
  '--tags', 'Key=Environment,Value=production', 'Key=HardeningBatch,Value=1',
]);
attempts.push({ step: 'createRole', ...created, arn: created.data?.Role?.Arn || null });

if (!created.ok && !created.alreadyExists) {
  const cfn = run([
    'cloudformation', 'deploy',
    '--stack-name', ROLE_STACK,
    '--template-file', ROLE_TEMPLATE,
    '--capabilities', 'CAPABILITY_NAMED_IAM',
    '--no-fail-on-empty-changeset',
  ]);
  attempts.push({ step: 'cloudformationDeployRole', ...cfn });
}

const attachedVpc = run([
  'iam', 'attach-role-policy',
  '--role-name', ROLE_NAME,
  '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
]);
const attachedXray = run([
  'iam', 'attach-role-policy',
  '--role-name', ROLE_NAME,
  '--policy-arn', 'arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess',
]);
const putInline = run([
  'iam', 'put-role-policy',
  '--role-name', ROLE_NAME,
  '--policy-name', 'ProductionApiLeastPrivilege',
  '--policy-document', inline,
]);
attempts.push({ step: 'attachVpc', ...attachedVpc });
attempts.push({ step: 'attachXray', ...attachedXray });
attempts.push({ step: 'putInline', ...putInline });

const roleReady = created.ok || created.alreadyExists || attachedVpc.ok || putInline.ok;
let lambdaUpdate = { ok: false, skipped: true, message: 'role_not_ready' };
if (roleReady) {
  lambdaUpdate = run(['lambda', 'update-function-configuration', '--function-name', PREP, '--role', ROLE_ARN]);
  attempts.push({ step: 'updateLambdaRole', ...lambdaUpdate });
  if (lambdaUpdate.ok) {
    try {
      execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', PREP], { encoding: 'utf8' });
    } catch {
      /* describe below */
    }
  }
}

const afterPrep = run(['lambda', 'get-function-configuration', '--function-name', PREP]);
const afterStaging = run(['lambda', 'get-function-configuration', '--function-name', STAGING]);
const prepVars = afterPrep.data?.Environment?.Variables || {};
const stagingVars = afterStaging.data?.Environment?.Variables || {};
const getRole = run(['iam', 'get-role', '--role-name', ROLE_NAME]);
const inlineDoc = run(['iam', 'get-role-policy', '--role-name', ROLE_NAME, '--policy-name', 'ProductionApiLeastPrivilege']);

const report = {
  ok: Boolean(afterPrep.data?.Role)
    && afterPrep.data.Role === ROLE_ARN
    && afterStaging.data?.Role === STAGING_ROLE
    && afterPrep.data.Role !== afterStaging.data?.Role
    && !prepVars.PROVIDER_SECRETS_ARN
    && stagingVars.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED === 'true'
    && prepVars.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED === 'false'
    && prepVars.AWS_MOOV_ENABLED === 'false'
    && prepVars.AWS_CHECKALT_ENABLED === 'false'
    && prepVars.AWS_PROVIDER_EXECUTION_ENABLED === 'false'
    && prepVars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED === 'false',
  mutated: Boolean(lambdaUpdate.ok),
  roleName: ROLE_NAME,
  intendedRoleArn: ROLE_ARN,
  before: {
    prepRole: beforePrep.data?.Role || null,
    stagingRole: beforeStaging.data?.Role || null,
    shared: beforePrep.data?.Role && beforePrep.data.Role === beforeStaging.data?.Role,
  },
  after: {
    prepRole: afterPrep.data?.Role || null,
    stagingRole: afterStaging.data?.Role || null,
    shared: afterPrep.data?.Role && afterPrep.data.Role === afterStaging.data?.Role,
    prepProviderSecretsArn: Boolean(prepVars.PROVIDER_SECRETS_ARN),
    stagingProviderSecretsArn: Boolean(stagingVars.PROVIDER_SECRETS_ARN),
    stagingSandbox: stagingVars.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED || null,
  },
  grants: {
    appDatabaseSecret: APP_SECRET,
    providerSecretExplicitlyOmitted: PROVIDER_SECRET,
    filesBucket: FILES_BUCKET,
    roleDocumentHasProviderSecret: JSON.stringify(inlineDoc.data || {}).includes('checksops/staging/providers'),
  },
  attempts,
  roleExists: Boolean(getRole.ok),
  minimumAgentIam,
  template: readFileSync(ROLE_TEMPLATE, 'utf8').includes('checksops/staging/providers') ? 'contains_provider_secret' : 'omits_provider_secret',
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch1-iam.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
