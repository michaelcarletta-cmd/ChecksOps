#!/usr/bin/env node
/**
 * READ-ONLY freeze of live production SPA + Lambda for INV7 SPA promotion.
 * No upload. No invoice. No Lambda update.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'path';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv7-prod-spa';
const PROD_API = 'checksops-production-prep-api';
const BUCKET = 'checksops-production-frontend-806168576068';
const DIST = 'E1B0ZWWO5559U5';
const LAST_INV6 = 'pW7tqE0f6qRpDw4UeYIVP3FgbFS+3l4jchwKCqxcowI=';
const LAST_SPA_JS = 'index-Cm3QUG83.js';
const LAST_SPA_CSS = 'index-CP4SLJzh.css';

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
}));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv7-prod-spa-freeze');
  const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const vars = prod.Environment?.Variables || {};
  const dist = awsJson(['cloudfront', 'get-distribution', '--id', DIST]);
  const index = execFileSync(AWS, ['--region', REGION, 's3', 'cp', `s3://${BUCKET}/index.html`, '-'], {
    encoding: 'utf8',
  });
  const jsName = index.match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/)?.[1] || null;
  const cssName = index.match(/\/assets\/(index-[A-Za-z0-9._-]+\.css)/)?.[1] || null;
  const indexHead = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);
  await writeFile(`${OUT}/production-index.html`, index);
  let jsSha = null;
  let cssSha = null;
  if (jsName) {
    execFileSync(AWS, ['--region', REGION, 's3', 'cp', `s3://${BUCKET}/assets/${jsName}`, `${OUT}/production-${jsName}`]);
    jsSha = sha256(fs.readFileSync(`${OUT}/production-${jsName}`));
  }
  if (cssName) {
    execFileSync(AWS, ['--region', REGION, 's3', 'cp', `s3://${BUCKET}/assets/${cssName}`, `${OUT}/production-${cssName}`]);
    cssSha = sha256(fs.readFileSync(`${OUT}/production-${cssName}`));
  }
  const payments = (jsName && fs.readFileSync(`${OUT}/production-${jsName}`, 'utf8').match(/assets\/(Payments-[A-Za-z0-9._-]+\.js)/)?.[1]) || null;
  let paymentsSha = null;
  if (payments) {
    execFileSync(AWS, ['--region', REGION, 's3', 'cp', `s3://${BUCKET}/assets/${payments}`, `${OUT}/production-${payments}`]);
    paymentsSha = sha256(fs.readFileSync(`${OUT}/production-${payments}`));
  }
  const publicInv = (jsName && fs.readFileSync(`${OUT}/production-${jsName}`, 'utf8').match(/assets\/(PublicInvoicePage-[A-Za-z0-9._-]+\.js)/)?.[1]) || null;
  let publicSha = null;
  if (publicInv) {
    execFileSync(AWS, ['--region', REGION, 's3', 'cp', `s3://${BUCKET}/assets/${publicInv}`, `${OUT}/production-${publicInv}`]);
    publicSha = sha256(fs.readFileSync(`${OUT}/production-${publicInv}`));
  }
  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    invoiceCreated: false,
    bucket: BUCKET,
    cloudfront: {
      id: DIST,
      domain: dist.Distribution?.DomainName || null,
      status: dist.Distribution?.Status || null,
      aliases: dist.Distribution?.DistributionConfig?.Aliases?.Items || [],
    },
    spa: {
      indexSha256: sha256(index),
      indexEtag: indexHead.ETag || null,
      indexLastModified: indexHead.LastModified || null,
      js: jsName,
      jsSha256: jsSha,
      css: cssName,
      cssSha256: cssSha,
      payments,
      paymentsSha256: paymentsSha,
      publicInvoice: publicInv,
      publicInvoiceSha256: publicSha,
      driftedFromKnown: jsName !== LAST_SPA_JS || cssName !== LAST_SPA_CSS,
    },
    lambda: {
      name: PROD_API,
      codeSha256: prod.CodeSha256,
      revisionId: prod.RevisionId,
      lastModified: prod.LastModified,
      driftedFromInv6: prod.CodeSha256 !== LAST_INV6,
      monthlyPost: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
      verificationPost: vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
    },
  };
  await writeFile(`${OUT}/freeze.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
