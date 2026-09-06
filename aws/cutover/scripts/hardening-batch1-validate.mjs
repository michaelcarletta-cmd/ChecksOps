#!/usr/bin/env node
/**
 * Hardening Batch 1 control + regression checks. Does not activate financial
 * providers or mutate RDS/IAM. Refuses --apply/--activate.
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
const RDS_ID = 'checksops-staging';
const ROLE_NAME = 'checksops-production-api-execution';
const STAGING_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-ApiFunctionRole-7E7XRyLe3nyi';
const API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';

if (process.argv.some((a) => ['--apply', '--activate', '--fix'].includes(a))) {
  console.error(JSON.stringify({ error: 'refusing_mutation_from_batch1_validate' }));
  process.exit(2);
}

const run = (args) => {
  try {
    return JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' }) || '{}');
  } catch (error) {
    return { _denied: true, message: String(error.message || error).slice(0, 300) };
  }
};
const flagOff = (vars, key) => String(vars?.[key] || 'false').toLowerCase() !== 'true';

const publicHost = async (url) => {
  try {
    const response = await fetch(url, { redirect: 'manual' });
    return { status: response.status, server: response.headers.get('server'), cf: response.headers.get('x-amz-cf-id') };
  } catch (error) {
    return { status: 0, error: String(error.message || error).slice(0, 160) };
  }
};

const rds = ((run(['rds', 'describe-db-instances', '--db-instance-identifier', RDS_ID]).DBInstances) || [])[0] || {};
const prep = run(['lambda', 'get-function-configuration', '--function-name', PREP]);
const staging = run(['lambda', 'get-function-configuration', '--function-name', STAGING]);
const prepVars = prep.Environment?.Variables || {};
const stagingVars = staging.Environment?.Variables || {};
const role = run(['iam', 'get-role', '--role-name', ROLE_NAME]);
const sql64 = readFileSync(path.join(ROOT, 'aws/financial/sql/64_financial_activation_grants.sql'), 'utf8');
const start = Date.now() - 20 * 60 * 1000;
const logs = run([
  'logs', 'filter-log-events',
  '--log-group-name', `/aws/lambda/${PREP}`,
  '--start-time', String(start),
  '--filter-pattern', 'ERROR',
  '--limit', '20',
]);
const metric = run([
  'cloudwatch', 'get-metric-statistics',
  '--namespace', 'AWS/Lambda',
  '--metric-name', 'Errors',
  '--dimensions', `Name=FunctionName,Value=${PREP}`,
  '--start-time', new Date(start).toISOString(),
  '--end-time', new Date().toISOString(),
  '--period', '300',
  '--statistics', 'Sum',
]);
const apex = await publicHost('https://checksops.com/');
const www = await publicHost('https://www.checksops.com/');
const health = await publicHost(`${API}/health`);
const readiness = await publicHost(`${API}/ops/readiness`);

const errorSum = (metric.Datapoints || []).reduce((sum, point) => sum + Number(point.Sum || 0), 0);
const rolesSeparated = Boolean(prep.Role && staging.Role && prep.Role !== staging.Role);
const dedicatedRole = Boolean(prep.Role && prep.Role.endsWith(`/${ROLE_NAME}`));

const checks = {
  publicApex: apex.status === 200,
  publicWww: www.status === 200,
  publicHealth: health.status === 200,
  rdsPrivate: rds.PubliclyAccessible === false,
  rdsEncrypted: rds.StorageEncrypted === true,
  deletionProtection: rds.DeletionProtection === true,
  backupRetention35: rds.BackupRetentionPeriod === 35,
  pitrActive: Boolean(rds.LatestRestorableTime),
  rolesSeparated,
  dedicatedProdRole: dedicatedRole,
  prodLacksProviderSecretArn: !prepVars.PROVIDER_SECRETS_ARN,
  stagingKeepsSandbox: stagingVars.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED === 'true',
  stagingKeepsSharedRole: staging.Role === STAGING_ROLE,
  moovOff: flagOff(prepVars, 'AWS_MOOV_ENABLED') && flagOff(stagingVars, 'AWS_MOOV_ENABLED'),
  checkaltOff: flagOff(prepVars, 'AWS_CHECKALT_ENABLED'),
  providerOff: flagOff(prepVars, 'AWS_PROVIDER_EXECUTION_ENABLED') && flagOff(stagingVars, 'AWS_PROVIDER_EXECUTION_ENABLED'),
  financialOff: flagOff(prepVars, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED'),
  grantsNotApplied: /NOT_APPLIED/.test(sql64),
  noNewLambdaErrors: logs._denied ? null : (logs.events || []).length === 0,
};

const report = {
  generatedAt: new Date().toISOString(),
  mutated: false,
  ok: checks.publicApex && checks.publicWww && checks.publicHealth
    && checks.rdsPrivate && checks.rdsEncrypted && checks.deletionProtection
    && checks.backupRetention35 && checks.pitrActive
    && checks.rolesSeparated && checks.dedicatedProdRole
    && checks.prodLacksProviderSecretArn && checks.stagingKeepsSandbox
    && checks.moovOff && checks.checkaltOff && checks.providerOff && checks.financialOff
    && checks.grantsNotApplied,
  checks,
  public: { apex, www, health, readinessStatus: readiness.status },
  rds: {
    identifier: rds.DBInstanceIdentifier || null,
    class: rds.DBInstanceClass || null,
    publiclyAccessible: rds.PubliclyAccessible ?? null,
    storageEncrypted: rds.StorageEncrypted ?? null,
    deletionProtection: rds.DeletionProtection ?? null,
    backupRetention: rds.BackupRetentionPeriod ?? null,
    latestRestorableTime: rds.LatestRestorableTime || null,
    multiAZ: rds.MultiAZ ?? null,
  },
  lambda: {
    prepRole: prep.Role || null,
    stagingRole: staging.Role || null,
    shared: Boolean(prep.Role && staging.Role && prep.Role === staging.Role),
    prepProviderSecretsArn: Boolean(prepVars.PROVIDER_SECRETS_ARN),
    stagingSandbox: stagingVars.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED || null,
  },
  iam: {
    dedicatedRoleDenied: Boolean(role._denied),
    dedicatedRoleArn: role.Role?.Arn || null,
  },
  cloudwatch: {
    filterDenied: Boolean(logs._denied),
    errorEvents: logs._denied ? null : (logs.events || []).length,
    metricDenied: Boolean(metric._denied),
    errorSum: metric._denied ? null : errorSum,
  },
  snapshotPermission: {
    attempted: false,
    knownDenied: true,
    action: 'rds:CreateDBSnapshot',
    minimum: {
      actions: ['rds:CreateDBSnapshot', 'rds:DescribeDBSnapshots'],
      resources: [
        `arn:aws:rds:${REGION}:806168576068:db:${RDS_ID}`,
        `arn:aws:rds:${REGION}:806168576068:snapshot:checksops-*`,
      ],
      note: 'Do not broaden the agent role. Add only these snapshot actions on the production-target instance and checksops-* snapshot ARNs.',
    },
  },
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch1-validate.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
