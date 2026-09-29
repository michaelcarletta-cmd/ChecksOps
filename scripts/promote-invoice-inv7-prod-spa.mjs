#!/usr/bin/env node
/**
 * INV7 production SPA promotion ONLY.
 * Uploads the candidate built from live production SPA source + INV7 branding hunks.
 * No Lambda, SQL, env, Moov, or invoice writes. No s3 sync --delete.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'path';
import { assumeCursorRole, oidcToken } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv7-prod-spa';
const DIST = process.env.INV7_SPA_DIST || '/tmp/inv7-prod-spa-dist';
const BUCKET = 'checksops-production-frontend-806168576068';
const CF = 'E1B0ZWWO5559U5';
const SPA_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const PROD_API = 'checksops-production-prep-api';
const EXPECTED = JSON.parse(fs.readFileSync(path.join(OUT, 'freeze.json'), 'utf8'));

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
}));

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const assumeSpaDeploy = async () => {
  const creds = JSON.parse(execFileSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', SPA_ROLE,
    '--role-session-name', 'invoice-inv7-prod-spa',
    '--web-identity-token', String(await oidcToken()),
    '--duration-seconds', '3600',
    '--output', 'json',
  ], { encoding: 'utf8' })).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
};

const spaNow = () => {
  const html = execFileSync(AWS, ['--region', REGION, 's3', 'cp', `s3://${BUCKET}/index.html`, '-'], { encoding: 'utf8' });
  return {
    html,
    sha256: createHash('sha256').update(html).digest('hex'),
    js: html.match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/)?.[1] || null,
    css: html.match(/\/assets\/(index-[A-Za-z0-9._-]+\.css)/)?.[1] || null,
  };
};

const putObject = (local, key, contentType, cache) => {
  execFileSync(AWS, [
    '--region', REGION, 's3api', 'put-object',
    '--bucket', BUCKET,
    '--key', key,
    '--body', local,
    '--content-type', contentType,
    '--cache-control', cache,
  ], { stdio: 'inherit' });
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('invoice-inv7-prod-spa-toctou');
  const lambda = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const before = spaNow();
  const toctou = {
    lambdaMatch: lambda.CodeSha256 === EXPECTED.lambda.codeSha256,
    spaJsMatch: before.js === EXPECTED.spa.js,
    spaCssMatch: before.css === EXPECTED.spa.css,
    spaIndexMatch: before.sha256 === EXPECTED.spa.indexSha256,
  };
  if (!toctou.lambdaMatch || !toctou.spaJsMatch || !toctou.spaCssMatch || !toctou.spaIndexMatch) {
    const report = { ok: false, reason: 'toctou_drift', toctou, before, expected: EXPECTED };
    await writeFile(`${OUT}/promote-aborted.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }

  const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const js = indexHtml.match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/)?.[1];
  const css = indexHtml.match(/\/assets\/(index-[A-Za-z0-9._-]+\.css)/)?.[1];
  const jsText = fs.readFileSync(path.join(DIST, 'assets', js), 'utf8');
  if (jsText.includes('psr19uhop4') || jsText.includes('kiqojucc02') || !jsText.includes('https://checksops.com')) {
    throw new Error('candidate_env_guard_failed');
  }

  await assumeSpaDeploy();
  const identity = awsJson(['sts', 'get-caller-identity']);
  const assetsDir = path.join(DIST, 'assets');
  const uploaded = [];
  for (const name of await readdir(assetsDir)) {
    const local = path.join(assetsDir, name);
    if (!fs.statSync(local).isFile()) continue;
    const contentType = name.endsWith('.css')
      ? 'text/css'
      : name.endsWith('.js')
        ? 'text/javascript'
        : name.endsWith('.png')
          ? 'image/png'
          : 'application/octet-stream';
    putObject(local, `assets/${name}`, contentType, 'public,max-age=31536000,immutable');
    uploaded.push(`assets/${name}`);
  }
  putObject(path.join(DIST, 'index.html'), 'index.html', 'text/html', 'no-cache,no-store,must-revalidate');
  const invalidation = awsJson(['cloudfront', 'create-invalidation', '--distribution-id', CF, '--paths', '/*']);
  const after = spaNow();
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const report = {
    ok: after.js === js && after.css === css,
    invoiceCreated: false,
    lambdaUpdated: lambdaAfter.CodeSha256 !== lambda.CodeSha256,
    role: identity.Arn,
    bucket: BUCKET,
    cloudfrontId: CF,
    invalidationId: invalidation.Invalidation?.Id || null,
    uploadedCount: uploaded.length + 1,
    before,
    after,
    candidate: {
      js,
      css,
      indexSha256: sha256(path.join(DIST, 'index.html')),
      jsSha256: sha256(path.join(DIST, 'assets', js)),
      cssSha256: sha256(path.join(DIST, 'assets', css)),
    },
    lambdaSha: lambdaAfter.CodeSha256,
  };
  await writeFile(`${OUT}/promote.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok || report.lambdaUpdated) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
