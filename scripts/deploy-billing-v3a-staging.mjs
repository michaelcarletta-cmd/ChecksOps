#!/usr/bin/env node
/**
 * Staging overlay of the V3A context bind. Simulation only.
 * Does not enable verification or monthly POST. Does not send money.
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
const OUT = '/opt/cursor/artifacts/billing-verification-v3a';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('billing-v3a-staging');
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-v3a-overlay-'));
  const zipIn = path.join(tmp, 'live.zip');
  const unpacked = path.join(tmp, 'pkg');
  const loc = awsJson(['lambda', 'get-function', '--function-name', API_NAME]);
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  fs.mkdirSync(unpacked, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', unpacked]);
  const copies = ['tenant-billing-engine.mjs', 'tenant-billing-destination.mjs'];
  for (const rel of copies) {
    fs.copyFileSync(path.join(ROOT, 'aws/functions/api', rel), path.join(unpacked, rel));
  }
  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: unpacked });
  awsJson(['lambda', 'update-function-code', '--function-name', API_NAME, '--zip-file', `fileb://${zipOut}`]);
  waitFn(API_NAME);
  const vars = { ...(before.Environment?.Variables || {}) };
  vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED = 'false';
  if (vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST === 'true') {
    throw new Error('refusing to overlay staging while monthly PRODUCTION_POST is true');
  }
  vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST = vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || 'false';
  awsJson([
    'lambda', 'update-function-configuration',
    '--function-name', API_NAME,
    '--environment', JSON.stringify({ Variables: vars }),
  ]);
  waitFn(API_NAME);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const report = {
    ok: true,
    beforeSha: before.CodeSha256,
    afterSha: after.CodeSha256,
    lastModified: after.LastModified,
    monthlyPost: after.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
    verificationPost: after.Environment?.Variables?.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
    sandboxTransferPost: after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    realMoneySent: false,
    liveProviderPost: false,
  };
  await writeFile(path.join(OUT, 'staging-overlay.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
