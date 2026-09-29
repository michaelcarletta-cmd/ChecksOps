#!/usr/bin/env node
/**
 * Phase 3A Step 1-6: read-only production freeze + SQL 44 safety inspect.
 * Does not UpdateFunctionCode, apply SQL, change env, or create EventBridge.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/consolidated-billing-prod-safe';
const PROD_API = 'checksops-production-prep-api';
const REHEARSAL = 'checksops-staging-rehearsal-oneshot';
const ONESHOT = 'checksops-prod-sql44-inspect-2d41';
const PROD_BUCKET = 'checksops-production-frontend-806168576068';
const PROD_CF = 'E1B0ZWWO5559U5';
const EXPECTED_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const EXPECTED_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const COMPARE = [
  'tenant-billing-engine.mjs',
  'tenant-billing-handlers.mjs',
  'tenant-billing-destination.mjs',
  'app-services.mjs',
  'scheduled.mjs',
  'providers/webhook-apply.mjs',
  'providers/parity/moov-money.mjs',
  'providers/parity/rail-router.mjs',
];

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const awsTry = (args, { json = true } = {}) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, ...(json ? ['--output', 'json'] : []), ...args], {
      encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    });
    if (!json) return { ok: true, data: { raw: String(out).trim().slice(0, 400) } };
    return { ok: true, data: out.trim() ? JSON.parse(out) : {} };
  } catch (error) {
    const text = String(error.stderr || error.stdout || error.message || error);
    return {
      ok: false,
      denied: /AccessDenied|not authorized|explicit deny/i.test(text),
      error: text.replace(/\s+/g, ' ').trim().slice(0, 500),
    };
  }
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};
const flagSlice = (vars = {}) => ({
  AWS_MOOV_MONTHLY_BILLING_ENABLED: vars.AWS_MOOV_MONTHLY_BILLING_ENABLED ?? null,
  AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
  AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID ?? null,
  AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID ?? null,
  AWS_MOOV_ENABLED: vars.AWS_MOOV_ENABLED ?? null,
  AWS_PROVIDER_EXECUTION_ENABLED: vars.AWS_PROVIDER_EXECUTION_ENABLED ?? null,
  AWS_MOOV_TRANSFER_POST_ENABLED: vars.AWS_MOOV_TRANSFER_POST_ENABLED ?? null,
  AWS_CHECKALT_ENABLED: vars.AWS_CHECKALT_ENABLED ?? null,
  AWS_CHECKALT_STATUS_RECONCILE_ENABLED: vars.AWS_CHECKALT_STATUS_RECONCILE_ENABLED ?? null,
  CHECKSOPS_ENV: vars.CHECKSOPS_ENV ?? null,
});

const invokeInspect = async () => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', REHEARSAL]);
  const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const adminSecretArn = rehearsal.Environment?.Variables?.PROD_ADMIN_SECRET_ARN;
  const rdsHost = rehearsal.Environment?.Variables?.PROD_RDS_HOST;
  if (!adminSecretArn || !rdsHost) return { ok: false, error: 'rehearsal missing PROD_ADMIN_SECRET_ARN or PROD_RDS_HOST' };
  const staging = path.join(os.tmpdir(), 'checksops-sql44-prod-inspect-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/consolidated-billing-prod-inspect/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/consolidated-billing-prod-inspect/package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'inherit' });
  const zip = path.join(os.tmpdir(), 'checksops-sql44-prod-inspect.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = { Variables: { ADMIN_SECRET_ARN: adminSecretArn, RDS_HOST: rdsHost, DATABASE_NAME: 'checksops' } };
  const vpc = prod.VpcConfig || rehearsal.VpcConfig || {};
  const existing = awsTry(['lambda', 'get-function', '--function-name', ONESHOT]);
  if (existing.ok) {
    awsJson(['lambda', 'update-function-code', '--function-name', ONESHOT, '--zip-file', `fileb://${zip}`]);
    waitFn(ONESHOT);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--timeout', '90', '--environment', JSON.stringify(env)]);
  } else {
    const created = awsTry([
      'lambda', 'create-function',
      '--function-name', ONESHOT,
      '--runtime', 'nodejs20.x',
      '--role', rehearsal.Role,
      '--handler', 'index.handler',
      '--timeout', '90',
      '--memory-size', '256',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`,
    ]);
    if (!created.ok) return { ok: false, phase: 'create-function', ...created };
  }
  waitFn(ONESHOT);
  const outFile = path.join(os.tmpdir(), `sql44-prod-inspect-${Date.now()}.json`);
  const invoked = awsTry(['lambda', 'invoke', '--function-name', ONESHOT, '--cli-binary-format', 'raw-in-base64-out', outFile]);
  if (!invoked.ok) return { ok: false, phase: 'invoke', ...invoked };
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('phase3a-prod-inspect');
  const identity = awsJson(['sts', 'get-caller-identity']);
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const loc = awsJson(['lambda', 'get-function', '--function-name', PROD_API]);
  const vars = cfg.Environment?.Variables || {};
  const flags = flagSlice(vars);
  const destOk = flags.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID === EXPECTED_ACCOUNT
    && flags.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID === EXPECTED_METHOD;
  const postFalse = flags.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST === 'false';

  const tmp = path.join(os.tmpdir(), 'phase3a-prod-live');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const zipIn = path.join(tmp, 'live.zip');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  const unpacked = path.join(tmp, 'pkg');
  fs.mkdirSync(unpacked, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', unpacked]);
  fs.copyFileSync(zipIn, path.join(OUT, 'production-live-baseline.zip'));

  const fileCompare = {};
  for (const rel of COMPARE) {
    const live = path.join(unpacked, rel);
    const workspace = path.join(ROOT, 'aws/functions/api', rel);
    fileCompare[rel] = {
      liveExists: fs.existsSync(live),
      workspaceExists: fs.existsSync(workspace),
      liveSha256: fs.existsSync(live) ? sha256(live) : null,
      workspaceSha256: fs.existsSync(workspace) ? sha256(workspace) : null,
      identical: fs.existsSync(live) && fs.existsSync(workspace) && sha256(live) === sha256(workspace),
      liveBytes: fs.existsSync(live) ? fs.statSync(live).size : 0,
      workspaceBytes: fs.existsSync(workspace) ? fs.statSync(workspace).size : 0,
      liveHasConsolidated: fs.existsSync(live) && fs.readFileSync(live, 'utf8').includes('buildConsolidatedInvoice'),
      workspaceHasConsolidated: fs.existsSync(workspace) && fs.readFileSync(workspace, 'utf8').includes('buildConsolidatedInvoice'),
    };
  }

  const spaHead = awsTry(['s3api', 'head-object', '--bucket', PROD_BUCKET, '--key', 'index.html']);
  const spaIndexPath = path.join(OUT, 'production-live-index.html');
  const spaCp = awsTry(['s3', 'cp', `s3://${PROD_BUCKET}/index.html`, spaIndexPath], { json: false });
  const indexHtml = fs.existsSync(spaIndexPath) ? fs.readFileSync(spaIndexPath, 'utf8') : '';
  const liveIndex = await fetch('https://checksops.com/').then(async (res) => ({
    status: res.status,
    url: res.url,
    sha256: createHash('sha256').update(await res.text()).digest('hex'),
    assets: null,
  })).catch((error) => ({ error: String(error.message || error).slice(0, 200) }));
  const liveHtml = await fetch('https://checksops.com/').then((res) => res.text()).catch(() => '');
  const indexAssets = [...(indexHtml || liveHtml).matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0]);
  const cf = awsTry(['cloudfront', 'get-distribution', '--id', PROD_CF]);
  const eventBridge = {
    listRules: awsTry(['events', 'list-rules', '--name-prefix', 'moov-monthly']),
    describeProd: awsTry(['events', 'describe-rule', '--name', 'moov-monthly-tenant-billing-production']),
  };
  const health = await fetch('https://checksops.com/prep/health').then(async (res) => ({
    status: res.status, body: await res.json().catch(() => null),
  })).catch((error) => ({ error: String(error.message || error).slice(0, 200) }));

  const sql = await invokeInspect();

  const report = {
    generatedAt: new Date().toISOString(),
    phase: '3a_readonly_freeze',
    mutated: false,
    identity,
    productionLambda: {
      name: PROD_API,
      codeSha256: cfg.CodeSha256,
      lastModified: cfg.LastModified,
      revisionId: cfg.RevisionId,
      runtime: cfg.Runtime,
      handler: cfg.Handler,
      memory: cfg.MemorySize,
      timeout: cfg.Timeout,
      role: cfg.Role,
      vpc: {
        subnetIds: cfg.VpcConfig?.SubnetIds || [],
        securityGroupIds: cfg.VpcConfig?.SecurityGroupIds || [],
      },
      flags,
      destinationMatchesExpected: destOk,
      productionPostIsFalse: postFalse,
    },
    fileCompare,
    productionSpa: {
      bucket: PROD_BUCKET,
      distribution: PROD_CF,
      aliases: cf.data?.Distribution?.DistributionConfig?.Aliases?.Items || [],
      indexHead: spaHead.ok ? { etag: spaHead.data.ETag, lastModified: spaHead.data.LastModified, size: spaHead.data.ContentLength } : spaHead,
      indexCopied: spaCp.ok,
      indexSha256: indexHtml ? createHash('sha256').update(indexHtml).digest('hex') : null,
      assets: indexAssets,
      liveChecksops: { ...liveIndex, assets: [...liveHtml.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0]) },
    },
    eventBridge,
    health,
    sql,
    stop: !postFalse || !destOk || sql?.uniqueIndexSafety?.safe === false,
    stopReasons: [
      !postFalse ? 'PRODUCTION_POST_not_false' : null,
      !destOk ? 'destination_mismatch' : null,
      sql?.uniqueIndexSafety?.safe === false ? 'unique_index_duplicates' : null,
    ].filter(Boolean),
  };
  await writeFile(path.join(OUT, 'phase3a-baseline.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.stop) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
