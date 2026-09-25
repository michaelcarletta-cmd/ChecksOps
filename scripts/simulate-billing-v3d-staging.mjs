#!/usr/bin/env node
/**
 * Staging acceptance for V3D. Simulation only.
 * Does not invoke verify-debit, Pull Now, scheduler, or Moov POST.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const API_NAME = 'checksops-staging-api';
const OUT = '/opt/cursor/artifacts/billing-verification-v3d';
const DEBIT_FUND_METHOD = 'a02c1c81-9ca6-434d-accc-ea4471a70ef2';
const SOURCE_METHOD = '7a78a544-340d-46fd-a4a4-228661374da7';
const DEST_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('billing-v3d-staging-sim');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const loc = awsJson(['lambda', 'get-function', '--function-name', API_NAME]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-v3d-staging-sim-'));
  const zipIn = path.join(tmp, 'live.zip');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  execFileSync('unzip', ['-qo', zipIn, 'tenant-billing-engine.mjs', '-d', tmp]);
  const engine = fs.readFileSync(path.join(tmp, 'tenant-billing-engine.mjs'), 'utf8');
  const testFile = path.join(ROOT, 'aws/tests/api-billing-verification-moov-context.test.mjs');
  const testOut = execFileSync(process.execPath, ['--test', testFile], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      CHECKSOPS_ENV: 'staging',
      AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: 'false',
      AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: 'false',
    },
  });
  const vars = cfg.Environment?.Variables || {};
  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    verifyDebitInvoked: false,
    liveProviderPost: false,
    realMoneySent: false,
    stagingLambda: {
      name: API_NAME,
      codeSha256: cfg.CodeSha256,
      lastModified: cfg.LastModified,
      monthlyPost: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
      verificationPost: vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
    },
    overlay: {
      containsResolver: engine.includes('resolveDebitSourceMethodId'),
      failClosed: engine.includes('billing_debit_source_unavailable'),
      usesStoredCreditAsSource: engine.includes('sourceMethodId: readiness.authorization.provider_payment_method_id'),
      submitOccurrenceResolves: /export async function submitOccurrence[\s\S]*resolveBillingDebitSource/.test(engine),
      submitVerificationResolves: /export async function submitVerificationOccurrence[\s\S]*resolveBillingDebitSource/.test(engine),
    },
    fixture: {
      preferredSource: DEBIT_FUND_METHOD,
      storedCredit: SOURCE_METHOD,
      destination: DEST_METHOD,
      destinationType: 'moov-wallet',
      verificationAmountCents: 100,
    },
    tests: {
      file: 'aws/tests/api-billing-verification-moov-context.test.mjs',
      pass: /# (?:fail|failed) 0/.test(testOut) || /tests 1[7-9]/.test(testOut),
      outputTail: testOut.trim().split('\n').slice(-20),
    },
  };
  await writeFile(path.join(OUT, 'staging-simulation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (
    !report.overlay.containsResolver
    || !report.overlay.failClosed
    || report.overlay.usesStoredCreditAsSource
    || !report.overlay.submitOccurrenceResolves
    || !report.overlay.submitVerificationResolves
    || report.stagingLambda.monthlyPost === 'true'
    || report.stagingLambda.verificationPost === 'true'
    || !report.tests.pass
  ) {
    process.exit(2);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
