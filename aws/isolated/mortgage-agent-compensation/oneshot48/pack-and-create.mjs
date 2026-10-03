#!/usr/bin/env node
/**
 * Pack and create the dedicated staging SQL 48/49 oneshot.
 * Never updates the shared guarded executor, staging API, SQL 47 oneshot,
 * or production Lambdas.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL47_SHA256,
  PINNED_SQL48_SHA256,
  PINNED_SQL49_SHA256,
} from './constants.mjs';

const AWS = process.env.AWS_CLI || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SQL47 = path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql');
const SQL48 = path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/sql/48_return_mortgage_request_to_queue.sql');
const SQL49 = path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/sql/49_adjust_mortgage_agent_compensation.sql');
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
  const hashes = {
    sql47: sha256File(SQL47),
    sql48: sha256File(SQL48),
    sql49: sha256File(SQL49),
  };
  if (hashes.sql47 !== PINNED_SQL47_SHA256) throw new Error(`SQL 47 hash mismatch: ${hashes.sql47}`);
  if (hashes.sql48 !== PINNED_SQL48_SHA256) throw new Error(`SQL 48 hash mismatch: ${hashes.sql48}`);
  if (hashes.sql49 !== PINNED_SQL49_SHA256) throw new Error(`SQL 49 hash mismatch: ${hashes.sql49}`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'macomp48-oneshot-'));
  fs.mkdirSync(path.join(staging, 'sql'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot48/constants.mjs'), path.join(staging, 'constants.mjs'));
  fs.copyFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot48/index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot48/package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(SQL47, path.join(staging, 'sql/47_mortgage_agent_compensation.sql'));
  fs.copyFileSync(SQL48, path.join(staging, 'sql/48_return_mortgage_request_to_queue.sql'));
  fs.copyFileSync(SQL49, path.join(staging, 'sql/49_adjust_mortgage_agent_compensation.sql'));
  fs.copyFileSync(path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), `macomp48-oneshot-${process.pid}.zip`);
  try { fs.unlinkSync(zip); } catch { /* ok */ }
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return { zip, staging, ...hashes };
}

function main() {
  const refuse = [
    'checksops-staging-guarded-sql-executor',
    'checksops-staging-api',
    'checksops-staging-macomp47-oneshot',
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
    '--description', 'Dedicated staging SQL 48/49 Return/Adjust oneshot. Does not reapply SQL 47.',
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
    '--tags', 'Workstream=mortgage-agent-return-adjust-ad99,Purpose=sql48-sql49-staging-only',
  ]);
  const report = {
    created: true,
    replaced_existing: exists,
    function_name: FUNCTION_NAME,
    code_sha256: created.CodeSha256,
    sql47_sha256: packed.sql47,
    sql48_sha256: packed.sql48,
    sql49_sha256: packed.sql49,
    shared_executor_untouched: true,
    staging_api_untouched: true,
    sql47_oneshot_untouched: true,
    production_untouched: true,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
