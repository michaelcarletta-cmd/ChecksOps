#!/usr/bin/env node
/**
 * Pack and create the dedicated staging A47/A48 inspect/exclude oneshot.
 * Never updates staging API, shared executor, SQL 47/48 oneshots, or production.
 * This script does not invoke apply.
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
  PINNED_SQL50_DOC_SHA256,
  PINNED_TEMP_TRIGGER_SHA256,
  PINNED_RESTORE_TRIGGER_SHA256,
} from './constants.mjs';

const AWS = process.env.AWS_CLI || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SQL_DIR = path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/sql');
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
  const files = {
    sql47: path.join(SQL_DIR, '47_mortgage_agent_compensation.sql'),
    sql48: path.join(SQL_DIR, '48_return_mortgage_request_to_queue.sql'),
    sql49: path.join(SQL_DIR, '49_adjust_mortgage_agent_compensation.sql'),
    doc: path.join(SQL_DIR, '50_exclude_mortgage_agent_compensation.sql'),
    temp: path.join(SQL_DIR, '50_temp_allowlist_trigger.sql'),
    restore: path.join(SQL_DIR, '50_restore_sql47_trigger.sql'),
  };
  const hashes = Object.fromEntries(Object.entries(files).map(([k, file]) => [k, sha256File(file)]));
  if (hashes.sql47 !== PINNED_SQL47_SHA256) throw new Error(`SQL 47 hash mismatch: ${hashes.sql47}`);
  if (hashes.sql48 !== PINNED_SQL48_SHA256) throw new Error(`SQL 48 hash mismatch: ${hashes.sql48}`);
  if (hashes.sql49 !== PINNED_SQL49_SHA256) throw new Error(`SQL 49 hash mismatch: ${hashes.sql49}`);
  if (hashes.doc !== PINNED_SQL50_DOC_SHA256) throw new Error(`SQL 50 doc hash mismatch: ${hashes.doc}`);
  if (hashes.temp !== PINNED_TEMP_TRIGGER_SHA256) throw new Error(`temp trigger hash mismatch: ${hashes.temp}`);
  if (hashes.restore !== PINNED_RESTORE_TRIGGER_SHA256) throw new Error(`restore trigger hash mismatch: ${hashes.restore}`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'macomp50-oneshot-'));
  fs.mkdirSync(path.join(staging, 'sql'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot50/constants.mjs'), path.join(staging, 'constants.mjs'));
  fs.copyFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot50/index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot50/package.json'), path.join(staging, 'package.json'));
  for (const name of [
    '50_exclude_mortgage_agent_compensation.sql',
    '50_temp_allowlist_trigger.sql',
    '50_restore_sql47_trigger.sql',
  ]) {
    fs.copyFileSync(path.join(SQL_DIR, name), path.join(staging, 'sql', name));
  }
  fs.copyFileSync(path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), `macomp50-oneshot-${process.pid}.zip`);
  try { fs.unlinkSync(zip); } catch { /* ok */ }
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return { zip, staging, hashes };
}

function main() {
  if (process.argv.includes('apply') || process.env.MACOMP50_APPLY === '1') {
    throw new Error('pack-and-create is inspect-setup only; apply is a later authorization');
  }
  if (FORBIDDEN_FUNCTIONS.includes(FUNCTION_NAME) || FUNCTION_NAME !== 'checksops-staging-macomp50-oneshot') {
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
    throw new Error('checksops-staging-macomp50-oneshot already exists; refusing overwrite');
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
    '--description', 'Dedicated staging A47/A48 demo-compensation inspect/exclude oneshot. Does not deploy API/SPA.',
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
    '--tags', 'Workstream=macomp-demo-cleanup-ad99,Purpose=a47-a48-inspect-exclude-staging-only',
  ]);
  const report = {
    created: true,
    replaced_existing: false,
    function_name: FUNCTION_NAME,
    code_sha256: created.CodeSha256,
    hashes: packed.hashes,
    shared_executor_untouched: true,
    staging_api_untouched: true,
    production_untouched: true,
    apply_invoked: false,
  };
  const dest = '/opt/cursor/artifacts/macomp50-pack-and-create.json';
  fs.writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
