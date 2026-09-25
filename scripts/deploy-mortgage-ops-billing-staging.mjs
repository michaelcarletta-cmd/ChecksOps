#!/usr/bin/env node
/**
 * Staging-only overlay for Mortgage Ops consolidated billing.
 * Forward-ports onto the current staging Lambda. Does not SAM-deploy.
 * Does not enable sandbox/production transfer-post. Does not touch production.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_NAME = 'checksops-staging-api';
const ONESHOT_NAME = 'checksops-staging-mortgage-ops-billing-2d41';
const ROLE_NAME = 'checksops-staging-rehearsal-oneshot';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const OUT = '/opt/cursor/artifacts/mortgage-ops-billing';

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
      } catch (error) { reject(error); }
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
    '--role-session-name', 'mortgage-ops-billing-staging',
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

const waitFn = (name) => {
  try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const freezeBaseline = () => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  return {
    functionName: API_NAME,
    codeSha256: cfg.CodeSha256,
    lastModified: cfg.LastModified,
    flags: {
      AWS_MOOV_MONTHLY_BILLING_ENABLED: cfg.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_ENABLED || null,
      AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: cfg.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: cfg.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_PROVIDER_EXECUTION_ENABLED: cfg.Environment?.Variables?.AWS_PROVIDER_EXECUTION_ENABLED || null,
    },
  };
};

const overlayApi = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-mo-billing-overlay-'));
  const zipIn = path.join(tmp, 'live.zip');
  const unpacked = path.join(tmp, 'pkg');
  const loc = awsJson(['lambda', 'get-function', '--function-name', API_NAME]);
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  fs.mkdirSync(unpacked, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', unpacked]);
  const copies = [
    ['aws/functions/api/tenant-billing-engine.mjs', 'tenant-billing-engine.mjs'],
    ['aws/functions/api/tenant-billing-handlers.mjs', 'tenant-billing-handlers.mjs'],
    ['aws/functions/api/workflow-rpc.mjs', 'workflow-rpc.mjs'],
    ['aws/functions/api/write-allowlist.mjs', 'write-allowlist.mjs'],
  ];
  const placed = [];
  for (const [src, dest] of copies) {
    const target = path.join(unpacked, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, src), target);
    placed.push(dest);
  }
  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: unpacked });
  awsJson(['lambda', 'update-function-code', '--function-name', API_NAME, '--zip-file', `fileb://${zipOut}`]);
  waitFn(API_NAME);

  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const vars = { ...(before.Environment?.Variables || {}) };
  vars.AWS_MOOV_MONTHLY_BILLING_ENABLED = 'true';
  vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID = vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || SANDBOX_MERCHANT;
  delete vars.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED;
  delete vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST;
  awsJson([
    'lambda', 'update-function-configuration',
    '--function-name', API_NAME,
    '--environment', JSON.stringify({ Variables: vars }),
  ]);
  waitFn(API_NAME);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  return {
    codeSha256: after.CodeSha256,
    lastModified: after.LastModified,
    placed,
    flags: {
      AWS_MOOV_MONTHLY_BILLING_ENABLED: after.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_ENABLED || null,
      AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: after.Environment?.Variables?.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: after.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
    },
  };
};

const applySqlAndAccept = async (action = 'apply_and_accept') => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const adminSecretArn = rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN;
  const rdsHost = rehearsal.Environment?.Variables?.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
  const vpc = api.VpcConfig || {};
  const staging = path.join(os.tmpdir(), 'checksops-mortgage-ops-billing-oneshot-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/mortgage-ops-billing/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/mortgage-ops-billing/package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/rls/sql/45_mortgage_ops_tenant_billing.sql'), path.join(staging, '45_mortgage_ops_tenant_billing.sql'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-mortgage-ops-billing-oneshot.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rdsHost,
      DATABASE_NAME: 'checksops',
      MORTGAGE_OPS_BILLING_ACTION: action,
    },
  };
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;
  const roleArn = rehearsal.Role || `arn:aws:iam::806168576068:role/${ROLE_NAME}`;
  try {
    awsJson(['lambda', 'get-function', '--function-name', ONESHOT_NAME]);
    execFileSync(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', ONESHOT_NAME, '--zip-file', `fileb://${zip}`], { stdio: 'ignore' });
    waitFn(ONESHOT_NAME);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT_NAME, '--timeout', '120', '--memory-size', '1024', '--environment', JSON.stringify(env)]);
  } catch {
    awsJson([
      'lambda', 'create-function',
      '--function-name', ONESHOT_NAME,
      '--runtime', 'nodejs20.x',
      '--role', roleArn,
      '--handler', 'index.handler',
      '--timeout', '120',
      '--memory-size', '1024',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', vpcConfig,
    ]);
  }
  waitFn(ONESHOT_NAME);
  const outFile = path.join(os.tmpdir(), `mortgage-ops-billing-oneshot-${Date.now()}.json`);
  run(AWS, ['lambda', 'invoke', '--function-name', ONESHOT_NAME, outFile]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeRole();
  const baseline = freezeBaseline();
  const overlayOnly = process.argv.includes('--overlay-only');
  const acceptOnly = process.argv.includes('--accept-only');
  const sql = overlayOnly
    ? { ok: true, skipped: 'overlay_only' }
    : await applySqlAndAccept(acceptOnly ? 'accept_only' : 'apply_and_accept');
  const overlay = acceptOnly ? { skipped: 'accept_only' } : await overlayApi();
  const report = {
    generatedAt: new Date().toISOString(),
    productionRecordsMutated: false,
    liveDebitCreated: false,
    sandboxTransferPostEnabled: false,
    productionBillingPostEnabled: false,
    historicalBackfill: false,
    baseline,
    sql,
    overlay,
  };
  await writeFile(path.join(OUT, 'staging-deploy.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
