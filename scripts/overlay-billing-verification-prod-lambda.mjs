#!/usr/bin/env node
/**
 * Overlay ONLY verification-debit files onto CURRENT production Lambda.
 * Adds AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED=false if missing.
 * Does not enable monthly PRODUCTION_POST. Does not send $1.
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
const OUT = '/opt/cursor/artifacts/billing-verification-v2';
const PROD_API = 'checksops-production-prep-api';
const EXPECTED_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const EXPECTED_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const BASE = 'cursor/moov-mortgage-ops-prod-safe-2d41';
const OVERLAY = [
  'tenant-billing-engine.mjs',
  'tenant-billing-handlers.mjs',
  'tenant-billing-destination.mjs',
];
const FROZEN = [
  'providers/parity/moov-money.mjs',
  'providers/parity/rail-router.mjs',
  'providers/webhook-apply.mjs',
  'scheduled.mjs',
];
const FROZEN_FLAGS = [
  'AWS_MOOV_MONTHLY_BILLING_ENABLED',
  'AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST',
  'AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID',
  'AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID',
  'AWS_MOOV_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_MOOV_TRANSFER_POST_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'AWS_CHECKALT_STATUS_RECONCILE_ENABLED',
  'CHECKSOPS_ENV',
];

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shaText = (text) => createHash('sha256').update(text).digest('hex');
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
const gitShow = (rel) => execFileSync(
  'git', ['show', `${BASE}:aws/functions/api/${rel}`],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
);
const destWithoutVerification = (src) => src
  .replace(/\n\/\*\* Isolated \$1 billing-verification POST\. Independent of monthly PRODUCTION_POST\. Default false\. \*\/\nexport const billingVerificationPostEnabled = \(\) => \(\n  isTrue\(process\.env\.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED\)\n\);\n/g, '\n')
  .replace(/\n\/\*\* Simulate unless the isolated verification gate is explicitly true\. Does not read monthly POST\. \*\/\nexport const billingVerificationShouldSimulate = \(deps = \{\}\) => \{\n  if \(deps\.simulate === true\) return true;\n  if \(deps\.simulate === false\) return false;\n  if \(isTrue\(process\.env\.AWS_MOOV_BILLING_VERIFICATION_SIMULATE\)\) return true;\n  return !billingVerificationPostEnabled\(\);\n\};\n/g, '\n');

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('billing-verification-overlay');
  const baseline = JSON.parse(fs.readFileSync(path.join(OUT, 'baseline.json'), 'utf8'));
  const sqlReport = JSON.parse(fs.readFileSync(path.join(OUT, 'sql47-apply.json'), 'utf8'));
  if (sqlReport.accept?.ok !== true) throw new Error('SQL 47 apply did not succeed; refusing overlay');
  const expectedSha = baseline.production.codeSha256;
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const vars = before.Environment?.Variables || {};
  if (before.CodeSha256 !== expectedSha) {
    const report = { ok: false, error: 'toctou_sha_changed', expected: expectedSha, actual: before.CodeSha256 };
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
  if (loc.Configuration?.CodeSha256 !== expectedSha) {
    throw new Error(`toctou_get_function_sha_changed:${loc.Configuration?.CodeSha256}`);
  }
  const tmp = path.join(os.tmpdir(), `billing-verify-prod-overlay-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const zipIn = path.join(tmp, 'live.zip');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  const beforePkg = path.join(tmp, 'before');
  const afterPkg = path.join(tmp, 'after');
  fs.mkdirSync(beforePkg, { recursive: true });
  fs.mkdirSync(afterPkg, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', beforePkg]);
  execFileSync('unzip', ['-qo', zipIn, '-d', afterPkg]);

  for (const rel of ['tenant-billing-engine.mjs', 'tenant-billing-handlers.mjs']) {
    const live = fs.readFileSync(path.join(beforePkg, rel), 'utf8');
    const base = gitShow(rel);
    if (shaText(live) !== shaText(base)) {
      const report = {
        ok: false,
        error: 'live_file_newer_than_base_stop',
        file: rel,
        liveSha256: shaText(live),
        baseSha256: shaText(base),
      };
      await writeFile(path.join(OUT, 'lambda-forward-port-stop.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      process.exit(3);
    }
  }
  const liveDest = fs.readFileSync(path.join(beforePkg, 'tenant-billing-destination.mjs'), 'utf8');
  const workspaceDest = fs.readFileSync(path.join(ROOT, 'aws/functions/api/tenant-billing-destination.mjs'), 'utf8');
  if (shaText(destWithoutVerification(workspaceDest)) !== shaText(liveDest)
    && shaText(workspaceDest) !== shaText(liveDest)) {
    const report = {
      ok: false,
      error: 'destination_has_unrelated_changes_stop',
      liveSha256: shaText(liveDest),
      strippedWorkspaceSha256: shaText(destWithoutVerification(workspaceDest)),
    };
    await writeFile(path.join(OUT, 'lambda-destination-stop.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }

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
  for (const [rel, hash] of beforeFiles) {
    if (!afterFiles.has(rel)) changed.push({ file: rel, before: hash, after: null, deleted: true });
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
  if (toctou.CodeSha256 !== expectedSha) {
    const report = { ok: false, error: 'toctou_pre_update_sha_changed', expected: expectedSha, actual: toctou.CodeSha256 };
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

  const afterCode = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const afterVars = { ...(afterCode.Environment?.Variables || {}) };
  if (afterVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED !== 'false') {
    afterVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED = 'false';
    awsJson([
      'lambda', 'update-function-configuration',
      '--function-name', PROD_API,
      '--environment', JSON.stringify({ Variables: afterVars }),
    ]);
    waitFn(PROD_API);
  }
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const finalVars = after.Environment?.Variables || {};
  const flagDrift = FROZEN_FLAGS.filter((key) => String(finalVars[key] ?? '') !== String(vars[key] ?? ''));
  if (finalVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') {
    throw new Error('PRODUCTION_POST drifted after overlay');
  }
  if (finalVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED !== 'false') {
    throw new Error('verification POST is not false after overlay');
  }
  const health = await fetch('https://checksops.com/prep/health').then(async (res) => ({
    status: res.status, body: await res.json().catch(() => null),
  })).catch((error) => ({ error: String(error.message || error).slice(0, 200) }));

  const report = {
    ok: after.State === 'Active' || after.LastUpdateStatus === 'Successful',
    beforeSha: expectedSha,
    afterSha: after.CodeSha256,
    lastModified: after.LastModified,
    revisionId: after.RevisionId,
    lastUpdateStatus: after.LastUpdateStatus,
    overlayManifest,
    changedFiles: changed,
    envRewrittenExceptVerificationGateFalse: true,
    verificationPost: finalVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED,
    monthlyPost: finalVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST,
    destination: {
      account: finalVars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID,
      method: finalVars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID,
    },
    flagDrift,
    updateFunctionCodeSha: updated.CodeSha256 || null,
    health,
    realDollarSent: false,
    verificationOccurrenceCreated: false,
  };
  await writeFile(path.join(OUT, 'lambda-overlay.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok || flagDrift.length) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
