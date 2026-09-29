#!/usr/bin/env node
/**
 * Overlay INV6 safeguard + recover onto the current live Lambda zip.
 * Touches only onboard invoice block, logPaymentEvent, and write-txn diagnostics.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv6';
const TARGET = process.argv[2] || 'staging';
const API = TARGET === 'production'
  ? 'checksops-production-prep-api'
  : 'checksops-staging-api';
const EXPECTED_SHA = process.env.INV6_EXPECTED_SHA || '';
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
  'providers/webhook-apply.mjs',
  'scheduled.mjs',
];
const ALLOWED = new Set([
  'providers/parity/moov-onboard.mjs',
  'providers/parity/db.mjs',
  'data.mjs',
]);

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
}));
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

const replaceSpan = (text, startNeedle, endNeedle, replacement) => {
  const start = text.indexOf(startNeedle);
  const end = text.indexOf(endNeedle);
  if (start < 0 || end <= start) return { ok: false, text, reason: `span_missing:${startNeedle.slice(0, 40)}` };
  return { ok: true, text: `${text.slice(0, start)}${replacement}${text.slice(end)}` };
};

const patchOnboard = (liveText, candidateText) => {
  const startNeedle = 'export const INVOICE_API_VERSION = ';
  const altStart = 'const INVOICE_API_VERSION = ';
  const begin = liveText.includes(startNeedle) ? startNeedle : altStart;
  const endNeedle = 'export const platformBank = {';
  const liveStart = liveText.indexOf(begin);
  const liveEnd = liveText.indexOf(endNeedle);
  const candStart = candidateText.indexOf(begin === altStart && candidateText.includes(startNeedle) ? startNeedle : begin);
  const candEnd = candidateText.indexOf(endNeedle);
  if (liveStart < 0 || liveEnd <= liveStart || candStart < 0 || candEnd <= candStart) {
    return { ok: false, reason: 'invoice_block_missing' };
  }
  const candidateBlock = candidateText.slice(candStart, candEnd);
  if (!candidateBlock.includes("action === 'recover'") || !candidateBlock.includes('SAVEPOINT invoice_customer')) {
    return { ok: false, reason: 'candidate_missing_inv6' };
  }
  return {
    ok: true,
    text: `${liveText.slice(0, liveStart)}${candidateBlock}${liveText.slice(liveEnd)}`,
    reason: 'INV6 recover + customer savepoint on accepted invoice persist path',
  };
};

const patchDb = (liveText, candidateText) => {
  const start = 'export const logPaymentEvent = async (client, row) => {';
  const end = 'export const membershipRole';
  const liveStart = liveText.indexOf(start);
  const liveEnd = liveText.indexOf(end);
  const candStart = candidateText.indexOf(start);
  const candEnd = candidateText.indexOf(end);
  if (liveStart < 0 || liveEnd <= liveStart || candStart < 0 || candEnd <= candStart) {
    return { ok: false, reason: 'logPaymentEvent_span_missing' };
  }
  const replacement = candidateText.slice(candStart, candEnd);
  if (!replacement.includes('SAVEPOINT payment_event_log')) {
    return { ok: false, reason: 'candidate_missing_savepoint' };
  }
  return { ok: true, text: `${liveText.slice(0, liveStart)}${replacement}${liveText.slice(liveEnd)}` };
};

const patchData = (liveText, candidateText) => {
  const helperStart = candidateText.indexOf('export const classifyTrackedSqlFailure');
  const helperEnd = candidateText.indexOf('export const withIdentity = async');
  const helpers = helperStart >= 0 && helperEnd > helperStart
    ? candidateText.slice(helperStart, helperEnd)
    : '';
  let next = liveText;
  if (!next.includes('export const classifyTrackedSqlFailure')) {
    const commitComment = next.indexOf('/**\n * COMMIT of an aborted');
    const commitExport = next.indexOf('export const commitWriteTransaction');
    const withIdent = next.indexOf('export const withIdentity = async');
    if (withIdent < 0) return { ok: false, reason: 'withIdentity_missing' };
    const insertAt = commitComment >= 0 ? commitComment : (commitExport >= 0 ? commitExport : withIdent);
    // Replace any live commit helper so INV6 helpers do not duplicate the export.
    next = `${next.slice(0, insertAt)}${helpers}${next.slice(withIdent)}`;
  } else {
    const replaced = replaceSpan(next, 'export const classifyTrackedSqlFailure', 'export const withIdentity = async', helpers);
    if (!replaced.ok) return replaced;
    next = replaced.text;
  }
  const liveWith = next.indexOf('export const withIdentity = async');
  const liveParse = next.indexOf('export const parseSelect');
  const candWith = candidateText.indexOf('export const withIdentity = async');
  const candParse = candidateText.indexOf('export const parseSelect');
  if (liveWith < 0 || liveParse <= liveWith || candWith < 0 || candParse <= candWith) {
    return { ok: false, reason: 'withIdentity_span_missing' };
  }
  next = `${next.slice(0, liveWith)}${candidateText.slice(candWith, candParse)}${next.slice(liveParse)}`;
  if (!next.includes('trackClientSqlFailures') || !next.includes('logCommitFailure')) {
    return { ok: false, reason: 'data_helpers_not_applied' };
  }
  if ((next.match(/export const commitWriteTransaction/g) || []).length !== 1) {
    return { ok: false, reason: 'duplicate_commitWriteTransaction' };
  }
  return { ok: true, text: next };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole(`invoice-inv6-${TARGET}`);
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API]);
  const vars = before.Environment?.Variables || {};
  if (EXPECTED_SHA && before.CodeSha256 !== EXPECTED_SHA) {
    const report = { ok: false, error: 'toctou_sha_changed', expected: EXPECTED_SHA, actual: before.CodeSha256, target: TARGET };
    await writeFile(`${OUT}/${TARGET}-lambda-toctou-stop.json`, JSON.stringify(report, null, 2));
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
  const tmp = path.join(os.tmpdir(), `invoice-inv6-${TARGET}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const zipIn = path.join(tmp, 'live.zip');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  const beforePkg = path.join(tmp, 'before');
  const afterPkg = path.join(tmp, 'after');
  fs.mkdirSync(beforePkg, { recursive: true });
  fs.mkdirSync(afterPkg, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', beforePkg]);
  execFileSync('unzip', ['-qo', zipIn, '-d', afterPkg]);

  const onboard = patchOnboard(
    fs.readFileSync(path.join(afterPkg, 'providers/parity/moov-onboard.mjs'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/parity/moov-onboard.mjs'), 'utf8'),
  );
  if (!onboard.ok) throw new Error(`onboard_patch:${onboard.reason}`);
  fs.writeFileSync(path.join(afterPkg, 'providers/parity/moov-onboard.mjs'), onboard.text);

  const db = patchDb(
    fs.readFileSync(path.join(afterPkg, 'providers/parity/db.mjs'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/parity/db.mjs'), 'utf8'),
  );
  if (!db.ok) throw new Error(`db_patch:${db.reason}`);
  fs.writeFileSync(path.join(afterPkg, 'providers/parity/db.mjs'), db.text);

  const data = patchData(
    fs.readFileSync(path.join(afterPkg, 'data.mjs'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8'),
  );
  if (!data.ok) throw new Error(`data_patch:${data.reason}`);
  fs.writeFileSync(path.join(afterPkg, 'data.mjs'), data.text);

  const beforeFiles = new Map(walk(beforePkg).map((file) => [path.relative(beforePkg, file), sha256(file)]));
  const afterFiles = new Map(walk(afterPkg).map((file) => [path.relative(afterPkg, file), sha256(file)]));
  const changed = [];
  for (const [rel, hash] of afterFiles) {
    if (beforeFiles.get(rel) !== hash) changed.push({ file: rel, before: beforeFiles.get(rel) || null, after: hash });
  }
  for (const rel of FROZEN) {
    if (beforeFiles.get(rel) !== afterFiles.get(rel)) throw new Error(`frozen_file_changed:${rel}`);
  }
  const unexpected = changed.filter((row) => !ALLOWED.has(row.file));
  if (unexpected.length) throw new Error(`unexpected_overlay_changes:${unexpected.map((r) => r.file).join(',')}`);

  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: afterPkg });
  fs.copyFileSync(zipOut, path.join(OUT, `${TARGET}-overlay-candidate.zip`));

  const toctou = awsJson(['lambda', 'get-function-configuration', '--function-name', API]);
  if (EXPECTED_SHA && toctou.CodeSha256 !== EXPECTED_SHA) {
    const report = { ok: false, error: 'toctou_pre_update_sha_changed', expected: EXPECTED_SHA, actual: toctou.CodeSha256 };
    await writeFile(`${OUT}/${TARGET}-lambda-toctou-stop.json`, JSON.stringify(report, null, 2));
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
    changed,
    monthlyPost: afterVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
    verificationPost: afterVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
    spaDeployed: false,
    envModified: false,
    invoiceCreated: false,
    emailSent: false,
    update: { codeSha256: updated.CodeSha256, revisionId: updated.RevisionId },
  };
  await writeFile(`${OUT}/${TARGET}-lambda-overlay.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
