#!/usr/bin/env node
/**
 * Operator-only capture / surgical apply / verify for
 * checksops-production-api-execution tenant-invite Cognito.
 *
 * Does NOT update CloudFormation stack checksops-production-api-role.
 * Does NOT change the role trust policy.
 * Does NOT modify Lambda code or environment.
 *
 * Modes:
 *   capture  (default)  write the complete live role snapshot
 *   apply               merge the three pool-scoped invite actions onto the
 *                       existing ProductionApiLeastPrivilege document
 *   verify              re-read live role and prove the invite grant
 *   diff-template       compare a snapshot (or live role) to the repo template
 *
 * Apply requires CONFIRM=APPLY_PRODUCTION_INVITE_COGNITO_IAM.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROLE_NAME,
  POLICY_NAME,
  PRODUCTION_POOL_ARN,
  REQUIRED_ACTIONS,
  mergeInviteCognitoStatement,
  verifyInviteCognitoPolicy,
  verifyNonCognitoPreserved,
} from '../lib/production-invite-cognito-iam.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const MODE = String(process.argv[2] || process.env.MODE || 'capture').trim();
const OUT_DIR = process.env.SNAPSHOT_DIR
  || path.join('/tmp', 'prod-iam-invite-cognito');
const CONFIRM = String(process.env.CONFIRM || '').trim();

const awsJson = (args) => {
  const raw = execFileSync(AWS, [...args, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
  }).trim();
  if (!raw) return {};
  return JSON.parse(raw);
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};

const decodePolicy = (document) => {
  if (document == null) return null;
  if (typeof document === 'string') {
    try {
      return JSON.parse(decodeURIComponent(document));
    } catch {
      return JSON.parse(document);
    }
  }
  return document;
};

const captureLiveRole = () => {
  const role = awsJson(['iam', 'get-role', '--role-name', ROLE_NAME]);
  const inlineNames = awsJson(['iam', 'list-role-policies', '--role-name', ROLE_NAME]);
  const attached = awsJson(['iam', 'list-attached-role-policies', '--role-name', ROLE_NAME]);
  const tags = awsJson(['iam', 'list-role-tags', '--role-name', ROLE_NAME]);
  const inlinePolicies = {};
  for (const name of inlineNames.PolicyNames || []) {
    const row = awsJson([
      'iam', 'get-role-policy',
      '--role-name', ROLE_NAME,
      '--policy-name', name,
    ]);
    inlinePolicies[name] = decodePolicy(row.PolicyDocument);
  }
  const identity = awsJson(['sts', 'get-caller-identity']);
  return {
    capturedAt: new Date().toISOString(),
    caller: identity,
    roleName: ROLE_NAME,
    roleArn: role.Role?.Arn || null,
    roleId: role.Role?.RoleId || null,
    path: role.Role?.Path || null,
    createDate: role.Role?.CreateDate || null,
    description: role.Role?.Description || null,
    maxSessionDuration: role.Role?.MaxSessionDuration || null,
    permissionsBoundary: role.Role?.PermissionsBoundary || null,
    roleLastUsed: role.Role?.RoleLastUsed || null,
    trustPolicy: decodePolicy(role.Role?.AssumeRolePolicyDocument),
    attachedManagedPolicies: attached.AttachedPolicies || [],
    inlinePolicyNames: inlineNames.PolicyNames || [],
    inlinePolicies,
    productionApiLeastPrivilege: inlinePolicies[POLICY_NAME] || null,
    tags: tags.Tags || [],
    cloudFormation: {
      stackName: 'checksops-production-api-role',
      note: 'Do not update this stack from the drifted repository template.',
    },
  };
};

const relevantPermissions = (snapshot) => {
  const text = JSON.stringify(snapshot.inlinePolicies || {});
  return {
    rdsOrSecrets: /secretsmanager:GetSecretValue|rds-db-credentials|checksops-production/.test(text),
    s3: /s3:GetObject|s3:PutObject|s3:ListBucket/.test(text),
    ses: /ses:SendEmail|ses:SendRawEmail|ses:/.test(text),
    cognito: /cognito-idp:/.test(text),
    productionPool: text.includes(PRODUCTION_POOL_ARN),
    stagingPool: text.includes('us-east-1_vPmQ7cL1F'),
  };
};

const verifyTrustUnchanged = (before, after) => (
  JSON.stringify(before.trustPolicy) === JSON.stringify(after.trustPolicy)
);

const runCapture = (label) => {
  const snapshot = captureLiveRole();
  snapshot.relevant = relevantPermissions(snapshot);
  snapshot.inviteVerify = snapshot.productionApiLeastPrivilege
    ? verifyInviteCognitoPolicy(snapshot.productionApiLeastPrivilege)
    : { ok: false, error: `missing inline policy ${POLICY_NAME}` };
  const file = path.join(OUT_DIR, `${label}.json`);
  writeJson(file, snapshot);
  return { snapshot, file };
};

const runApply = () => {
  if (CONFIRM !== 'APPLY_PRODUCTION_INVITE_COGNITO_IAM') {
    throw new Error('apply refused: set CONFIRM=APPLY_PRODUCTION_INVITE_COGNITO_IAM');
  }
  const before = runCapture('pre-change');
  const live = before.snapshot.productionApiLeastPrivilege;
  if (!live) {
    throw new Error(`live role is missing inline policy ${POLICY_NAME}; refusing to create a replacement from the repository template`);
  }
  const merged = mergeInviteCognitoStatement(live);
  if (!merged.changed) {
    return {
      ok: true,
      applied: false,
      reason: merged.reason,
      preChange: before.file,
      postChange: before.file,
    };
  }
  const preserved = verifyNonCognitoPreserved(live, merged.document);
  if (!preserved) {
    throw new Error('merge would alter non-Cognito statements');
  }
  const check = verifyInviteCognitoPolicy(merged.document);
  if (!check.ok) {
    throw new Error(`merged document failed invite verification: ${JSON.stringify(check)}`);
  }
  writeJson(path.join(OUT_DIR, 'merged-policy.json'), merged.document);
  awsJson([
    'iam', 'put-role-policy',
    '--role-name', ROLE_NAME,
    '--policy-name', POLICY_NAME,
    '--policy-document', JSON.stringify(merged.document),
  ]);
  const after = runCapture('post-change');
  if (!verifyTrustUnchanged(before.snapshot, after.snapshot)) {
    throw new Error('trust policy changed unexpectedly');
  }
  if (!verifyNonCognitoPreserved(live, after.snapshot.productionApiLeastPrivilege)) {
    throw new Error('live non-Cognito statements were not preserved');
  }
  const liveCheck = verifyInviteCognitoPolicy(after.snapshot.productionApiLeastPrivilege);
  if (!liveCheck.ok) {
    throw new Error(`post-change live policy failed verification: ${JSON.stringify(liveCheck)}`);
  }
  return {
    ok: true,
    applied: true,
    reason: merged.reason,
    requiredActions: REQUIRED_ACTIONS,
    resource: PRODUCTION_POOL_ARN,
    preChange: before.file,
    postChange: after.file,
    inviteVerify: liveCheck,
    trustUnchanged: true,
    nonCognitoPreserved: true,
  };
};

const runVerify = () => {
  const after = runCapture('verify');
  return {
    ok: Boolean(after.snapshot.inviteVerify?.ok),
    file: after.file,
    roleArn: after.snapshot.roleArn,
    trustPolicy: after.snapshot.trustPolicy,
    attachedManagedPolicies: after.snapshot.attachedManagedPolicies,
    inlinePolicyNames: after.snapshot.inlinePolicyNames,
    relevant: after.snapshot.relevant,
    inviteVerify: after.snapshot.inviteVerify,
  };
};

const extractTemplateResources = () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'aws/production/api-execution-role.yaml'), 'utf8');
  const secret = yaml.match(/rds-db-credentials\/[^\s]+/)?.[0] || null;
  const bucket = yaml.match(/checksops-[A-Za-z0-9-]*privatefiles[A-Za-z0-9-]*/)?.[0] || null;
  const pool = yaml.includes(PRODUCTION_POOL_ARN);
  const stagingSecret = /checksops-staging\/checksops/.test(yaml);
  const stagingBucket = /checksops-staging-privatefiles/.test(yaml);
  return {
    secret,
    bucket,
    hasProductionPool: pool,
    stillReferencesStagingSecret: stagingSecret,
    stillReferencesStagingBucket: stagingBucket,
    hasRequiredActions: REQUIRED_ACTIONS.every((action) => yaml.includes(action)),
    hasWildcard: /cognito-idp:\*/.test(yaml),
  };
};

const runDiffTemplate = () => {
  const snapshotFile = process.env.SNAPSHOT_FILE || path.join(OUT_DIR, 'pre-change.json');
  const snapshot = fs.existsSync(snapshotFile)
    ? JSON.parse(fs.readFileSync(snapshotFile, 'utf8'))
    : runCapture('diff-live').snapshot;
  const live = snapshot.productionApiLeastPrivilege;
  const template = extractTemplateResources();
  const liveText = JSON.stringify(live || {});
  const liveHasStagingSecret = /checksops-staging\/checksops/.test(liveText);
  const liveHasStagingBucket = /checksops-staging-privatefiles/.test(liveText);
  const liveHasProductionSecret = /checksops-production\/checksops/.test(liveText);
  const liveHasProductionBucket = /checksops-production-privatefiles/.test(liveText);
  const liveStatements = live?.Statement || [];
  const cfnWouldDropUnknown = liveStatements.some((statement) => (
    statement.Sid !== 'AppDatabaseSecretRead'
    && statement.Sid !== 'PrivateCheckImageBucket'
    && statement.Sid !== 'TenantInviteUserProductionCognito'
  ));
  return {
    ok: !template.stillReferencesStagingSecret
      && !template.stillReferencesStagingBucket
      && template.hasProductionPool
      && template.hasRequiredActions
      && !template.hasWildcard
      && !cfnWouldDropUnknown,
    warning: cfnWouldDropUnknown
      ? 'CloudFormation update of the current template would drop live statements that the template does not enumerate. Do not deploy.'
      : null,
    template,
    live: {
      hasStagingSecret: liveHasStagingSecret,
      hasStagingBucket: liveHasStagingBucket,
      hasProductionSecret: liveHasProductionSecret,
      hasProductionBucket: liveHasProductionBucket,
      statementSids: liveStatements.map((statement) => statement.Sid || null),
      statementCount: liveStatements.length,
    },
    cfnWouldDropUnknown,
  };
};

try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let result;
  if (MODE === 'capture') {
    const captured = runCapture('pre-change');
    result = { ok: true, file: captured.file, roleArn: captured.snapshot.roleArn, relevant: captured.snapshot.relevant, inviteVerify: captured.snapshot.inviteVerify };
  }
  else if (MODE === 'apply') result = runApply();
  else if (MODE === 'verify') result = runVerify();
  else if (MODE === 'diff-template') result = runDiffTemplate();
  else throw new Error(`unknown mode ${MODE}`);
  const outFile = path.join(OUT_DIR, `${MODE}-result.json`);
  writeJson(outFile, result);
  console.log(JSON.stringify({ ...result, outFile }, null, 2));
  if (result.ok === false) process.exit(2);
} catch (error) {
  const failed = {
    ok: false,
    mode: MODE,
    role: ROLE_NAME,
    error: String(error.message || error),
    hint: /not authorized to perform: iam:/.test(String(error.message || ''))
      ? 'This identity cannot read or mutate the production execution role. Re-run as the authorized production IAM operator. Do not CloudFormation-update checksops-production-api-role from the repository template.'
      : null,
  };
  writeJson(path.join(OUT_DIR, `${MODE}-result.json`), failed);
  console.error(JSON.stringify(failed, null, 2));
  process.exit(1);
}
