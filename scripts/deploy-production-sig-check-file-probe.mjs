#!/usr/bin/env node
/**
 * Pack and invoke the production read-only signature check-file selector probe.
 * Does not write application Lambda code. Does not create a signature request.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const NAME = 'checksops-prod-sig-check-file-probe-ad99';
const ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const SRC = path.join(ROOT, 'aws/storage/oneshot-prod-sig-check-file-probe');
const PACK = '/tmp/prod-sig-check-file-probe';
const ZIP = '/tmp/prod-sig-check-file-probe.zip';
const ADMIN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops_admin/1790081257144-R3rJpx';
const RDS_HOST = 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock',
    path: '/v1/tokens/oidc',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).token); }
      catch (error) { reject(error); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const main = async () => {
  const token = await oidcToken();
  const creds = JSON.parse(execFileSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN,
    '--role-session-name', 'sig-check-file-prod-probe',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ], { encoding: 'utf8' })).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;

  fs.rmSync(PACK, { recursive: true, force: true });
  fs.mkdirSync(PACK, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'index.mjs'), path.join(PACK, 'index.mjs'));
  const ca = [
    path.join(ROOT, 'aws/storage/oneshot/rds-global-bundle.pem'),
    path.join(ROOT, 'aws/storage/oneshot-public-write/rds-global-bundle.pem'),
    path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem'),
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
  const env = `Variables={ADMIN_SECRET_ARN=${ADMIN_SECRET_ARN},DATABASE_NAME=checksops,RDS_HOST=${RDS_HOST}}`;
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
      '--environment', env,
      '--description', 'Read-only production signature check-file selector probe. No request create.',
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
    '/tmp/prod-sig-check-file-probe-out.json',
  ]);
  const body = JSON.parse(fs.readFileSync('/tmp/prod-sig-check-file-probe-out.json', 'utf8'));
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/prod-sig-check-file-probe.json', JSON.stringify({ function: NAME, invoke: invoked, body }, null, 2));
  console.log(JSON.stringify({
    function: NAME,
    statusCode: invoked.StatusCode,
    functionError: invoked.FunctionError || null,
    ok: body.ok === true,
    proofs: body.proofs,
    selector_names: body.selector_names,
    signature_request_count: body.signature_request_count,
    money: body.money,
    error: body.errorMessage || body.error || null,
  }, null, 2));
  if (body.ok !== true || invoked.FunctionError) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
