#!/usr/bin/env node
/**
 * Read-only V3D freeze. Does not change Lambda code, env, SQL, or send ACH.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/billing-verification-v3d';
const STAGING_API = 'checksops-staging-api';
const PROD_API = 'checksops-production-prep-api';
const EXPECTED_SHA = 'T8xU4Ce1NnhSPS4bQb624Q03M/PLVU1b/mOrmMdIETk=';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('billing-v3d-freeze');
  const stagingCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const prodCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const prodVars = prodCfg.Environment?.Variables || {};
  const stagingVars = stagingCfg.Environment?.Variables || {};
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
    },
  };
  await writeFile(`${OUT}/baseline.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.production.monthlyPost !== 'false' || report.production.verificationPost === 'true') {
    process.exit(2);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
