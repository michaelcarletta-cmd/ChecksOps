/**
 * Temporary in-VPC oneshot: inspect then apply SQL 39 and 40 on staging RDS.
 * Does not GRANT intake claim_id, payments, or wallets.
 * Deletes the Lambda after invoke. Never targets production.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const ACCOUNT = '806168576068';
const LAMBDA_NAME = 'checksops-staging-integration-grants-3bce';
const ROLE_NAME = process.env.GRANT_ROLE_NAME || 'checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/write-path/oneshot');

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const packOneshot = async () => {
  const staging = path.join(os.tmpdir(), 'checksops-integration-grant-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, 'sql'), { recursive: true });
  for (const file of ['index.mjs', 'package.json']) {
    await copyFile(path.join(ONESHOT_DIR, file), path.join(staging, file));
  }
  for (const sql of ['39_detected_claim_number_grant.sql', '40_claim_settlements_grant.sql']) {
    await copyFile(path.join(ROOT, 'aws/write-path/sql', sql), path.join(staging, 'sql', sql));
  }
  const pem = path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem');
  if (fs.existsSync(pem)) await copyFile(pem, path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-integration-grant.zip');
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
    awsJson([
      'iam', 'attach-role-policy',
      '--role-name', ROLE_NAME,
      '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
    ]);
  } catch { /* already attached or denied */ }
  awsJson([
    'iam', 'put-role-policy',
    '--role-name', ROLE_NAME,
    '--policy-name', 'oneshot-integration-grants-least-privilege',
    '--policy-document', JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue'],
        Resource: [adminSecretArn],
      }],
    }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
    },
  };
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;
  try { awsJson(['lambda', 'delete-function', '--function-name', LAMBDA_NAME]); } catch { /* none */ }
  awsJson([
    'lambda', 'create-function',
    '--function-name', LAMBDA_NAME,
    '--runtime', 'nodejs20.x',
    '--role', roleArn,
    '--handler', 'index.handler',
    '--timeout', '60',
    '--memory-size', '512',
    '--zip-file', `fileb://${zipPath}`,
    '--environment', JSON.stringify(env),
    '--vpc-config', vpcConfig,
  ]);
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
};

const invokeLambda = (payload) => {
  const outFile = path.join(os.tmpdir(), `integration-grant-${payload.step}-${Date.now()}.json`);
  const payloadFile = path.join(os.tmpdir(), `integration-grant-payload-${payload.step}-${Date.now()}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  run(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', LAMBDA_NAME,
    '--payload', `file://${payloadFile}`,
    outFile,
  ]);
  const raw = fs.readFileSync(outFile, 'utf8');
  try { return JSON.parse(raw); } catch { return { parseError: raw.slice(0, 800) }; }
};

const main = async () => {
  const secrets = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secrets.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  const zip = await packOneshot();
  const report = { productionUntouched: true, database: 'checksops', function: LAMBDA_NAME };
  try {
    await ensureLambda(zip, adminSecret.ARN);
    report.pre = invokeLambda({ step: 'inspect-integration-grants' });
    const need39 = report.pre?.detectedClaimNumberGranted !== true;
    const need40 = report.pre?.settlementInsertGranted !== true || report.pre?.settlementUpdateGranted !== true;
    report.need39 = need39;
    report.need40 = need40;
    if (need39) report.sql39 = invokeLambda({ step: 'grant-detected-claim-number' });
    else report.sql39 = { applied: false, reason: 'already_granted' };
    if (need40) report.sql40 = invokeLambda({ step: 'grant-claim-settlements' });
    else report.sql40 = { applied: false, reason: 'already_granted' };
    report.post = invokeLambda({ step: 'inspect-integration-grants' });
  } finally {
    try { awsJson(['lambda', 'delete-function', '--function-name', LAMBDA_NAME]); } catch { /* keep going */ }
    report.functionDeleted = true;
  }
  const post = report.post || {};
  report.ok = post.ok === true
    && post.detectedClaimNumberGranted === true
    && post.intakeClaimIdStillDenied === true
    && post.settlementInsertGranted === true
    && post.settlementUpdateGranted === true
    && post.paymentWritesStillDenied === true
    && post.walletWritesStillDenied === true;
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(2);
};

await main();
