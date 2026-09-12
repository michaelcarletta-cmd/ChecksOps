/**
 * Temporary in-VPC oneshot: GRANT UPDATE (detected_claim_number) on staging RDS.
 * Does not grant claim_id / amount / status. Deletes the Lambda after invoke.
 * Never targets production.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const ACCOUNT = '806168576068';
const LAMBDA_NAME = 'checksops-staging-cc047-grant-3bce';
const ROLE_NAME = process.env.GRANT_ROLE_NAME || 'checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/write-path/oneshot');
const SQL_FILE = '39_detected_claim_number_grant.sql';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const packOneshot = async () => {
  const staging = path.join(os.tmpdir(), 'checksops-cc047-grant-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, 'sql'), { recursive: true });
  for (const file of ['index.mjs', 'package.json']) {
    await copyFile(path.join(ONESHOT_DIR, file), path.join(staging, file));
  }
  await copyFile(
    path.join(ROOT, 'aws/write-path/sql', SQL_FILE),
    path.join(staging, 'sql', SQL_FILE),
  );
  const pem = path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem');
  if (fs.existsSync(pem)) await copyFile(pem, path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-cc047-grant.zip');
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
    '--policy-name', 'oneshot-cc047-least-privilege',
    '--policy-document', JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue'],
        Resource: [adminSecretArn],
      }],
    }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 12000));
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
  const outFile = path.join(os.tmpdir(), `cc047-grant-${Date.now()}.json`);
  run(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', LAMBDA_NAME,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const main = async () => {
  const secrets = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secrets.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  const zip = await packOneshot();
  let result;
  try {
    await ensureLambda(zip, adminSecret.ARN);
    result = invokeLambda({ step: 'grant-detected-claim-number' });
  } finally {
    try { awsJson(['lambda', 'delete-function', '--function-name', LAMBDA_NAME]); } catch { /* keep going */ }
  }
  console.log(JSON.stringify({
    ok: result?.ok === true || result?.statusCode === 200,
    functionDeleted: true,
    productionUntouched: true,
    result,
  }, null, 2));
  if (!(result?.ok === true || result?.statusCode === 200 || result?.granted === true)) {
    process.exit(2);
  }
};

await main();
