#!/usr/bin/env node
/**
 * Deploy/invoke the production UI signature fixture oneshot.
 * Default action=inspect (schema + rolled-back dry-run).
 * Pass --create only after inspect gates pass.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const NAME = 'checksops-prod-ui-sig-fixture-ad99';
const ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const SRC = path.join(ROOT, 'aws/storage/oneshot-prod-ui-sig-fixture');
const PACK = '/tmp/prod-ui-sig-fixture';
const ZIP = '/tmp/prod-ui-sig-fixture.zip';
const ADMIN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops_admin/1790081257144-R3rJpx';
const RDS_HOST = 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
const ACTION = process.argv.includes('--create') ? 'create' : 'inspect';

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
const ca = [
  path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem'),
  path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'),
  path.join(ROOT, 'aws/identity/oneshot/rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));
if (!ca) throw new Error('missing rds-global-bundle.pem');
fs.copyFileSync(ca, path.join(PACK, 'rds-global-bundle.pem'));
const modules = [
  path.join(ROOT, 'aws/storage/oneshot-public-write/node_modules'),
  path.join(ROOT, 'aws/rls/oneshot/node_modules'),
  path.join(ROOT, 'aws/identity/oneshot/node_modules'),
].find((p) => fs.existsSync(path.join(p, 'pg')));
if (!modules) throw new Error('missing oneshot node_modules with pg');
fs.cpSync(modules, path.join(PACK, 'node_modules'), { recursive: true });
execFileSync('bash', ['-lc', `cd ${PACK} && zip -qr ${ZIP} .`], { encoding: 'utf8' });

let exists = true;
try {
  awsJson(['lambda', 'get-function-configuration', '--function-name', NAME]);
} catch {
  exists = false;
}

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
    '--description', 'Production UI signature fixture inspect/create. No app SQL apply.',
  ]);
} else {
  awsJson(['lambda', 'update-function-code', '--function-name', NAME, '--zip-file', `fileb://${ZIP}`]);
  execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', NAME], { encoding: 'utf8' });
}

execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', NAME], { encoding: 'utf8' });
const payloadPath = '/tmp/prod-ui-sig-fixture-payload.json';
fs.writeFileSync(payloadPath, JSON.stringify({ action: ACTION }));
const invoked = awsJson([
  'lambda', 'invoke',
  '--function-name', NAME,
  '--payload', `file://${payloadPath}`,
  '--cli-binary-format', 'raw-in-base64-out',
  '/tmp/prod-ui-sig-fixture-out.json',
]);
const body = JSON.parse(fs.readFileSync('/tmp/prod-ui-sig-fixture-out.json', 'utf8'));
const report = { function: NAME, action: ACTION, invoke: invoked, body };
const outPath = ACTION === 'create'
  ? '/opt/cursor/artifacts/prod-ui-sig-fixture-create.json'
  : '/opt/cursor/artifacts/prod-ui-sig-fixture-inspect.json';
fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  function: NAME,
  action: ACTION,
  statusCode: invoked.StatusCode,
  functionError: invoked.FunctionError || null,
  ok: body.ok === true,
  created: body.created === true,
  stop: body.stop === true,
  reason: body.reason || null,
  authorized_email: body.authorized_email || null,
  isolation_ok: body.dry_run?.isolation_gate?.ok ?? body.isolation_gate?.ok ?? null,
  problems: body.dry_run?.isolation_gate?.problems || body.problems || null,
  error: body.errorMessage || body.error || null,
}, null, 2));
if (body.ok !== true) process.exit(2);
