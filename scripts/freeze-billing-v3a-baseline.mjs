#!/usr/bin/env node
/**
 * Read-only V3A freeze. Does not change Lambda code, env, SQL, or send ACH.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/billing-verification-v3a';
const STAGING_API = 'checksops-staging-api';
const PROD_API = 'checksops-production-prep-api';
const EXPECTED_SHA = 'k3+Rmh45UxDndWaAFAsdwhX3OT2fWfyfhYA3rnf3LqA=';
const EXPECTED_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const EXPECTED_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const COMPARE = [
  'tenant-billing-engine.mjs',
  'tenant-billing-destination.mjs',
  'tenant-billing-handlers.mjs',
];

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const unpack = (name, dest) => {
  const loc = awsJson(['lambda', 'get-function', '--function-name', name]);
  const zip = path.join(dest, `${name}.zip`);
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zip], { stdio: 'ignore' });
  const pkg = path.join(dest, name);
  fs.mkdirSync(pkg, { recursive: true });
  execFileSync('unzip', ['-qo', zip, '-d', pkg]);
  return { loc, zip, pkg };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('billing-v3a-freeze');
  const stagingCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const prodCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const tmp = path.join(os.tmpdir(), `billing-v3a-freeze-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const stagingPkg = unpack(STAGING_API, tmp);
  const prodPkg = unpack(PROD_API, tmp);
  fs.copyFileSync(prodPkg.zip, path.join(OUT, 'production-live-baseline.zip'));
  const prodVars = prodCfg.Environment?.Variables || {};
  const stagingVars = stagingCfg.Environment?.Variables || {};
  const files = {};
  for (const rel of COMPARE) {
    const live = path.join(prodPkg.pkg, rel);
    const workspace = path.join(ROOT, 'aws/functions/api', rel);
    files[rel] = {
      liveSha256: fs.existsSync(live) ? sha256(live) : null,
      workspaceSha256: fs.existsSync(workspace) ? sha256(workspace) : null,
      liveHasWithMoovContext: fs.existsSync(live) && fs.readFileSync(live, 'utf8').includes('withMoovContext'),
      workspaceHasWithMoovContext: fs.existsSync(workspace) && fs.readFileSync(workspace, 'utf8').includes('withMoovContext'),
    };
  }
  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    expectedSha: EXPECTED_SHA,
    staging: {
      name: STAGING_API,
      codeSha256: stagingCfg.CodeSha256,
      lastModified: stagingCfg.LastModified,
      monthlyPost: stagingVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
      verificationPost: stagingVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
    },
    production: {
      name: PROD_API,
      codeSha256: prodCfg.CodeSha256,
      lastModified: prodCfg.LastModified,
      shaMatchesExpected: prodCfg.CodeSha256 === EXPECTED_SHA,
      monthlyPost: prodVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
      verificationPost: prodVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
      destinationAccount: prodVars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
      destinationMethod: prodVars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || null,
      destMatches:
        prodVars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID === EXPECTED_ACCOUNT
        && prodVars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID === EXPECTED_METHOD,
      files,
    },
  };
  await writeFile(path.join(OUT, 'baseline.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.production.shaMatchesExpected) process.exit(3);
  if (report.production.monthlyPost !== 'false' || report.production.verificationPost === 'true') process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
