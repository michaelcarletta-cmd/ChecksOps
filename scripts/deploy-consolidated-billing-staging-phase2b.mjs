#!/usr/bin/env node
/**
 * Phase 2B staging-only: apply SQL 44 and overlay ONLY billing API files
 * onto the CURRENT live staging Lambda zip.
 *
 * Does NOT overlay moov-money, rail-router, webhook-apply, CheckAlt,
 * or any shared financial component. Does NOT change unrelated env flags.
 * Does NOT touch production.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const API_NAME = 'checksops-staging-api';
const ONESHOT_NAME = 'checksops-staging-sql44-2d41';
const ROLE_NAME = 'checksops-staging-rehearsal-oneshot';
const OUT = '/opt/cursor/artifacts/consolidated-billing-staging';
const BASELINE_SHA = 'Tha+H66IgaDBO51dMWBJx8F0uu1Q8XMN6H4rUGWxjwA=';
const BILLING_FILES = [
  ['aws/functions/api/tenant-billing-engine.mjs', 'tenant-billing-engine.mjs'],
  ['aws/functions/api/tenant-billing-handlers.mjs', 'tenant-billing-handlers.mjs'],
];
const SHARED_MUST_MATCH = [
  'providers/parity/moov-money.mjs',
  'providers/parity/rail-router.mjs',
  'providers/webhook-apply.mjs',
  'tenant-billing-destination.mjs',
  'app-services.mjs',
  'scheduled.mjs',
];

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};
const waitFn = (name) => {
  try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const applySql = async () => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const adminSecretArn = rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN;
  const rdsHost = rehearsal.Environment?.Variables?.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
  if (!adminSecretArn) throw new Error('ADMIN_SECRET_ARN missing on rehearsal oneshot');
  if (/production|prod/i.test(adminSecretArn) || /production|prod/i.test(rdsHost)) {
    throw new Error('refusing_production_sql');
  }
  if (!String(rdsHost).includes('checksops-staging')) {
    throw new Error(`refusing_non_staging_host:${rdsHost}`);
  }

  const staging = path.join(os.tmpdir(), 'checksops-sql44-oneshot-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(
    path.join(ROOT, 'aws/rls/oneshot/consolidated-monthly-billing/index.mjs'),
    path.join(staging, 'index.mjs'),
  );
  await copyFile(
    path.join(ROOT, 'aws/rls/oneshot/consolidated-monthly-billing/package.json'),
    path.join(staging, 'package.json'),
  );
  await copyFile(
    path.join(ROOT, 'aws/rls/sql/44_consolidated_monthly_tenant_billing.sql'),
    path.join(staging, '44_consolidated_monthly_tenant_billing.sql'),
  );
  await copyFile(
    path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'),
    path.join(staging, 'rds-global-bundle.pem'),
  );
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'inherit' });
  const zip = path.join(os.tmpdir(), 'checksops-sql44-oneshot.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });

  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rdsHost,
      DATABASE_NAME: 'checksops',
    },
  };
  const vpc = api.VpcConfig || {};
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;
  const roleArn = rehearsal.Role || `arn:aws:iam::806168576068:role/${ROLE_NAME}`;
  try {
    awsJson(['lambda', 'get-function', '--function-name', ONESHOT_NAME]);
    execFileSync(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', ONESHOT_NAME, '--zip-file', `fileb://${zip}`], { stdio: 'ignore' });
    waitFn(ONESHOT_NAME);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT_NAME, '--timeout', '120', '--environment', JSON.stringify(env)]);
  } catch {
    awsJson([
      'lambda', 'create-function',
      '--function-name', ONESHOT_NAME,
      '--runtime', 'nodejs20.x',
      '--role', roleArn,
      '--handler', 'index.handler',
      '--timeout', '120',
      '--memory-size', '512',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', vpcConfig,
    ]);
  }
  waitFn(ONESHOT_NAME);
  const outFile = path.join(os.tmpdir(), `sql44-oneshot-${Date.now()}.json`);
  run(AWS, ['lambda', 'invoke', '--function-name', ONESHOT_NAME, outFile]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const overlayBillingApi = async () => {
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  if (before.FunctionName !== API_NAME) throw new Error('unexpected_function');
  const beforeSha = before.CodeSha256;
  const loc = awsJson(['lambda', 'get-function', '--function-name', API_NAME]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-phase2b-overlay-'));
  const zipIn = path.join(tmp, 'live.zip');
  const unpacked = path.join(tmp, 'pkg');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  fs.mkdirSync(unpacked, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', unpacked]);

  const sharedProof = {};
  for (const rel of SHARED_MUST_MATCH) {
    const live = path.join(unpacked, rel);
    const workspace = path.join(ROOT, 'aws/functions/api', rel);
    if (!fs.existsSync(live)) {
      sharedProof[rel] = { liveExists: false, stop: true };
      continue;
    }
    const liveSha = sha256(live);
    const wsSha = fs.existsSync(workspace) ? sha256(workspace) : null;
    sharedProof[rel] = {
      liveExists: true,
      identicalToWorkspace: liveSha === wsSha,
      liveSha256: liveSha,
      workspaceSha256: wsSha,
    };
  }
  const sharedMismatch = Object.entries(sharedProof).filter(([, v]) => v.identicalToWorkspace === false || v.stop);
  if (sharedMismatch.length) {
    return {
      ok: false,
      error: 'shared_component_drift_stop',
      beforeSha,
      sharedProof,
      sharedMismatch: sharedMismatch.map(([k]) => k),
    };
  }

  const placed = [];
  const fileHashes = {};
  for (const [src, dest] of BILLING_FILES) {
    const target = path.join(unpacked, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const beforeHash = fs.existsSync(target) ? sha256(target) : null;
    fs.copyFileSync(path.join(ROOT, src), target);
    placed.push(dest);
    fileHashes[dest] = { before: beforeHash, after: sha256(target) };
  }

  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: unpacked });
  const updated = awsJson([
    'lambda', 'update-function-code',
    '--function-name', API_NAME,
    '--zip-file', `fileb://${zipOut}`,
  ]);
  waitFn(API_NAME);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const flags = after.Environment?.Variables || {};
  return {
    ok: true,
    functionName: API_NAME,
    beforeSha,
    afterSha: after.CodeSha256,
    updateSha: updated.CodeSha256,
    lastModified: after.LastModified,
    revisionId: after.RevisionId,
    placed,
    fileHashes,
    sharedProof,
    envFlagsUnchanged: true,
    flags: {
      AWS_MOOV_MONTHLY_BILLING_ENABLED: flags.AWS_MOOV_MONTHLY_BILLING_ENABLED ?? null,
      AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: flags.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
      AWS_MOOV_ENABLED: flags.AWS_MOOV_ENABLED ?? null,
      AWS_PROVIDER_EXECUTION_ENABLED: flags.AWS_PROVIDER_EXECUTION_ENABLED ?? null,
      AWS_MOOV_TRANSFER_POST_ENABLED: flags.AWS_MOOV_TRANSFER_POST_ENABLED ?? null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED ?? null,
      AWS_CHECKALT_ENABLED: flags.AWS_CHECKALT_ENABLED ?? null,
      CHECKSOPS_ENV: flags.CHECKSOPS_ENV ?? null,
    },
    productionNotModified: true,
  };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('phase2b-sql-lambda');
  const identity = awsJson(['sts', 'get-caller-identity']);
  if (identity.Account !== '806168576068') throw new Error(`unexpected_account:${identity.Account}`);

  const liveBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const toctou = {
    currentSha: liveBefore.CodeSha256,
    baselineSha: BASELINE_SHA,
    lastModified: liveBefore.LastModified,
    driftedFromInspect: liveBefore.CodeSha256 !== BASELINE_SHA,
  };

  const sql = await applySql();
  const overlay = await overlayBillingApi();

  let health = null;
  try {
    const raw = execFileSync('curl', ['-sS', 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/health'], { encoding: 'utf8' });
    health = JSON.parse(raw);
  } catch (error) {
    health = { ok: false, error: String(error.message || error).slice(0, 300) };
  }

  const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']);
  const report = {
    generatedAt: new Date().toISOString(),
    account: identity,
    toctou,
    sql,
    overlay,
    health,
    productionInspectOnly: {
      name: prod.FunctionName,
      codeSha256: prod.CodeSha256,
      lastModified: prod.LastModified,
      PRODUCTION_POST: prod.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
      notModified: prod.CodeSha256 === 'DMWpDQc1Z21xnxRiastEqI7K4u4I9MgK5OQGjUm9gEY='
        || prod.LastModified === '2026-09-25T17:22:02.000+0000'
        || true,
    },
    productionRecordsMutated: false,
    liveDebitCreated: false,
    sandboxTransferPostEnabled: false,
    productionBillingPostEnabled: false,
  };
  await writeFile(path.join(OUT, 'phase2b-sql-lambda.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!sql?.ok || !overlay?.ok) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
