#!/usr/bin/env node
/**
 * READ-ONLY INV1 freeze. Does not change Lambda, SPA, SQL, flags, or money.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv1';
const STAGING_API = 'checksops-staging-api';
const PROD_API = 'checksops-production-prep-api';
const PROD_BUCKET = 'checksops-production-frontend-806168576068';
const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
const LAST_W2_SHA = 'Z5PR5OcmZSyiSPQxn6yYbuCd3jZK5F/NDrQnyF9A3U8=';
const LAST_W2_SPA_JS = 'index-BpA9Nl3A.js';
const LAST_W2_SPA_CSS = 'index-B9Jj0BE_.css';

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
  const listed = awsTry(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'assets/']);
  const contents = listed.ok ? (listed.data.Contents || []) : [];
  const assets = contents
    .filter((row) => /\/(index-|WalletOps-|WhiteLabel|CheckOpsLogin)/.test(row.Key || ''))
    .map((row) => ({ key: row.Key, etag: row.ETag, lastModified: row.LastModified, size: row.Size }));
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
    assets,
  };
};

const flagSlice = (vars = {}) => ({
  CHECKSOPS_ENV: vars.CHECKSOPS_ENV || null,
  AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
  AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED ?? null,
  AWS_MOOV_MONTHLY_BILLING_ENABLED: vars.AWS_MOOV_MONTHLY_BILLING_ENABLED ?? null,
  AWS_MOOV_TRANSFER_POST_ENABLED: vars.AWS_MOOV_TRANSFER_POST_ENABLED ?? null,
  AWS_MOOV_ENABLED: vars.AWS_MOOV_ENABLED ?? null,
  AWS_PROVIDER_EXECUTION_ENABLED: vars.AWS_PROVIDER_EXECUTION_ENABLED ?? null,
  AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID ?? null,
  AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID ?? null,
});

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv1-freeze');
  const stagingCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const prodCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const prodVars = prodCfg.Environment?.Variables || {};
  const stagingVars = stagingCfg.Environment?.Variables || {};
  const productionSpa = await spaSnapshot(PROD_BUCKET);
  const stagingSpa = await spaSnapshot(STAGING_BUCKET);
  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    lastAcceptedW2Sha: LAST_W2_SHA,
    lastAcceptedW2Spa: { js: LAST_W2_SPA_JS, css: LAST_W2_SPA_CSS },
    staging: {
      name: STAGING_API,
      codeSha256: stagingCfg.CodeSha256,
      revisionId: stagingCfg.RevisionId,
      lastModified: stagingCfg.LastModified,
      flags: flagSlice(stagingVars),
      spa: stagingSpa,
    },
    production: {
      name: PROD_API,
      codeSha256: prodCfg.CodeSha256,
      revisionId: prodCfg.RevisionId,
      lastModified: prodCfg.LastModified,
      shaMatchesW2: prodCfg.CodeSha256 === LAST_W2_SHA,
      flags: flagSlice(prodVars),
      spa: productionSpa,
      spaMatchesW2: productionSpa.index?.js === LAST_W2_SPA_JS && productionSpa.index?.css === LAST_W2_SPA_CSS,
    },
  };
  await writeFile(`${OUT}/baseline.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.production.flags.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') process.exit(2);
  if (report.production.flags.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED === 'true') process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
