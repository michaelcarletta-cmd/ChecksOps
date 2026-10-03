#!/usr/bin/env node
/**
 * Pack and create the dedicated staging SQL 47 oneshot.
 * Never updates the shared guarded executor, staging API, rehearsal oneshot,
 * or the production sql47 Lambdas.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUNCTION_NAME, FORBIDDEN_FUNCTIONS, PINNED_SQL47_SHA256 } from './constants.mjs';

const AWS = process.env.AWS_CLI || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SQL47 = path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql');
const ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const STAGING_ADMIN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/1788286368527-Kv5tBt';
const STAGING_HOST = 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function awsJson(args) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
}

function pack() {
  const hash = sha256File(SQL47);
  if (hash !== PINNED_SQL47_SHA256) {
    throw new Error(`SQL 47 hash mismatch: ${hash}`);
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'macomp47-oneshot-'));
  fs.mkdirSync(path.join(staging, 'sql'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot/constants.mjs'), path.join(staging, 'constants.mjs'));
  fs.copyFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot/index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot/package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(SQL47, path.join(staging, 'sql/47_mortgage_agent_compensation.sql'));
  fs.copyFileSync(path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), `macomp47-oneshot-${process.pid}.zip`);
  try { fs.unlinkSync(zip); } catch { /* ok */ }
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return { zip, staging, sql47_sha256: hash };
}

function main() {
  const refuse = [
    'checksops-staging-guarded-sql-executor',
    'checksops-staging-api',
    'checksops-prod-sql47-apply-2d41',
    ...FORBIDDEN_FUNCTIONS,
  ];
  if (refuse.includes(FUNCTION_NAME)) {
    throw new Error('refusing to pack a forbidden function name');
  }
  const packed = pack();
  let exists = true;
  try {
    awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
  } catch {
    exists = false;
  }
  if (exists) {
    awsJson(['lambda', 'delete-function', '--function-name', FUNCTION_NAME]);
  }
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const vpc = api.VpcConfig || {};
  const created = awsJson([
    'lambda', 'create-function',
    '--function-name', FUNCTION_NAME,
    '--runtime', 'nodejs20.x',
    '--role', ROLE,
    '--handler', 'index.handler',
    '--timeout', '120',
    '--memory-size', '256',
    '--description', 'Dedicated staging SQL 47 Mortgage Agent compensation oneshot. Not the shared executor.',
    '--zip-file', `fileb://${packed.zip}`,
    '--vpc-config', JSON.stringify({
      SubnetIds: vpc.SubnetIds || ['subnet-0df2518070c5b9ff0', 'subnet-092e4e41821fba6c4'],
      SecurityGroupIds: vpc.SecurityGroupIds || ['sg-0bc4695a666baf49b', 'sg-0fe2698f236959353'],
    }),
    '--environment', JSON.stringify({
      Variables: {
        ADMIN_SECRET_ARN: STAGING_ADMIN,
        DATABASE_NAME: 'checksops',
        RDS_HOST: STAGING_HOST,
      },
    }),
    '--tags', 'Workstream=mortgage-agent-compensation-ad99,Purpose=sql47-staging-only',
  ]);
  const report = {
    created: true,
    replaced_existing: exists,
    function_name: FUNCTION_NAME,
    code_sha256: created.CodeSha256,
    sql47_sha256: packed.sql47_sha256,
    shared_executor_untouched: true,
    staging_api_untouched: true,
    production_untouched: true,
  };
  const out = path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot/create-receipt.json');
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
