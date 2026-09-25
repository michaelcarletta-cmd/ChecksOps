#!/usr/bin/env node
/**
 * Overlay ONLY the V3D debit-source resolve onto CURRENT production Lambda.
 * Does not enable either POST gate. Does not send $1. Does not create occurrences.
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
const OUT = '/opt/cursor/artifacts/billing-verification-v3d';
const PROD_API = 'checksops-production-prep-api';
const EXPECTED_SHA = 'T8xU4Ce1NnhSPS4bQb624Q03M/PLVU1b/mOrmMdIETk=';
const EXPECTED_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const EXPECTED_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const OVERLAY = ['tenant-billing-engine.mjs'];
const FROZEN = [
  'tenant-billing-destination.mjs',
  'tenant-billing-handlers.mjs',
  'providers/parity/moov-client.mjs',
  'providers/parity/caller.mjs',
  'providers/parity/moov-functions.mjs',
  'providers/parity/moov-money.mjs',
  'providers/parity/moov-rails.mjs',
  'providers/parity/rail-router.mjs',
  'providers/webhook-apply.mjs',
  'scheduled.mjs',
];
const FROZEN_FLAGS = [
  'AWS_MOOV_MONTHLY_BILLING_ENABLED',
  'AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST',
  'AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED',
  'AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID',
  'AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID',
  'AWS_MOOV_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_MOOV_TRANSFER_POST_ENABLED',
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
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};
const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('billing-v3d-overlay');
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const vars = before.Environment?.Variables || {};
  if (before.CodeSha256 !== EXPECTED_SHA) {
    const report = { ok: false, error: 'toctou_sha_changed', expected: EXPECTED_SHA, actual: before.CodeSha256 };
    await writeFile(path.join(OUT, 'lambda-toctou-stop.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }
  if (vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') {
    throw new Error('PRODUCTION_POST is not false; refusing overlay');
  }
  if (vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED === 'true') {
    throw new Error('verification POST is true; refusing overlay');
  }
  if (vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID !== EXPECTED_ACCOUNT
    || vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID !== EXPECTED_METHOD) {
    throw new Error('destination mismatch; refusing overlay');
  }

  const loc = awsJson(['lambda', 'get-function', '--function-name', PROD_API]);
  if (loc.Configuration?.CodeSha256 !== EXPECTED_SHA) {
    throw new Error(`toctou_get_function_sha_changed:${loc.Configuration?.CodeSha256}`);
  }
  const tmp = path.join(os.tmpdir(), `billing-v3d-prod-overlay-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const zipIn = path.join(tmp, 'live.zip');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  const beforePkg = path.join(tmp, 'before');
  const afterPkg = path.join(tmp, 'after');
  fs.mkdirSync(beforePkg, { recursive: true });
  fs.mkdirSync(afterPkg, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', beforePkg]);
  execFileSync('unzip', ['-qo', zipIn, '-d', afterPkg]);

  const overlayManifest = [];
  for (const rel of OVERLAY) {
    const src = path.join(ROOT, 'aws/functions/api', rel);
    const dest = path.join(afterPkg, rel);
    const currentHash = sha256(path.join(beforePkg, rel));
    fs.copyFileSync(src, dest);
    overlayManifest.push({
      file: rel,
      currentHash,
      candidateHash: sha256(src),
      afterHash: sha256(dest),
    });
  }

  const beforeFiles = new Map(walk(beforePkg).map((file) => [path.relative(beforePkg, file), sha256(file)]));
  const afterFiles = new Map(walk(afterPkg).map((file) => [path.relative(afterPkg, file), sha256(file)]));
  const changed = [];
  for (const [rel, hash] of afterFiles) {
    if (beforeFiles.get(rel) !== hash) changed.push({ file: rel, before: beforeFiles.get(rel), after: hash });
  }
  for (const rel of FROZEN) {
    if (beforeFiles.get(rel) !== afterFiles.get(rel)) throw new Error(`frozen_file_changed:${rel}`);
  }
  const unexpected = changed.filter((row) => !OVERLAY.includes(row.file));
  if (unexpected.length) throw new Error(`unexpected_overlay_changes:${unexpected.map((r) => r.file).join(',')}`);

  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: afterPkg });
  fs.copyFileSync(zipOut, path.join(OUT, 'production-overlay-candidate.zip'));

  const toctou = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  if (toctou.CodeSha256 !== EXPECTED_SHA) {
    const report = { ok: false, error: 'toctou_pre_update_sha_changed', expected: EXPECTED_SHA, actual: toctou.CodeSha256 };
    await writeFile(path.join(OUT, 'lambda-toctou-stop.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }

  const updated = awsJson([
    'lambda', 'update-function-code',
    '--function-name', PROD_API,
    '--zip-file', `fileb://${zipOut}`,
  ]);
  waitFn(PROD_API);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const finalVars = after.Environment?.Variables || {};
  if (finalVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED === 'true'
    || finalVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') {
    throw new Error('gates drifted after overlay');
  }
  const flagDrift = FROZEN_FLAGS.filter((key) => String(finalVars[key] ?? '') !== String(vars[key] ?? ''));
  const report = {
    ok: after.State === 'Active' || after.LastUpdateStatus === 'Successful',
    beforeSha: EXPECTED_SHA,
    afterSha: after.CodeSha256,
    lastModified: after.LastModified,
    overlayManifest,
    changedFiles: changed,
    monthlyPost: finalVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST,
    verificationPost: finalVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || 'false',
    destination: {
      account: finalVars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID,
      method: finalVars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID,
    },
    flagDrift,
    updateFunctionCodeSha: updated.CodeSha256 || null,
    realDollarSent: false,
    verificationOccurrenceCreated: false,
    verifyDebitInvoked: false,
  };
  await writeFile(path.join(OUT, 'lambda-overlay.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok || flagDrift.length) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
