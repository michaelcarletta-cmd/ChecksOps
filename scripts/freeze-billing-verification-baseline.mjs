#!/usr/bin/env node
/**
 * Freeze CURRENT staging and CURRENT production before verification-debit overlay.
 * Read-only. Does not UpdateFunctionCode, apply SQL, change env, or send ACH.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/billing-verification-v2';
const STAGING_API = 'checksops-staging-api';
const PROD_API = 'checksops-production-prep-api';
const PROD_BUCKET = 'checksops-production-frontend-806168576068';
const EXPECTED_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const EXPECTED_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const BASE = 'cursor/moov-mortgage-ops-prod-safe-2d41';
const COMPARE = [
  'tenant-billing-engine.mjs',
  'tenant-billing-handlers.mjs',
  'tenant-billing-destination.mjs',
  'scheduled.mjs',
  'providers/webhook-apply.mjs',
  'providers/parity/moov-money.mjs',
  'providers/parity/rail-router.mjs',
];
const FLAG_KEYS = [
  'AWS_MOOV_MONTHLY_BILLING_ENABLED',
  'AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST',
  'AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED',
  'AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID',
  'AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID',
  'AWS_MOOV_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_MOOV_TRANSFER_POST_ENABLED',
  'AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'CHECKSOPS_ENV',
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
    return { ok: false, error: text.replace(/\s+/g, ' ').trim().slice(0, 600) };
  }
};
const flags = (vars = {}) => Object.fromEntries(FLAG_KEYS.map((key) => [key, vars[key] ?? null]));
const unpack = (name, dest) => {
  const loc = awsJson(['lambda', 'get-function', '--function-name', name]);
  const zip = path.join(dest, `${name}.zip`);
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zip], { stdio: 'ignore' });
  const pkg = path.join(dest, name);
  fs.mkdirSync(pkg, { recursive: true });
  execFileSync('unzip', ['-qo', zip, '-d', pkg]);
  return { loc, zip, pkg };
};
const comparePkg = (pkg) => {
  const out = {};
  for (const rel of COMPARE) {
    const live = path.join(pkg, rel);
    const workspace = path.join(ROOT, 'aws/functions/api', rel);
    let baseSha = null;
    try {
      const shown = execFileSync('git', ['show', `${BASE}:${path.posix.join('aws/functions/api', rel)}`], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
      });
      baseSha = createHash('sha256').update(shown).digest('hex');
    } catch { /* missing on base */ }
    out[rel] = {
      liveExists: fs.existsSync(live),
      liveSha256: fs.existsSync(live) ? sha256(live) : null,
      workspaceSha256: fs.existsSync(workspace) ? sha256(workspace) : null,
      baseSha256: baseSha,
      liveMatchesWorkspace: fs.existsSync(live) && fs.existsSync(workspace) && sha256(live) === sha256(workspace),
      liveMatchesBase: Boolean(baseSha && fs.existsSync(live) && sha256(live) === baseSha),
      liveHasVerification: fs.existsSync(live) && fs.readFileSync(live, 'utf8').includes('billing_verification'),
    };
  }
  return out;
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('billing-verification-freeze');
  const identity = awsJson(['sts', 'get-caller-identity']);
  const stagingCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const prodCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const tmp = path.join(os.tmpdir(), `billing-verify-freeze-${Date.now()}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const stagingPkg = unpack(STAGING_API, tmp);
  const prodPkg = unpack(PROD_API, tmp);
  fs.copyFileSync(prodPkg.zip, path.join(OUT, 'production-live-baseline.zip'));
  fs.copyFileSync(stagingPkg.zip, path.join(OUT, 'staging-live-baseline.zip'));
  const spaHead = awsTry(['s3api', 'head-object', '--bucket', PROD_BUCKET, '--key', 'index.html']);
  const spaPath = path.join(OUT, 'production-live-index.html');
  awsTry(['s3', 'cp', `s3://${PROD_BUCKET}/index.html`, spaPath], { json: false });
  const indexHtml = fs.existsSync(spaPath) ? fs.readFileSync(spaPath, 'utf8') : '';
  const eventBridge = {
    listRules: awsTry(['events', 'list-rules', '--name-prefix', 'moov-monthly']),
    describeProd: awsTry(['events', 'describe-rule', '--name', 'moov-monthly-tenant-billing-production']),
  };
  const prodFlags = flags(prodCfg.Environment?.Variables);
  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    identity,
    staging: {
      name: STAGING_API,
      codeSha256: stagingCfg.CodeSha256,
      lastModified: stagingCfg.LastModified,
      revisionId: stagingCfg.RevisionId,
      flags: flags(stagingCfg.Environment?.Variables),
      files: comparePkg(stagingPkg.pkg),
    },
    production: {
      name: PROD_API,
      codeSha256: prodCfg.CodeSha256,
      lastModified: prodCfg.LastModified,
      revisionId: prodCfg.RevisionId,
      flags: prodFlags,
      destinationMatchesExpected:
        prodFlags.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID === EXPECTED_ACCOUNT
        && prodFlags.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID === EXPECTED_METHOD,
      monthlyPostIsFalse: prodFlags.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST === 'false',
      verificationPostIsFalse: prodFlags.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED !== 'true',
      files: comparePkg(prodPkg.pkg),
      spa: {
        bucket: PROD_BUCKET,
        indexHead: spaHead.ok ? {
          etag: spaHead.data.ETag,
          lastModified: spaHead.data.LastModified,
          size: spaHead.data.ContentLength,
        } : spaHead,
        indexSha256: indexHtml ? createHash('sha256').update(indexHtml).digest('hex') : null,
        assets: [...indexHtml.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0]),
      },
    },
    eventBridge,
    spaOverlayPlanned: false,
    reasonSpaSkipped: 'Current live SPA is not replaced. Admin verify-debit UI stays on this branch; production button would be disabled while the verification gate is false.',
  };
  await writeFile(path.join(OUT, 'baseline.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.production.monthlyPostIsFalse || !report.production.destinationMatchesExpected) {
    process.exit(2);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
