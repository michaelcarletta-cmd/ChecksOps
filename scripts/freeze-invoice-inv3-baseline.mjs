#!/usr/bin/env node
/**
 * READ-ONLY INV3 freeze. Does not change Lambda, SPA, SQL, flags, or money.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv3';
const STAGING_API = 'checksops-staging-api';
const PROD_API = 'checksops-production-prep-api';
const PROD_BUCKET = 'checksops-production-frontend-806168576068';
const LAST_INV1_SHA = 'FOpRk/+/x4kr0NryVyqK8YBsqcnyoGAW4yaV1KkV6FY=';
const LAST_INV1_ONBOARD = 'bebb81c2de18aae48074b7f4cbbf4a9c07c1ac9c9e1525f73b70673799cff5e7';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const awsTry = (args) => {
  try { return { ok: true, data: awsJson(args) }; }
  catch (error) {
    return { ok: false, error: String(error.stderr || error.message || error).slice(0, 400) };
  }
};

const spaSnapshot = async (bucket) => {
  const index = awsTry(['s3api', 'head-object', '--bucket', bucket, '--key', 'index.html']);
  let indexHtml = null;
  if (index.ok) {
    try {
      indexHtml = execFileSync(AWS, ['--region', REGION, 's3', 'cp', `s3://${bucket}/index.html`, '-'], {
        encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      });
    } catch { /* ignore */ }
  }
  return {
    bucket,
    index: index.ok
      ? {
        etag: index.data.ETag || null,
        lastModified: index.data.LastModified || null,
        sha256: indexHtml ? createHash('sha256').update(indexHtml).digest('hex') : null,
        js: (indexHtml || '').match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/)?.[1] || null,
        css: (indexHtml || '').match(/\/assets\/(index-[A-Za-z0-9._-]+\.css)/)?.[1] || null,
      }
      : { error: index.error },
  };
};

const flagSlice = (vars = {}) => ({
  CHECKSOPS_ENV: vars.CHECKSOPS_ENV || null,
  AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
  AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED ?? null,
  AWS_MOOV_MONTHLY_BILLING_ENABLED: vars.AWS_MOOV_MONTHLY_BILLING_ENABLED ?? null,
  AWS_MOOV_TRANSFER_POST_ENABLED: vars.AWS_MOOV_TRANSFER_POST_ENABLED ?? null,
  AWS_MOOV_ENABLED: vars.AWS_MOOV_ENABLED ?? null,
});

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv3-freeze');
  const stagingCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const prodCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const loc = awsJson(['lambda', 'get-function', '--function-name', PROD_API]);
  const tmp = `/tmp/inv3-freeze-${Date.now()}`;
  execFileSync('mkdir', ['-p', tmp]);
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', `${tmp}/live.zip`], { stdio: 'ignore' });
  execFileSync('unzip', ['-qo', `${tmp}/live.zip`, 'providers/parity/moov-onboard.mjs', '-d', tmp]);
  const onboard = execFileSync('cat', [`${tmp}/providers/parity/moov-onboard.mjs`], { encoding: 'utf8' });
  const onboardSha = createHash('sha256').update(onboard).digest('hex');
  const start = onboard.indexOf('export const invoice = {');
  const end = onboard.indexOf('export const platformBank = {');
  const invoiceBlock = start >= 0 && end > start ? onboard.slice(start, end) : '';
  await writeFile(`${OUT}/production-invoice-handler.mjs.txt`, invoiceBlock);
  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    lastAcceptedInv1Sha: LAST_INV1_SHA,
    production: {
      name: PROD_API,
      codeSha256: prodCfg.CodeSha256,
      revisionId: prodCfg.RevisionId,
      lastModified: prodCfg.LastModified,
      driftedFromInv1: prodCfg.CodeSha256 !== LAST_INV1_SHA,
      flags: flagSlice(prodCfg.Environment?.Variables || {}),
    },
    staging: {
      name: STAGING_API,
      codeSha256: stagingCfg.CodeSha256,
      revisionId: stagingCfg.RevisionId,
      lastModified: stagingCfg.LastModified,
      flags: flagSlice(stagingCfg.Environment?.Variables || {}),
    },
    liveOnboard: {
      sha256: onboardSha,
      matchesInv1: onboardSha === LAST_INV1_ONBOARD,
      hasProviderEnv: invoiceBlock.includes('requireMoovProviderEnvironment'),
      hasPreflight: invoiceBlock.includes("action === 'preflight'"),
      stillStub: invoiceBlock.includes('unitPrice') && invoiceBlock.includes('customer: body.customer'),
      alreadyPorted: invoiceBlock.includes('customerAccountID') && invoiceBlock.includes('basePrice'),
    },
    spa: {
      production: await spaSnapshot(PROD_BUCKET),
    },
  };
  await writeFile(`${OUT}/baseline.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.liveOnboard.alreadyPorted) process.exit(5);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
