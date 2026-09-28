#!/usr/bin/env node
/**
 * Pack and invoke the staging-only signature check-file acceptance oneshot.
 * Refuses production secrets/hosts. Does not write Lambda application code.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const NAME = 'checksops-staging-sig-check-file-ad99';
const ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const SRC = path.join(ROOT, 'aws/storage/oneshot-staging-sig-check-file');
const PACK = '/tmp/staging-sig-check-file';
const ZIP = '/tmp/staging-sig-check-file.zip';
const STAGING_HOST = 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';

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

const applyCreds = (creds) => {
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
};

const awsJson = (args) => {
  const joined = args.join(' ');
  if (/checksops-production-prep-api|checksops-production-frontend|E1B0ZWWO5559U5/.test(joined)) {
    throw new Error(`forbidden production target: ${joined}`);
  }
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const assumeCursor = async () => {
  const creds = JSON.parse(execFileSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN,
    '--role-session-name', 'sig-check-file-staging-accept',
    '--web-identity-token', String(await oidcToken()),
    '--duration-seconds', '3600',
    '--output', 'json',
  ], { encoding: 'utf8' })).Credentials;
  applyCreds(creds);
};

const resolveAdminSecret = () => {
  const listed = awsJson([
    'secretsmanager', 'list-secrets',
    '--filters', 'Key=name,Values=rds-db-credentials/checksops-staging/checksops_admin',
    '--max-results', '10',
  ]);
  const match = (listed.SecretList || []).find((row) => (
    /rds-db-credentials\/checksops-staging\/checksops_admin\//.test(row.Name || '')
    && !/production/i.test(row.ARN || '')
  ));
  if (!match) throw new Error('staging checksops_admin secret not found');
  return match.ARN;
};

const main = async () => {
  await assumeCursor();
  const adminArn = resolveAdminSecret();
  if (/production/i.test(adminArn)) throw new Error('refusing production secret');

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

  const env = `Variables={ADMIN_SECRET_ARN=${adminArn},DATABASE_NAME=checksops,RDS_HOST=${STAGING_HOST}}`;
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
      '--description', 'Staging-only signature check-file selector acceptance. No production writes.',
    ]);
  } else {
    awsJson(['lambda', 'update-function-code', '--function-name', NAME, '--zip-file', `fileb://${ZIP}`]);
    execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', NAME], { encoding: 'utf8' });
    awsJson(['lambda', 'update-function-configuration', '--function-name', NAME, '--environment', env]);
    execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', NAME], { encoding: 'utf8' });
  }

  execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', NAME], { encoding: 'utf8' });
  const invoked = awsJson([
    'lambda', 'invoke',
    '--function-name', NAME,
    '--payload', JSON.stringify({ action: process.env.SIG_CHECKFILE_ACTION || 'accept' }),
    '--cli-binary-format', 'raw-in-base64-out',
    '/tmp/staging-sig-check-file-out.json',
  ]);
  const body = JSON.parse(fs.readFileSync('/tmp/staging-sig-check-file-out.json', 'utf8'));
  const report = { function: NAME, invoke: invoked, body };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/staging-sig-check-file-accept.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    function: NAME,
    statusCode: invoked.StatusCode,
    functionError: invoked.FunctionError || null,
    ok: body.ok === true,
    proofs: body.proofs,
    fixture: body.fixture,
    request: body.request,
    selector_names: body.selector_names,
    money_drift: body.money_drift,
    error: body.errorMessage || body.error || null,
  }, null, 2));
  if (body.ok !== true || invoked.FunctionError) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
