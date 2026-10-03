#!/usr/bin/env node
/**
 * Pack and create the dedicated production SQL 49 oneshot.
 * Never updates the shared staging executor, production API, Moov SQL 47,
 * SQL 39 transition, SQL 47/48 oneshots, or SQL 45/46 apply Lambdas.
 * Embeds accepted SQL 49 only. Does not embed SQL 47 or SQL 48.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUNCTION_NAME, FORBIDDEN_FUNCTIONS, PINNED_SQL49_SHA256 } from './constants.mjs';

const AWS = process.env.AWS_CLI || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SQL49 = path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/sql/49_adjust_mortgage_agent_compensation.sql');
const ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const PROD_ADMIN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops_admin/1790081257144-R3rJpx';
const PROD_HOST = 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function awsJson(args) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
}

export function pack() {
  const hash = sha256File(SQL49);
  if (hash !== PINNED_SQL49_SHA256) {
    throw new Error(`SQL 49 hash mismatch: ${hash}`);
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'macomp49-prod-oneshot-'));
  fs.mkdirSync(path.join(staging, 'sql'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'lib'), { recursive: true });
  const copies = [
    ['aws/isolated/mortgage-agent-compensation/oneshot49-prod/constants.mjs', 'constants.mjs'],
    ['aws/isolated/mortgage-agent-compensation/oneshot49-prod/index.mjs', 'index.mjs'],
    ['aws/isolated/mortgage-agent-compensation/oneshot49-prod/package.json', 'package.json'],
    ['aws/isolated/mortgage-agent-compensation/oneshot49-prod/mortgage-ops-sql39.mjs', 'mortgage-ops-sql39.mjs'],
    ['aws/isolated/mortgage-agent-compensation/oneshot49-prod/lib/sql-apply.mjs', 'lib/sql-apply.mjs'],
    ['aws/isolated/mortgage-agent-compensation/oneshot49-prod/lib/sql-executor-auth.mjs', 'lib/sql-executor-auth.mjs'],
    ['aws/isolated/mortgage-agent-compensation/oneshot49-prod/lib/errors.mjs', 'lib/errors.mjs'],
    ['aws/isolated/mortgage-agent-compensation/oneshot49-prod/lib/identity.mjs', 'lib/identity.mjs'],
    ['aws/isolated/mortgage-agent-compensation/oneshot49-prod/lib/function-def-lookup.mjs', 'lib/function-def-lookup.mjs'],
    ['aws/isolated/mortgage-agent-compensation/sql/49_adjust_mortgage_agent_compensation.sql', 'sql/49_adjust_mortgage_agent_compensation.sql'],
    ['aws/functions/api/rds-global-bundle.pem', 'rds-global-bundle.pem'],
  ];
  for (const [from, to] of copies) {
    const src = path.join(ROOT, from);
    if (!fs.existsSync(src)) throw new Error(`missing pack member ${from}`);
    fs.copyFileSync(src, path.join(staging, to));
  }
  const forbiddenEmbeds = [
    'sql/47_mortgage_agent_compensation.sql',
    'sql/48_return_mortgage_request_to_queue.sql',
  ];
  for (const name of forbiddenEmbeds) {
    if (fs.existsSync(path.join(staging, name))) {
      throw new Error(`refusing to embed ${name}`);
    }
  }
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), `macomp49-prod-oneshot-${process.pid}.zip`);
  try { fs.unlinkSync(zip); } catch { /* ok */ }
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return { zip, staging, sql49_sha256: hash };
}

function main() {
  if (FORBIDDEN_FUNCTIONS.includes(FUNCTION_NAME) || FUNCTION_NAME !== 'checksops-prod-macomp49-oneshot-ad99') {
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
    throw new Error('refusing to overwrite an existing production oneshot; delete is not authorized here');
  }
  const created = awsJson([
    'lambda', 'create-function',
    '--function-name', FUNCTION_NAME,
    '--runtime', 'nodejs20.x',
    '--role', ROLE,
    '--handler', 'index.handler',
    '--timeout', '120',
    '--memory-size', '256',
    '--description', 'Dedicated production SQL 49 immutable-adjustment oneshot. Not SQL 47. Not SQL 48. Not the staging executor. Not production API.',
    '--zip-file', `fileb://${packed.zip}`,
    '--vpc-config', JSON.stringify({
      SubnetIds: ['subnet-0df2518070c5b9ff0', 'subnet-092e4e41821fba6c4'],
      SecurityGroupIds: ['sg-0bc4695a666baf49b', 'sg-0fe2698f236959353'],
    }),
    '--environment', JSON.stringify({
      Variables: {
        ADMIN_SECRET_ARN: PROD_ADMIN,
        DATABASE_NAME: 'checksops',
        RDS_HOST: PROD_HOST,
      },
    }),
    '--tags', 'Workstream=mortgage-agent-compensation-ad99,Purpose=sql49-production-only',
  ]);
  const report = {
    created: true,
    function_name: FUNCTION_NAME,
    code_sha256: created.CodeSha256,
    revision_id: created.RevisionId,
    sql49_sha256: packed.sql49_sha256,
    shared_executor_untouched: true,
    production_api_untouched: true,
    moov_sql47_untouched: true,
    sql39_transition_untouched: true,
    sql47_oneshot_untouched: true,
    sql48_oneshot_untouched: true,
  };
  const out = path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/oneshot49-prod/create-receipt.json');
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main();
