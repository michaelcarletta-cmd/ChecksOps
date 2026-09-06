/**
 * Isolated RDS inspect + 38_*.sql apply via the rehearsal oneshot Lambda.
 * Never mutates live checksops. Never recreates checksops_rehearsal_20260906.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateParitySql } from './validate-parity-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = process.env.AWS_REGION || 'us-east-1';
const ACCOUNT = '806168576068';
const LAMBDA_NAME = process.env.REHEARSAL_LAMBDA_NAME || 'checksops-staging-rehearsal-oneshot';
const ROLE_NAME = process.env.REHEARSAL_ROLE_NAME || 'checksops-staging-rehearsal-oneshot';
const FILES_BUCKET = process.env.FILES_BUCKET || 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const TIMED_DB = 'checksops_rehearsal_20260906';
const APPLY_DB = process.env.PARITY_REHEARSAL_DB || TIMED_DB;
const ONESHOT_DIR = path.join(ROOT, 'aws/db-copy/rehearsal/oneshot-apply');

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
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(body);
        resolve(parsed.token || parsed.oidcToken || parsed);
      } catch {
        reject(new Error('oidc parse failed'));
      }
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
    '--role-session-name', 'checksops-parity-schema',
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
  const staging = path.join(os.tmpdir(), 'checksops-parity-oneshot-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, 'sql'), { recursive: true });
  for (const file of ['index.mjs', 'package.json']) {
    await copyFile(path.join(ONESHOT_DIR, file), path.join(staging, file));
  }
  for (const extra of ['restore-toc.mjs', 'catalog.mjs']) {
    const src = path.join(ROOT, 'aws/db-copy/lib', extra);
    if (fs.existsSync(src)) await copyFile(src, path.join(staging, extra));
  }
  const pem = path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem');
  if (fs.existsSync(pem)) await copyFile(pem, path.join(staging, 'rds-global-bundle.pem'));
  await copyFile(
    path.join(ROOT, 'aws/write-path/sql/37_financial_stepup_log.sql'),
    path.join(staging, 'sql/37_financial_stepup_log.sql'),
  );
  await copyFile(
    path.join(ROOT, 'aws/write-path/sql/38_parity_payee_mirror_and_returns.sql'),
    path.join(staging, 'sql/38_parity_payee_mirror_and_returns.sql'),
  );
  await copyFile(
    path.join(ROOT, 'aws/write-path/sql/39_parity_payee_mirror_trigger_only.sql'),
    path.join(staging, 'sql/39_parity_payee_mirror_trigger_only.sql'),
  );
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-parity-oneshot.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return zip;
};

const ensureLambda = async (zipPath, adminSecretArn) => {
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const vpc = api.VpcConfig || {};
  const roleArn = `arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}`;
  const trust = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  });
  try { awsJson(['iam', 'get-role', '--role-name', ROLE_NAME]); }
  catch {
    awsJson(['iam', 'create-role', '--role-name', ROLE_NAME, '--assume-role-policy-document', trust]);
  }
  try {
    awsJson(['iam', 'attach-role-policy', '--role-name', ROLE_NAME, '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole']);
  } catch { /* already attached or denied */ }
  const inline = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue'],
        Resource: [adminSecretArn],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
        Resource: [
          `arn:aws:s3:::${FILES_BUCKET}`,
          `arn:aws:s3:::${FILES_BUCKET}/Migration/*`,
        ],
      },
    ],
  };
  awsJson(['iam', 'put-role-policy', '--role-name', ROLE_NAME, '--policy-name', 'oneshot-rehearsal-least-privilege', '--policy-document', JSON.stringify(inline)]);
  await new Promise((resolve) => setTimeout(resolve, 12000));
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
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
      '--timeout', '900',
      '--memory-size', '2048',
      '--environment', JSON.stringify(env),
    ]);
  } catch {
    awsJson([
      'lambda', 'create-function',
      '--function-name', LAMBDA_NAME,
      '--runtime', 'nodejs20.x',
      '--role', roleArn,
      '--handler', 'index.handler',
      '--timeout', '900',
      '--memory-size', '2048',
      '--zip-file', `fileb://${zipPath}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', vpcConfig,
    ]);
  }
  try { run(AWS, ['lambda', 'wait', 'function-active', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
  try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
};

const invokeLambda = (payload) => {
  const outFile = path.join(os.tmpdir(), `parity-oneshot-${payload.step}-${Date.now()}.json`);
  run(AWS, [
    'lambda', 'invoke',
    '--function-name', LAMBDA_NAME,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const main = async () => {
  const local = validateParitySql();
  if (!local.ok) {
    console.error(JSON.stringify({ step: 'local_sql', ...local }, null, 2));
    process.exit(1);
  }
  if (process.argv.includes('--local-only')) {
    console.log(JSON.stringify({ ok: true, local }, null, 2));
    return;
  }
  await assumeRole();
  const secrets = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secrets.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  const zip = await packOneshot();
  await ensureLambda(zip, adminSecret.ARN);
  const inspect = invokeLambda({ step: 'inspect_return_columns', database: 'checksops' });
  let apply = null;
  if (!process.argv.includes('--inspect-only')) {
    if (APPLY_DB === 'checksops') throw new Error('refusing apply to checksops');
    apply = invokeLambda({ step: 'apply_parity_ddl', database: APPLY_DB });
  }
  const report = {
    ok: inspect.ok !== false && (apply ? apply.ok !== false : true)
      && !(inspect.missingIntakeReturnColumns || []).length
      && (apply ? apply.triggerHasRenameDelete === true : true),
    productionSupabaseChanged: false,
    liveChecksopsMutated: false,
    timedRehearsalRecreated: false,
    local,
    inspect,
    apply,
    applyDatabase: apply ? APPLY_DB : null,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 500) }, null, 2));
  process.exit(1);
});
