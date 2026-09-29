#!/usr/bin/env node
/**
 * Apply 43_payment_event_log_write.sql via a temporary in-VPC oneshot, then delete it.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv6';
const TARGET = process.argv[2] || 'staging';
const API = TARGET === 'production' ? 'checksops-production-prep-api' : 'checksops-staging-api';
const LAMBDA_NAME = `checksops-${TARGET}-inv6-eventlog-sql-2d41`;
const ONESHOT = path.join(ROOT, 'aws/rls/oneshot/payment-event-log-write');

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
}));
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const pack = async () => {
  const staging = path.join(os.tmpdir(), `inv6-sql-${TARGET}-${Date.now()}`);
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ONESHOT, 'index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ONESHOT, 'package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/rls/sql/43_payment_event_log_write.sql'), path.join(staging, '43_payment_event_log_write.sql'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), `inv6-sql-${TARGET}.zip`);
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return zip;
};

const invoke = (name) => {
  const outfile = path.join(os.tmpdir(), `inv6-sql-out-${Date.now()}.json`);
  execFileSync(AWS, ['--region', REGION, 'lambda', 'invoke', '--function-name', name, outfile], { encoding: 'utf8' });
  return JSON.parse(fs.readFileSync(outfile, 'utf8'));
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole(`invoice-inv6-sql-${TARGET}`);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', API]);
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  let adminSecretArn = rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN;
  if (TARGET === 'production') {
    const listed = awsJson(['secretsmanager', 'list-secrets', '--max-results', '100']);
    const productionAdmin = (listed.SecretList || []).find((secret) => (
      /checksops_admin/i.test(secret.Name || secret.ARN || '')
      && /production/i.test(secret.Name || secret.ARN || '')
    ));
    if (productionAdmin?.ARN) adminSecretArn = productionAdmin.ARN;
  }
  if (!adminSecretArn) throw new Error('ADMIN_SECRET_ARN missing');
  const vpc = api.VpcConfig || {};
  const database = api.Environment?.Variables?.DATABASE_NAME
    || (TARGET === 'production' ? 'checksops' : (rehearsal.Environment?.Variables?.DATABASE_NAME || 'checksops'));
  const rdsHost = TARGET === 'production'
    ? (api.Environment?.Variables?.RDS_HOST || 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com')
    : (rehearsal.Environment?.Variables?.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com');
  const zip = await pack();
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rdsHost,
      DATABASE_NAME: database,
    },
  };
  const vpcConfig = {
    SubnetIds: vpc.SubnetIds || [],
    SecurityGroupIds: vpc.SecurityGroupIds || [],
  };
  try { awsJson(['lambda', 'delete-function', '--function-name', LAMBDA_NAME]); } catch { /* new */ }
  awsJson([
    'lambda', 'create-function',
    '--function-name', LAMBDA_NAME,
    '--runtime', 'nodejs20.x',
    '--role', rehearsal.Role,
    '--handler', 'index.handler',
    '--timeout', '60',
    '--memory-size', '256',
    '--zip-file', `fileb://${zip}`,
    '--vpc-config', `SubnetIds=${vpcConfig.SubnetIds.join(',')},SecurityGroupIds=${vpcConfig.SecurityGroupIds.join(',')}`,
    '--environment', JSON.stringify(env),
  ]);
  waitFn(LAMBDA_NAME);
  const result = invoke(LAMBDA_NAME);
  try { awsJson(['lambda', 'delete-function', '--function-name', LAMBDA_NAME]); } catch { /* keep report */ }
  const report = {
    target: TARGET,
    database,
    rdsHost,
    lambdaDeleted: true,
    result,
  };
  await writeFile(`${OUT}/${TARGET}-sql-apply.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!result?.ok) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
