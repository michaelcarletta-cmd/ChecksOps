#!/usr/bin/env node
/**
 * Read-only AWS production security inspect for Hardening Phase 1.
 * Does not mutate resources, DNS, flags, or financial grants.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const PROD_CF = 'E1B0ZWWO5559U5';
const PREP_API = 'checksops-production-prep-api';
const STAGING_API = 'checksops-staging-api';
const PROD_POOL = 'us-east-1_h00WorYMT';
const ACM_ARN = 'arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3';
const FILES_BUCKET = 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const FRONT_BUCKET = 'checksops-production-frontend-806168576068';
const RDS_ID = 'checksops-staging';

if (process.argv.some((a) => ['--apply', '--activate', '--fix'].includes(a))) {
  console.error(JSON.stringify({ error: 'refusing_mutation_from_security_inspect' }));
  process.exit(2);
}

const run = (args) => {
  try {
    return JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }) || '{}');
  } catch (error) {
    return { _denied: true, message: String(error.message || error).slice(0, 240) };
  }
};
const flagOff = (vars, key) => String(vars?.[key] || 'false').toLowerCase() !== 'true';

const cf = run(['cloudfront', 'get-distribution', '--id', PROD_CF]);
const cfg = cf.Distribution?.DistributionConfig || {};
const webAcl = cfg.WebACLId || '';
const acm = run(['acm', 'describe-certificate', '--certificate-arn', ACM_ARN]);
const wafList = run(['wafv2', 'list-web-acls', '--scope', 'CLOUDFRONT']);
const wafReg = run(['wafv2', 'list-web-acls', '--scope', 'REGIONAL']);
const prep = run(['lambda', 'get-function-configuration', '--function-name', PREP_API]);
const staging = run(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
const prepFlags = prep.Environment?.Variables || {};
const stagingFlags = staging.Environment?.Variables || {};
const pool = run(['cognito-idp', 'describe-user-pool', '--user-pool-id', PROD_POOL]);
const client = run(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', PROD_POOL, '--client-id', '3ja9fqaq2fjkv3i6up2varcqpe']);
const rds = run(['rds', 'describe-db-instances', '--db-instance-identifier', RDS_ID]);
const db = (rds.DBInstances || [])[0] || {};
const files = run(['s3api', 'get-public-access-block', '--bucket', FILES_BUCKET]);
const front = run(['s3api', 'get-public-access-block', '--bucket', FRONT_BUCKET]);
const filesEnc = run(['s3api', 'get-bucket-encryption', '--bucket', FILES_BUCKET]);
const frontEnc = run(['s3api', 'get-bucket-encryption', '--bucket', FRONT_BUCKET]);
const filesVer = run(['s3api', 'get-bucket-versioning', '--bucket', FILES_BUCKET]);
const gd = run(['guardduty', 'list-detectors']);
const sh = run(['securityhub', 'describe-hub']);
const cfgRec = run(['configservice', 'describe-configuration-recorders']);
const flow = run(['ec2', 'describe-flow-logs']);
const sg = run(['ec2', 'describe-security-groups', '--group-ids', 'sg-placeholder']);
const secrets = run(['secretsmanager', 'list-secrets', '--max-results', '20']);
const kms = run(['kms', 'list-aliases']);
const sql64 = readFileSync(path.join(ROOT, 'aws/financial/sql/64_financial_activation_grants.sql'), 'utf8');

const instance = db.DBInstanceIdentifier ? {
  identifier: db.DBInstanceIdentifier,
  engine: db.Engine,
  engineVersion: db.EngineVersion,
  publiclyAccessible: db.PubliclyAccessible,
  storageEncrypted: db.StorageEncrypted,
  kmsKeyId: db.KmsKeyId || null,
  multiAZ: db.MultiAZ,
  backupRetention: db.BackupRetentionPeriod,
  deletionProtection: db.DeletionProtection,
  iamAuth: db.IAMDatabaseAuthenticationEnabled,
  vpc: db.DBSubnetGroup?.VpcId || null,
  endpoint: db.Endpoint?.Address ? 'present' : null,
} : { denied: Boolean(rds._denied), message: rds.message || null };

const report = {
  generatedAt: new Date().toISOString(),
  mutated: false,
  financialActivated: false,
  cloudfront: {
    id: PROD_CF,
    status: cf.Distribution?.Status || null,
    aliases: cfg.Aliases?.Items || [],
    webAclId: webAcl || null,
    wafAttached: Boolean(webAcl),
    logging: cfg.Logging?.Enabled === true,
    viewerProtocol: cfg.DefaultCacheBehavior?.ViewerProtocolPolicy || null,
    certificate: cfg.ViewerCertificate?.ACMCertificateArn || null,
    denied: Boolean(cf._denied),
  },
  waf: {
    cloudfrontAcls: wafList._denied ? { denied: true } : { count: (wafList.WebACLs || []).length },
    regionalAcls: wafReg._denied ? { denied: true } : { count: (wafReg.WebACLs || []).length },
  },
  acm: { status: acm.Certificate?.Status || null, denied: Boolean(acm._denied) },
  lambda: {
    prep: {
      vpc: Boolean(prep.VpcConfig?.VpcId),
      vpcId: prep.VpcConfig?.VpcId || null,
      role: prep.Role || null,
      timeout: prep.Timeout || null,
      flags: {
        AWS_PROVIDER_EXECUTION_ENABLED: prepFlags.AWS_PROVIDER_EXECUTION_ENABLED || null,
        AWS_MOOV_ENABLED: prepFlags.AWS_MOOV_ENABLED || null,
        AWS_CHECKALT_ENABLED: prepFlags.AWS_CHECKALT_ENABLED || null,
        AWS_FINANCIAL_PERMISSIONS_ACTIVATED: prepFlags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || null,
      },
      moovOff: flagOff(prepFlags, 'AWS_MOOV_ENABLED'),
      checkaltOff: flagOff(prepFlags, 'AWS_CHECKALT_ENABLED'),
      providerOff: flagOff(prepFlags, 'AWS_PROVIDER_EXECUTION_ENABLED'),
      financialOff: flagOff(prepFlags, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED'),
    },
    staging: {
      vpc: Boolean(staging.VpcConfig?.VpcId),
      role: staging.Role || null,
      sandbox: stagingFlags.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED || null,
      flags: {
        AWS_PROVIDER_EXECUTION_ENABLED: stagingFlags.AWS_PROVIDER_EXECUTION_ENABLED || null,
        AWS_MOOV_ENABLED: stagingFlags.AWS_MOOV_ENABLED || null,
        AWS_FINANCIAL_PERMISSIONS_ACTIVATED: stagingFlags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || null,
      },
    },
    sharedRole: Boolean(prep.Role && staging.Role && prep.Role === staging.Role),
  },
  cognito: {
    mfa: pool.UserPool?.MfaConfiguration || null,
    deletionProtection: pool.UserPool?.DeletionProtection || null,
    passwordPolicy: pool.UserPool?.Policies?.PasswordPolicy || null,
    advancedSecurity: pool.UserPool?.UserPoolTier || pool.UserPool?.UserPoolAddOns?.AdvancedSecurityMode || null,
    accountRecovery: pool.UserPool?.AccountRecoverySetting || null,
    denied: Boolean(pool._denied),
    clientPreventUserExistence: client.UserPoolClient?.PreventUserExistenceErrors || null,
    explicitAuthFlows: client.UserPoolClient?.ExplicitAuthFlows || null,
  },
  rds: instance,
  s3: {
    files: {
      publicAccessBlock: files.PublicAccessBlockConfiguration || files,
      encryption: filesEnc.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault || filesEnc,
      versioning: filesVer.Status || filesVer,
    },
    frontend: {
      publicAccessBlock: front.PublicAccessBlockConfiguration || front,
      encryption: frontEnc.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault || frontEnc,
    },
  },
  detection: {
    guardDuty: gd._denied ? { denied: true, message: gd.message } : { detectors: (gd.DetectorIds || []).length },
    securityHub: sh._denied ? { denied: true, message: sh.message } : { hubArn: sh.HubArn || null },
    config: cfgRec._denied ? { denied: true } : { recorders: (cfgRec.ConfigurationRecorders || []).length },
    vpcFlowLogs: flow._denied ? { denied: true } : { count: (flow.FlowLogs || []).length },
  },
  secrets: secrets._denied ? { denied: true } : { count: (secrets.SecretList || []).length },
  kmsAliases: kms._denied ? { denied: true } : { count: (kms.Aliases || []).length },
  financialGrantsNotApplied: /NOT_APPLIED/.test(sql64),
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/phase1-inspect.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
