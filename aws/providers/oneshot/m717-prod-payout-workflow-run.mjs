#!/usr/bin/env node
/**
 * M7.17: abandon the unsubmitted penny intent and dark-verify the real
 * payment workflow. Never POSTs. Never overlays production-prep-api.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const INTENT_ID = 'd4580db2-1a3a-4ff0-94ff-4f68af8bcd0f';
const OPERATION_ID = '534bfe2d-6bd9-5f78-a367-61e66e7ed33a';
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  ...opts,
});
const awsJson = (args) => {
  const out = run(AWS, ['--region', REGION, '--output', 'json', ...args]);
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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString()).token); }
      catch (error) { reject(error); }
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
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  const creds = awsJson([
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-m717-abandon',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
  ]).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
  return awsJson(['sts', 'get-caller-identity']);
};
const waitFn = (name) => {
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};
const lambdaFlags = () => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  const env = cfg.Environment?.Variables || {};
  return {
    functionName: cfg.FunctionName,
    codeSha256: cfg.CodeSha256,
    lastModified: cfg.LastModified,
    state: cfg.State,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    },
    vpc: {
      subnetIds: cfg.VpcConfig?.SubnetIds || [],
      securityGroupIds: cfg.VpcConfig?.SecurityGroupIds || [],
    },
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
    env,
  };
};
const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m717-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m717-oneshot.zip');
  fs.rmSync(zipPath, { force: true });
  run('zip', ['-qr', zipPath, '.'], { cwd: staging });
  return zipPath;
};
const ensureOneshot = (zipPath, adminArn) => {
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminArn,
      RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
    },
  };
  awsJson(['lambda', 'get-function-configuration', '--function-name', ONESHOT_FN]);
  run(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', ONESHOT_FN, '--zip-file', `fileb://${zipPath}`]);
  waitFn(ONESHOT_FN);
  awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT_FN, '--timeout', '120', '--memory-size', '512', '--environment', JSON.stringify(env)]);
  waitFn(ONESHOT_FN);
};
const invokeOneshot = (payload) => {
  const outFile = `/tmp/m717-oneshot-${payload.step}-${Date.now()}.json`;
  run(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', ONESHOT_FN,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ]);
  const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (raw.statusCode && raw.body) {
    try { return JSON.parse(raw.body); } catch { return raw; }
  }
  return raw;
};

const main = async () => {
  const identity = await assumeRole();
  const flags = lambdaFlags();
  if (flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('refused_production_post_armed');
  }
  if (flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('refused_sandbox_post_armed');
  }
  const zipPath = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zipPath, adminSecret.ARN);
  const inspectBefore = invokeOneshot({
    step: 'inspect_m716_phase_a',
    payoutOperationId: OPERATION_ID,
  });
  const abandoned = invokeOneshot({
    step: 'abandon_m716_penny_intent',
    intentId: INTENT_ID,
    payoutOperationId: OPERATION_ID,
  });
  const inspectAfter = invokeOneshot({
    step: 'inspect_m716_phase_a',
    payoutOperationId: OPERATION_ID,
  });
  const intent = abandoned.intent || (inspectAfter.fundingRows || []).find((row) => row.id === INTENT_ID) || null;
  const card = {
    ABANDONED: abandoned.ok === true,
    INTENT_ID: intent?.id || INTENT_ID,
    STATUS: intent?.status || null,
    FAILURE_REASON: intent?.failure_reason || null,
    PROVIDER_TRANSFER_ID: intent?.provider_transfer_id || null,
    NEVER_EXECUTABLE: Boolean(intent?.provider_metadata?.never_executable || abandoned.never_executable),
    LIVE_PROVIDER_POSTED: false,
    PRODUCTION_POST_FLAG: flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED,
    SANDBOX_POST_FLAG: flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED,
    API_SHA: flags.codeSha256,
    DEPLOYED_API: false,
    CALLER: identity.Arn || null,
    FREEDOM,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/m717_abandon.json', `${JSON.stringify({
    at: new Date().toISOString(),
    card,
    inspectBefore,
    abandoned,
    inspectAfter,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: abandoned.ok === true, card, abandonedError: abandoned.error || null }, null, 2));
  if (abandoned.ok !== true) process.exit(1);
  if (String(intent?.status || '').toLowerCase() !== 'canceled') process.exit(2);
  if (intent?.provider_transfer_id) process.exit(3);
};

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
