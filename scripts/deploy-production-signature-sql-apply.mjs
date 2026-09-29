#!/usr/bin/env node
/**
 * Pack, deploy, and invoke the production signature SQL apply oneshot.
 * Default is dry-run. Pass --apply to execute the three accepted SQL files.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const NAME = 'checksops-prod-signature-sql-apply-ad99';
const ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const SRC = path.join(ROOT, 'aws/storage/oneshot-prod-signature-apply');
const PACK = '/tmp/prod-signature-sql-apply';
const ZIP = '/tmp/prod-signature-sql-apply.zip';
const ADMIN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops_admin/1790081257144-R3rJpx';
const RDS_HOST = 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
const APPLY = process.argv.includes('--apply');

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

fs.rmSync(PACK, { recursive: true, force: true });
fs.mkdirSync(path.join(PACK, 'sql'), { recursive: true });
fs.copyFileSync(path.join(SRC, 'index.mjs'), path.join(PACK, 'index.mjs'));
fs.copyFileSync(path.join(ROOT, 'aws/storage/sql/02_public_signature_write_helpers.sql'), path.join(PACK, 'sql/02_public_signature_write_helpers.sql'));
fs.copyFileSync(path.join(ROOT, 'aws/workflows/sql/69_homeowner_ledger_pending_and_sign_link.sql'), path.join(PACK, 'sql/69_homeowner_ledger_pending_and_sign_link.sql'));
fs.copyFileSync(path.join(ROOT, 'aws/rls/sql/39_mortgage_agent_signature_send.sql'), path.join(PACK, 'sql/39_mortgage_agent_signature_send.sql'));
const ca = [
  path.join(ROOT, 'aws/storage/oneshot/rds-global-bundle.pem'),
  path.join(ROOT, 'aws/storage/oneshot-public-write/rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));
if (ca) fs.copyFileSync(ca, path.join(PACK, 'rds-global-bundle.pem'));
fs.cpSync(path.join(ROOT, 'aws/storage/oneshot-public-write/node_modules'), path.join(PACK, 'node_modules'), { recursive: true });
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
    '--description', 'Production signature SQL apply. Helpers only. No fixtures.',
  ]);
} else {
  awsJson(['lambda', 'update-function-code', '--function-name', NAME, '--zip-file', `fileb://${ZIP}`]);
  execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', NAME], { encoding: 'utf8' });
}
execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', NAME], { encoding: 'utf8' });

const payload = JSON.stringify({ apply: APPLY });
fs.writeFileSync('/tmp/prod-signature-sql-apply-payload.json', payload);
const invoked = awsJson([
  'lambda', 'invoke',
  '--function-name', NAME,
  '--payload', 'fileb:///tmp/prod-signature-sql-apply-payload.json',
  '--cli-binary-format', 'raw-in-base64-out',
  '/tmp/prod-signature-sql-apply-out.json',
]);
const body = JSON.parse(fs.readFileSync('/tmp/prod-signature-sql-apply-out.json', 'utf8'));
const outFile = APPLY
  ? '/opt/cursor/artifacts/prod-signature-sql-apply.json'
  : '/opt/cursor/artifacts/prod-signature-sql-dry-run.json';
fs.writeFileSync(outFile, JSON.stringify({ function: NAME, apply: APPLY, invoke: invoked, body }, null, 2));
console.log(JSON.stringify({
  function: NAME,
  apply: APPLY,
  statusCode: invoked.StatusCode,
  functionError: invoked.FunctionError || null,
  ok: body.ok === true,
  dry_run: body.dry_run === true,
  schema_missing: body.schema?.missing,
  applied: body.applied,
  missing_helpers: body.missing,
  claims_select_unchanged: body.claims_select_unchanged,
  error: body.errorMessage || body.error || null,
}, null, 2));
if (body.ok !== true) process.exit(2);
