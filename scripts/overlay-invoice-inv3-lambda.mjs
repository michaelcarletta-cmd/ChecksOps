#!/usr/bin/env node
/**
 * Overlay ONLY the INV3 invoice parity block onto the CURRENT live Lambda zip.
 * Does not replace the package. Does not touch W2, billing, SPA, SQL, or env.
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
const OUT = '/opt/cursor/artifacts/invoice-inv3';
const TARGET = process.argv[2] || 'staging';
const API = TARGET === 'production'
  ? 'checksops-production-prep-api'
  : 'checksops-staging-api';
const EXPECTED_SHA = process.env.INV3_EXPECTED_SHA || '';
const FROZEN = [
  'tenant-billing-engine.mjs',
  'tenant-billing-destination.mjs',
  'tenant-billing-handlers.mjs',
  'providers/parity/caller.mjs',
  'providers/parity/moov-client.mjs',
  'providers/parity/moov-functions.mjs',
  'providers/parity/moov-rails.mjs',
  'providers/parity/rail-router.mjs',
  'providers/parity/moov-provider-env.mjs',
  'providers/parity/sweep-read.mjs',
  'providers/parity/moov-money.mjs',
  'providers/parity/db.mjs',
  'providers/webhook-apply.mjs',
  'scheduled.mjs',
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

const extractInvoiceBlock = (text) => {
  const start = text.indexOf('export const INVOICE_API_VERSION = ');
  const altStart = text.indexOf('const INVOICE_API_VERSION = ');
  const begin = start >= 0 ? start : altStart;
  const end = text.indexOf('export const platformBank = {');
  if (begin < 0 || end <= begin) return { ok: false, reason: 'invoice_block_missing' };
  return { ok: true, begin, end, block: text.slice(begin, end) };
};

const patchOnboard = (liveText, candidateText) => {
  const live = extractInvoiceBlock(liveText);
  const candidate = extractInvoiceBlock(candidateText);
  if (!live.ok) return { ok: false, reason: 'live_invoice_block_missing' };
  if (!candidate.ok) return { ok: false, reason: 'candidate_invoice_block_missing' };
  if (live.block.includes('customerAccountID') && live.block.includes('basePrice') && live.block.includes('moov_invoice_customers')) {
    return { ok: false, reason: 'already_ported_or_newer' };
  }
  if (!live.block.includes('requireMoovProviderEnvironment') || !live.block.includes("action === 'preflight'")) {
    return { ok: false, reason: 'inv1_hunk_missing' };
  }
  if (!live.block.includes('unitPrice') || !live.block.includes('customer: body.customer')) {
    return { ok: false, reason: 'live_stub_shape_changed' };
  }
  if (!candidate.block.includes('customerAccountID') || !candidate.block.includes('basePrice')) {
    return { ok: false, reason: 'candidate_missing_parity' };
  }
  return {
    ok: true,
    text: `${liveText.slice(0, live.begin)}${candidate.block}${liveText.slice(live.end)}`,
    reasonChanged: 'Replace INV1 invoice stub with supabase moov-invoice create/reuse/send/persist/sync parity. Transfer API version and non-invoice files unchanged.',
  };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole(`invoice-inv3-${TARGET}`);
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API]);
  const vars = before.Environment?.Variables || {};
  if (EXPECTED_SHA && before.CodeSha256 !== EXPECTED_SHA) {
    const report = { ok: false, error: 'toctou_sha_changed', expected: EXPECTED_SHA, actual: before.CodeSha256, target: TARGET };
    await writeFile(path.join(OUT, `${TARGET}-lambda-toctou-stop.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }
  if (vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') {
    throw new Error('PRODUCTION_POST is not false; refusing overlay');
  }
  if (vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED === 'true') {
    throw new Error('verification POST is true; refusing overlay');
  }

  const loc = awsJson(['lambda', 'get-function', '--function-name', API]);
  if (EXPECTED_SHA && loc.Configuration?.CodeSha256 !== EXPECTED_SHA) {
    throw new Error(`toctou_get_function_sha_changed:${loc.Configuration?.CodeSha256}`);
  }
  const tmp = path.join(os.tmpdir(), `invoice-inv3-${TARGET}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const zipIn = path.join(tmp, 'live.zip');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  const beforePkg = path.join(tmp, 'before');
  const afterPkg = path.join(tmp, 'after');
  fs.mkdirSync(beforePkg, { recursive: true });
  fs.mkdirSync(afterPkg, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', beforePkg]);
  execFileSync('unzip', ['-qo', zipIn, '-d', afterPkg]);

  const onboardPath = path.join(afterPkg, 'providers/parity/moov-onboard.mjs');
  if (!fs.existsSync(onboardPath)) throw new Error('live_onboard_missing');
  const beforeOnboardHash = sha256(onboardPath);
  const candidatePath = path.join(ROOT, 'aws/functions/api/providers/parity/moov-onboard.mjs');
  const patched = patchOnboard(fs.readFileSync(onboardPath, 'utf8'), fs.readFileSync(candidatePath, 'utf8'));
  if (!patched.ok) {
    const report = {
      ok: false,
      error: 'target_file_ambiguous_or_newer',
      message: patched.reason,
      beforeOnboardHash,
    };
    await writeFile(path.join(OUT, `${TARGET}-lambda-stop.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(4);
  }
  fs.writeFileSync(onboardPath, patched.text);

  const beforeFiles = new Map(walk(beforePkg).map((file) => [path.relative(beforePkg, file), sha256(file)]));
  const afterFiles = new Map(walk(afterPkg).map((file) => [path.relative(afterPkg, file), sha256(file)]));
  const changed = [];
  const unchanged = [];
  for (const [rel, hash] of afterFiles) {
    if (beforeFiles.get(rel) !== hash) changed.push({ file: rel, before: beforeFiles.get(rel) || null, after: hash });
    else unchanged.push({ file: rel, sha256: hash, reason: 'unchanged' });
  }
  for (const rel of FROZEN) {
    if (beforeFiles.get(rel) !== afterFiles.get(rel)) throw new Error(`frozen_file_changed:${rel}`);
  }
  const unexpected = changed.filter((row) => row.file !== 'providers/parity/moov-onboard.mjs');
  if (unexpected.length) throw new Error(`unexpected_overlay_changes:${unexpected.map((r) => r.file).join(',')}`);

  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: afterPkg });
  fs.copyFileSync(zipOut, path.join(OUT, `${TARGET}-overlay-candidate.zip`));

  const toctou = awsJson(['lambda', 'get-function-configuration', '--function-name', API]);
  if (EXPECTED_SHA && toctou.CodeSha256 !== EXPECTED_SHA) {
    const report = { ok: false, error: 'toctou_pre_update_sha_changed', expected: EXPECTED_SHA, actual: toctou.CodeSha256 };
    await writeFile(path.join(OUT, `${TARGET}-lambda-toctou-stop.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }

  const updated = awsJson([
    'lambda', 'update-function-code',
    '--function-name', API,
    '--zip-file', `fileb://${zipOut}`,
  ]);
  waitFn(API);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API]);
  const afterVars = after.Environment?.Variables || {};
  const report = {
    ok: true,
    target: TARGET,
    api: API,
    beforeSha: before.CodeSha256,
    afterSha: after.CodeSha256,
    beforeRevision: before.RevisionId,
    afterRevision: after.RevisionId,
    lastModified: after.LastModified,
    overlayManifest: [{
      file: 'providers/parity/moov-onboard.mjs',
      currentProductionSha: beforeOnboardHash,
      candidateSha: sha256(onboardPath),
      reasonChanged: patched.reasonChanged,
    }],
    unchangedProof: unchanged.filter((row) => FROZEN.includes(row.file)),
    changed,
    monthlyPost: afterVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
    verificationPost: afterVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
    spaDeployed: false,
    sqlApplied: false,
    envModified: false,
    invoiceCreated: false,
    emailSent: false,
    update: { codeSha256: updated.CodeSha256, revisionId: updated.RevisionId },
  };
  await writeFile(path.join(OUT, `${TARGET}-lambda-overlay.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (afterVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') process.exit(2);
  if (afterVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED === 'true') process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
