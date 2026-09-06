#!/usr/bin/env node
/**
 * Read-only Batch 1 inspect: RDS protection, Lambda roles, IAM policy ARNs.
 * Does not print secret values. Refuses mutation flags.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const RDS_ID = 'checksops-staging';
const PREP = 'checksops-production-prep-api';
const STAGING = 'checksops-staging-api';
const STAGING_ROLE = 'checksops-staging-ApiFunctionRole-7E7XRyLe3nyi';
const LEFTOVER_ROLE = 'checksops-production-prep-api-role';

if (process.argv.some((a) => ['--apply', '--activate', '--fix'].includes(a))) {
  console.error(JSON.stringify({ error: 'refusing_mutation_from_batch1_inspect' }));
  process.exit(2);
}

const run = (args) => {
  try {
    return JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }) || '{}');
  } catch (error) {
    return { _denied: true, message: String(error.message || error).slice(0, 400) };
  }
};

const roleNameFromArn = (arn) => {
  if (!arn) return null;
  const parts = String(arn).split('/');
  return parts[parts.length - 1] || null;
};

const redactEnv = (vars = {}) => {
  const keys = Object.keys(vars).sort();
  const flags = {};
  for (const key of keys) {
    if (/SECRET|PASSWORD|TOKEN|KEY|ARN/i.test(key) && !/ENABLED|ACTIVATED|NAME|POOL|CLIENT|ORIGIN|RP|URL|BUCKET|ENV/i.test(key)) {
      flags[key] = vars[key] ? 'set' : 'unset';
    } else if (key.includes('ARN') || key.includes('SECRET')) {
      flags[key] = vars[key] ? 'set' : 'unset';
    } else {
      flags[key] = vars[key] ?? null;
    }
  }
  return { keys, flags };
};

const inspectRole = (name) => {
  const role = run(['iam', 'get-role', '--role-name', name]);
  const attached = run(['iam', 'list-attached-role-policies', '--role-name', name]);
  const inlineNames = run(['iam', 'list-role-policies', '--role-name', name]);
  const inline = [];
  for (const policyName of inlineNames.PolicyNames || []) {
    const doc = run(['iam', 'get-role-policy', '--role-name', name, '--policy-name', policyName]);
    const decoded = doc.PolicyDocument
      ? (typeof doc.PolicyDocument === 'string' ? JSON.parse(decodeURIComponent(doc.PolicyDocument)) : doc.PolicyDocument)
      : null;
    inline.push({
      policyName,
      denied: Boolean(doc._denied),
      statements: (decoded?.Statement || []).map((statement) => ({
        effect: statement.Effect,
        actions: statement.Action,
        resources: statement.Resource,
      })),
    });
  }
  return {
    name,
    denied: Boolean(role._denied),
    message: role.message || null,
    arn: role.Role?.Arn || null,
    attached: (attached.AttachedPolicies || []).map((p) => ({ name: p.PolicyName, arn: p.PolicyArn })),
    inline,
  };
};

const identity = run(['sts', 'get-caller-identity']);
const rds = run(['rds', 'describe-db-instances', '--db-instance-identifier', RDS_ID]);
const db = (rds.DBInstances || [])[0] || {};
const prep = run(['lambda', 'get-function-configuration', '--function-name', PREP]);
const staging = run(['lambda', 'get-function-configuration', '--function-name', STAGING]);
const prepRoleName = roleNameFromArn(prep.Role);
const stagingRoleName = roleNameFromArn(staging.Role);
const leftover = inspectRole(LEFTOVER_ROLE);
const stagingRole = inspectRole(STAGING_ROLE);
const prepRole = prepRoleName && prepRoleName !== STAGING_ROLE ? inspectRole(prepRoleName) : stagingRole;
const snapshots = run(['rds', 'describe-db-snapshots', '--db-instance-identifier', RDS_ID, '--snapshot-type', 'automated', '--max-records', '5']);

const report = {
  generatedAt: new Date().toISOString(),
  mutated: false,
  identity: identity._denied ? { denied: true, message: identity.message } : { account: identity.Account, arn: identity.Arn },
  rds: db.DBInstanceIdentifier ? {
    identifier: db.DBInstanceIdentifier,
    class: db.DBInstanceClass,
    engine: db.Engine,
    engineVersion: db.EngineVersion,
    status: db.DBInstanceStatus,
    publiclyAccessible: db.PubliclyAccessible,
    storageEncrypted: db.StorageEncrypted,
    kmsKeyId: db.KmsKeyId || null,
    multiAZ: db.MultiAZ,
    backupRetention: db.BackupRetentionPeriod,
    deletionProtection: db.DeletionProtection,
    latestRestorableTime: db.LatestRestorableTime || null,
    preferredBackupWindow: db.PreferredBackupWindow || null,
    storageType: db.StorageType,
    allocatedStorage: db.AllocatedStorage,
    vpc: db.DBSubnetGroup?.VpcId || null,
    endpointPresent: Boolean(db.Endpoint?.Address),
  } : { denied: Boolean(rds._denied), message: rds.message || null },
  automatedSnapshots: snapshots._denied
    ? { denied: true, message: snapshots.message }
    : { count: (snapshots.DBSnapshots || []).length, statuses: (snapshots.DBSnapshots || []).map((s) => s.Status) },
  lambda: {
    prep: {
      role: prep.Role || null,
      vpc: prep.VpcConfig?.VpcId || null,
      subnets: prep.VpcConfig?.SubnetIds || [],
      securityGroups: prep.VpcConfig?.SecurityGroupIds || [],
      env: redactEnv(prep.Environment?.Variables || {}),
    },
    staging: {
      role: staging.Role || null,
      vpc: staging.VpcConfig?.VpcId || null,
      env: redactEnv(staging.Environment?.Variables || {}),
    },
    sharedRole: Boolean(prep.Role && staging.Role && prep.Role === staging.Role),
  },
  iam: {
    leftover,
    stagingRole,
    prepRoleName,
    stagingRoleName,
    prepRoleInspected: prepRoleName === STAGING_ROLE ? 'same_as_staging' : prepRole,
  },
};

mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch1-inspect.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
