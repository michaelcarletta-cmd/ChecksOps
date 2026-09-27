#!/usr/bin/env node
/**
 * Build a production Lambda candidate from the CURRENT live package plus the
 * accepted signature overlay. Does not call UpdateFunctionCode.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySignatureLambdaOverlay } from './lib/signature-production-lambda-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = process.env.CHECKSOPS_PROD_LAMBDA_WORK || '/tmp/prod-lambda-candidate';
const SRC = process.env.CHECKSOPS_PROD_LAMBDA_SRC || '/tmp/prod-lambda';
const ACCEPTED = process.env.CHECKSOPS_ACCEPTED_API || path.join(ROOT, 'aws/functions/api');
const OUT = process.env.CHECKSOPS_PROD_LAMBDA_ZIP || '/tmp/prod-lambda-signature-overlay.zip';
const EXPECTED_PROD_SHA = '9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=';

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

if (!fs.existsSync(path.join(SRC, 'esign.mjs'))) {
  throw new Error(`production package missing at ${SRC}`);
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.cpSync(SRC, WORK, { recursive: true });
const overlay = applySignatureLambdaOverlay({ destDir: WORK, acceptedDir: ACCEPTED });

const srcFiles = new Set(walk(SRC).map((file) => path.relative(SRC, file)));
const destFiles = new Set(walk(WORK).map((file) => path.relative(WORK, file)));
const added = [...destFiles].filter((file) => !srcFiles.has(file)).sort();
const removed = [...srcFiles].filter((file) => !destFiles.has(file)).sort();
const changed = [...srcFiles].filter((file) => (
  destFiles.has(file) && sha256(path.join(SRC, file)) !== sha256(path.join(WORK, file))
)).sort();

const forbiddenRemoved = [
  'app-services.mjs',
  'tenant-billing-handlers.mjs',
  'check-deposited.mjs',
  'endorsement-material-invalidation.mjs',
  'financial.mjs',
];
if (removed.length || forbiddenRemoved.some((file) => !destFiles.has(file))) {
  throw new Error(`overlay removed production files: ${removed.join(',')}`);
}

const allowedChanged = new Set([
  'esign.mjs',
  'homeowner.mjs',
  'signature-submit.mjs',
  'storage.mjs',
  'write-allowlist.mjs',
  'write-check-workflow.mjs',
]);
const unexpected = changed.filter((file) => !allowedChanged.has(file));
if (unexpected.length) {
  throw new Error(`overlay changed unrelated files: ${unexpected.join(',')}`);
}
if (added.join(',') !== 'write-signature.mjs') {
  throw new Error(`unexpected added files: ${added.join(',')}`);
}

const storage = fs.readFileSync(path.join(WORK, 'storage.mjs'), 'utf8');
if (!storage.includes('authorizeCleanStemSibling') || !storage.includes('recordPublicSignerViewed')) {
  throw new Error('storage overlay failed clean-stem + viewed invariant');
}
const appServices = fs.readFileSync(path.join(WORK, 'app-services.mjs'), 'utf8');
if (!appServices.includes('tenant-billing-admin')) {
  throw new Error('app-services lost production tenant billing');
}

execFileSync('bash', ['-lc', `cd ${WORK} && zip -qr ${OUT} .`], { encoding: 'utf8' });
const report = {
  ok: true,
  expected_production_sha: EXPECTED_PROD_SHA,
  overlay_files: overlay.files,
  added,
  removed,
  changed,
  zip: OUT,
  zip_sha256: sha256(OUT),
};
fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-overlay-diff.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
