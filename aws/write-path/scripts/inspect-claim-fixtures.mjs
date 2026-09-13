/**
 * Read-only staging inspect: checks whose claim_id exists in public.claims.
 * Does not GRANT anything. Deletes the Lambda after invoke.
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
const LAMBDA_NAME = 'checksops-staging-inspect-claim-fixtures-3bce';
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
  const staging = path.join(os.tmpdir(), 'checksops-inspect-claim-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, 'sql'), { recursive: true });
  for (const file of ['index.mjs', 'package.json']) {
    await copyFile(path.join(ONESHOT_DIR, file), path.join(staging, file));
  }
  const sqlSrc = path.join(ROOT, 'aws/write-path/sql');
  for (const file of fs.readdirSync(sqlSrc).filter((name) => name.endsWith('.sql'))) {
    await copyFile(path.join(sqlSrc, file), path.join(staging, 'sql', file));
  }
  const pem = path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem');
  if (fs.existsSync(pem)) await copyFile(pem, path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-inspect-claim.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return zip;
};

const main = async () => {
  const secrets = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secrets.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  const zip = await packOneshot();
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const vpc = api.VpcConfig || {};
  const roleArn = `arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}`;
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecret.ARN,
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
    '--timeout', '120',
    '--memory-size', '512',
    '--zip-file', `fileb://${zip}`,
    '--environment', JSON.stringify(env),
    '--vpc-config', vpcConfig,
  ]);
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
  const outFile = path.join(os.tmpdir(), 'inspect-claim-fixtures.json');
  const payloadFile = path.join(os.tmpdir(), 'inspect-claim-payload.json');
  const step = process.argv[2] || 'inspect-claim-fixtures';
  fs.writeFileSync(payloadFile, JSON.stringify({ step }));
  try {
    run(AWS, ['--region', REGION, 'lambda', 'invoke', '--function-name', LAMBDA_NAME, '--payload', `file://${payloadFile}`, outFile]);
    const raw = fs.readFileSync(outFile, 'utf8');
    const parsed = JSON.parse(raw);
    const artifact = step === 'inspect-org-id-distribution'
      ? '/opt/cursor/artifacts/phase2_org_id_distribution.json'
      : '/opt/cursor/artifacts/integration_claim_row_inspect.json';
    fs.writeFileSync(artifact, JSON.stringify(parsed, null, 2));
    console.log(JSON.stringify(parsed, null, 2));
  } finally {
    try { awsJson(['lambda', 'delete-function', '--function-name', LAMBDA_NAME]); } catch { /* keep going */ }
  }
};

await main();
