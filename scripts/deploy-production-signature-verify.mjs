#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const NAME = 'checksops-prod-signature-verify-ad99';
const ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const SRC = path.join(ROOT, 'aws/storage/oneshot-prod-signature-verify');
const PACK = '/tmp/prod-signature-verify';
const ZIP = '/tmp/prod-signature-verify.zip';
const ADMIN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops_admin/1790081257144-R3rJpx';
const RDS_HOST = 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

fs.rmSync(PACK, { recursive: true, force: true });
fs.mkdirSync(PACK, { recursive: true });
fs.copyFileSync(path.join(SRC, 'index.mjs'), path.join(PACK, 'index.mjs'));
fs.copyFileSync(path.join(ROOT, 'aws/functions/api/write-signature.mjs'), path.join(PACK, 'write-signature.mjs'));
fs.copyFileSync(path.join(ROOT, 'aws/functions/api/storage-paths.mjs'), path.join(PACK, 'storage-paths.mjs'));
const ca = [
  path.join(ROOT, 'aws/storage/oneshot/rds-global-bundle.pem'),
  path.join(ROOT, 'aws/storage/oneshot-public-write/rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));
if (ca) fs.copyFileSync(ca, path.join(PACK, 'rds-global-bundle.pem'));
fs.cpSync(path.join(ROOT, 'aws/storage/oneshot-public-write/node_modules'), path.join(PACK, 'node_modules'), { recursive: true });
execFileSync('bash', ['-lc', `cd ${PACK} && zip -qr ${ZIP} .`], { encoding: 'utf8' });

let exists = true;
try { awsJson(['lambda', 'get-function-configuration', '--function-name', NAME]); }
catch { exists = false; }
if (!exists) {
  awsJson([
    'lambda', 'create-function',
    '--function-name', NAME,
    '--runtime', 'nodejs20.x',
    '--role', ROLE,
    '--handler', 'index.handler',
    '--timeout', '60',
    '--memory-size', '512',
    '--zip-file', `fileb://${ZIP}`,
    '--vpc-config', 'SubnetIds=subnet-0df2518070c5b9ff0,subnet-092e4e41821fba6c4,SecurityGroupIds=sg-0bc4695a666baf49b,sg-0fe2698f236959353',
    '--environment', `Variables={ADMIN_SECRET_ARN=${ADMIN_SECRET_ARN},DATABASE_NAME=checksops,RDS_HOST=${RDS_HOST}}`,
    '--description', 'Production signature verification. Probe rows only. No money movement.',
  ]);
} else {
  awsJson(['lambda', 'update-function-code', '--function-name', NAME, '--zip-file', `fileb://${ZIP}`]);
  execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', NAME], { encoding: 'utf8' });
}
execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', NAME], { encoding: 'utf8' });
const invoked = awsJson([
  'lambda', 'invoke',
  '--function-name', NAME,
  '--payload', '{}',
  '--cli-binary-format', 'raw-in-base64-out',
  '/tmp/prod-signature-verify-out.json',
]);
const body = JSON.parse(fs.readFileSync('/tmp/prod-signature-verify-out.json', 'utf8'));
fs.writeFileSync('/opt/cursor/artifacts/prod-signature-verify.json', JSON.stringify({ function: NAME, invoke: invoked, body }, null, 2));
console.log(JSON.stringify({
  function: NAME,
  statusCode: invoked.StatusCode,
  functionError: invoked.FunctionError || null,
  ok: body.ok === true,
  proofs: body.proofs,
  error: body.errorMessage || body.error || null,
  money: body.after?.money || body.before?.money,
}, null, 2));
if (body.ok !== true) process.exit(2);
