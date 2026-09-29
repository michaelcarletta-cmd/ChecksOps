#!/usr/bin/env node
/**
 * Pre-production inspect for monthly billing destinations.
 * Read-only AWS + Moov. Does not set production env vars or post ACH.
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
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';
const STAGING_API = 'checksops-staging-api';
const PROD_API = 'checksops-production-prep-api';
const REHEARSAL = 'checksops-staging-rehearsal-oneshot';
const STAGING_INSPECT = 'checksops-staging-moov-billing-inspect-2d41';
const PROD_INSPECT = 'checksops-prod-moov-billing-inspect-2d41';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};
const awsTry = (args) => {
  try {
    return { ok: true, data: awsJson(args) };
  } catch (error) {
    const text = String(error.stderr || error.stdout || error.message || error);
    const denied = /AccessDenied|not authorized|explicit deny/i.test(text);
    const action = (text.match(/performing the action \(([^)]+)\)/) || [])[1]
      || (text.match(/on action ([A-Za-z0-9:]+)/) || [])[1]
      || args[0] + ':' + args[1];
    return {
      ok: false,
      denied,
      action,
      error: text.slice(0, 500),
    };
  }
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
    '--role-session-name', 'moov-billing-preprod-inspect',
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
  return awsJson(['sts', 'get-caller-identity']);
};

const redactEnv = (vars = {}) => {
  const keep = [
    'CHECKSOPS_ENV',
    'AWS_MOOV_MONTHLY_BILLING_ENABLED',
    'AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID',
    'AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID',
    'AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED',
    'AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST',
    'AWS_MOOV_MONTHLY_BILLING_SIMULATE',
    'AWS_MOOV_ENABLED',
    'AWS_PROVIDER_EXECUTION_ENABLED',
    'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED',
    'PROVIDER_SECRETS_ARN',
    'ADMIN_SECRET_ARN',
    'RDS_HOST',
    'DATABASE_NAME',
    'AWS_SCHEDULED_JOB_SECRET_PRESENT',
  ];
  const out = {};
  for (const key of keep) {
    if (key === 'AWS_SCHEDULED_JOB_SECRET_PRESENT') {
      out[key] = Boolean(vars.AWS_SCHEDULED_JOB_SECRET);
      continue;
    }
    if (vars[key] !== undefined) out[key] = vars[key];
  }
  return out;
};

const waitFn = (name) => {
  try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const packInspect = async () => {
  const staging = path.join(os.tmpdir(), 'checksops-moov-billing-inspect-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/moov-billing-inspect/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/moov-billing-inspect/package.json'), path.join(staging, 'package.json'));
  const pemCandidates = [
    path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'),
    path.join(ROOT, 'aws/rls/oneshot/moov-monthly-billing/rds-global-bundle.pem'),
  ];
  const pem = pemCandidates.find((file) => fs.existsSync(file));
  if (!pem) throw new Error('rds-global-bundle.pem missing');
  await copyFile(pem, path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-moov-billing-inspect.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return zip;
};

const upsertAndInvoke = async ({ name, roleArn, env, vpc, zip, timeout = 120 }) => {
  const environment = { Variables: env };
  const vpcConfig = vpc?.SubnetIds?.length
    ? `SubnetIds=${vpc.SubnetIds.join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`
    : null;
  const existing = awsTry(['lambda', 'get-function', '--function-name', name]);
  if (existing.ok) {
    awsJson(['lambda', 'update-function-code', '--function-name', name, '--zip-file', `fileb://${zip}`]);
    waitFn(name);
    const update = ['lambda', 'update-function-configuration', '--function-name', name, '--timeout', String(timeout), '--environment', JSON.stringify(environment)];
    if (roleArn) update.push('--role', roleArn);
    awsJson(update);
  } else {
    const create = [
      'lambda', 'create-function',
      '--function-name', name,
      '--runtime', 'nodejs20.x',
      '--role', roleArn,
      '--handler', 'index.handler',
      '--timeout', String(timeout),
      '--memory-size', '512',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(environment),
    ];
    if (vpcConfig) create.push('--vpc-config', vpcConfig);
    const created = awsTry(create);
    if (!created.ok) return { ok: false, phase: 'create-function', ...created };
  }
  waitFn(name);
  const outFile = path.join(os.tmpdir(), `${name}-${Date.now()}.json`);
  const invoked = awsTry(['lambda', 'invoke', '--function-name', name, '--cli-binary-format', 'raw-in-base64-out', outFile]);
  if (!invoked.ok) return { ok: false, phase: 'invoke', ...invoked };
  return { ok: true, payload: JSON.parse(fs.readFileSync(outFile, 'utf8')) };
};

const inspectIamEventBridge = () => ({
  listRules: awsTry(['events', 'list-rules', '--name-prefix', 'moov-monthly']),
  listChecksops: awsTry(['events', 'list-rules', '--name-prefix', 'checksops']),
  listTargets: awsTry(['events', 'list-targets-by-rule', '--rule', 'moov-monthly-tenant-billing']),
});

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const identity = await assumeRole();
  const stagingApi = awsTry(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const prodApi = awsTry(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const rehearsal = awsTry(['lambda', 'get-function-configuration', '--function-name', REHEARSAL]);
  const cursorSecretTries = {};
  for (const arn of [
    stagingApi.data?.Environment?.Variables?.PROVIDER_SECRETS_ARN,
    prodApi.data?.Environment?.Variables?.PROVIDER_SECRETS_ARN,
    rehearsal.data?.Environment?.Variables?.ADMIN_SECRET_ARN,
    'checksops/staging/providers',
    'checksops/production/providers',
    'checksops/staging/master-uat-password',
  ].filter(Boolean)) {
    const got = awsTry(['secretsmanager', 'get-secret-value', '--secret-id', arn]);
    cursorSecretTries[arn] = got.ok
      ? { ok: true, note: 'readable_by_cursor_role_keys_not_logged' }
      : { ok: false, denied: got.denied, action: got.action, error: got.error };
  }

  const eventBridge = inspectIamEventBridge();

  const zip = await packInspect();
  const stagingEnv = stagingApi.data?.Environment?.Variables || {};
  const rehearsalEnv = rehearsal.data?.Environment?.Variables || {};
  const prodEnv = prodApi.data?.Environment?.Variables || {};

  const stagingRds = await upsertAndInvoke({
    name: STAGING_INSPECT,
    roleArn: rehearsal.data?.Role,
    env: {
      ADMIN_SECRET_ARN: rehearsalEnv.ADMIN_SECRET_ARN || '',
      RDS_HOST: rehearsalEnv.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
      PROVIDER_SECRETS_ARN: stagingEnv.PROVIDER_SECRETS_ARN || '',
      AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: SANDBOX_MERCHANT,
    },
    vpc: stagingApi.data?.VpcConfig,
    zip,
  });

  const stagingMoov = await upsertAndInvoke({
    name: `${STAGING_INSPECT}-moov`,
    roleArn: stagingApi.data?.Role,
    env: {
      ADMIN_SECRET_ARN: rehearsalEnv.ADMIN_SECRET_ARN || '',
      RDS_HOST: rehearsalEnv.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
      PROVIDER_SECRETS_ARN: stagingEnv.PROVIDER_SECRETS_ARN || '',
      AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: SANDBOX_MERCHANT,
    },
    vpc: stagingApi.data?.VpcConfig,
    zip,
  });

  const productionInspect = prodApi.ok
    ? await upsertAndInvoke({
      name: PROD_INSPECT,
      roleArn: prodApi.data?.Role,
      env: {
        ADMIN_SECRET_ARN: rehearsalEnv.ADMIN_SECRET_ARN || '',
        RDS_HOST: prodEnv.RDS_HOST || rehearsalEnv.RDS_HOST || '',
        DATABASE_NAME: prodEnv.DATABASE_NAME || 'checksops',
        PROVIDER_SECRETS_ARN: prodEnv.PROVIDER_SECRETS_ARN || '',
      },
      vpc: prodApi.data?.VpcConfig,
      zip,
    })
    : { ok: false, phase: 'prod-api-config', ...prodApi };

  const report = {
    generatedAt: new Date().toISOString(),
    identity,
    stagingApi: stagingApi.ok
      ? { role: stagingApi.data.Role, sha: stagingApi.data.CodeSha256, env: redactEnv(stagingEnv) }
      : stagingApi,
    productionApi: prodApi.ok
      ? { role: prodApi.data.Role, sha: prodApi.data.CodeSha256, env: redactEnv(prodEnv) }
      : prodApi,
    rehearsal: rehearsal.ok
      ? { role: rehearsal.data.Role, env: redactEnv(rehearsalEnv) }
      : rehearsal,
    cursorSecretTries,
    eventBridge,
    stagingRdsInspect: stagingRds,
    stagingMoovInspect: stagingMoov,
    productionInspect,
    mutatedMoov: false,
    productionEnvVarsSet: false,
    productionSqlApplied: false,
    liveDebitCreated: false,
  };
  await writeFile(path.join(OUT, 'inspect.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
