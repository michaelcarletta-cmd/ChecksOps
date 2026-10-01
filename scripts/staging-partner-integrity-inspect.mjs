#!/usr/bin/env node
/**
 * Staging-only read-only partner integrity inspect.
 * Does not restore, apply DDL, regenerate Partner Codes, or rewrite shared_checks.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforceSharedLambdaTarget } from './deployment-guard/require-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const LAMBDA_NAME = process.env.PARTNER_INTEGRITY_LAMBDA_NAME || 'checksops-staging-partner-integrity-3bce';
const ROLE_NAME = process.env.C1C_SHARE_ROLE_NAME || 'checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/c1c-partner-share/oneshot');
const OUT = '/opt/cursor/artifacts/partner-integrity';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};

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
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed.token || parsed.oidcToken || parsed);
      } catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const assumeRole = async () => {
  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  if (!role) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');
  const token = await oidcToken();
  const out = run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'partner-integrity-inspect',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ]);
  const creds = JSON.parse(out).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
};

const packOneshot = async () => {
  const staging = path.join(os.tmpdir(), 'checksops-partner-integrity-oneshot-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  await mkdir(path.join(staging, 'sql'), { recursive: true });
  for (const name of [
    '31_partner_safe_read.sql',
    '32_partner_share_lifecycle.sql',
    '33_partner_stage_totals.sql',
    '34_c1c_partner_visibility.sql',
  ]) {
    await copyFile(path.join(ROOT, 'aws/rls/sql', name), path.join(staging, 'sql', name));
  }
  await copyFile(
    path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem'),
    path.join(staging, 'rds-global-bundle.pem'),
  );
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-partner-integrity-oneshot.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return zip;
};

const ensureLambda = async (zipPath) => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const vpc = api.VpcConfig || {};
  const adminSecretArn = rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN;
  if (!adminSecretArn) throw new Error('ADMIN_SECRET_ARN missing on rehearsal oneshot');
  const account = rehearsal.Role?.split(':')[4] || '806168576068';
  const roleArn = rehearsal.Role || `arn:aws:iam::${account}:role/${ROLE_NAME}`;
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rehearsal.Environment?.Variables?.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
    },
  };
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;
  try {
    awsJson(['lambda', 'get-function', '--function-name', LAMBDA_NAME]);
    execFileSync(AWS, [
      '--region', REGION, 'lambda', 'update-function-code',
      '--function-name', LAMBDA_NAME, '--zip-file', `fileb://${zipPath}`,
    ], { stdio: 'ignore' });
    try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
    awsJson([
      'lambda', 'update-function-configuration',
      '--function-name', LAMBDA_NAME,
      '--timeout', '120',
      '--memory-size', '512',
      '--environment', JSON.stringify(env),
    ]);
  } catch {
    awsJson([
      'lambda', 'create-function',
      '--function-name', LAMBDA_NAME,
      '--runtime', 'nodejs20.x',
      '--role', roleArn,
      '--handler', 'index.handler',
      '--timeout', '120',
      '--memory-size', '512',
      '--zip-file', `fileb://${zipPath}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', vpcConfig,
    ]);
  }
  try { run(AWS, ['lambda', 'wait', 'function-active', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
  try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
};

const invokeLambda = (payload) => {
  const outFile = path.join(os.tmpdir(), `partner-integrity-${payload.step}-${Date.now()}.json`);
  const payloadFile = path.join(os.tmpdir(), `partner-integrity-payload-${Date.now()}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  run(AWS, [
    'lambda', 'invoke',
    '--cli-binary-format', 'raw-in-base64-out',
    '--function-name', LAMBDA_NAME,
    '--payload', `file://${payloadFile}`,
    outFile,
  ]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const main = async () => {
  enforceSharedLambdaTarget({
    script: import.meta.url,
    functionName: LAMBDA_NAME,
  });
  await mkdir(OUT, { recursive: true });
  await assumeRole();
  const zip = await packOneshot();
  await ensureLambda(zip);
  const inspected = invokeLambda({ step: 'inspect' });
  await writeFile(path.join(OUT, 'staging-partner-integrity.json'), JSON.stringify(inspected, null, 2));
  const summary = {
    ok: inspected.ok === true,
    error: inspected.error || null,
    partnership: inspected.partnership || null,
    partnerIntegrity: inspected.partnerIntegrity || null,
    freedomVisible: inspected.freedomVisible || null,
    views: inspected.views || null,
  };
  await writeFile(path.join(OUT, 'staging-partner-integrity-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (inspected.ok !== true) process.exit(1);
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 400) }));
  process.exit(1);
});
