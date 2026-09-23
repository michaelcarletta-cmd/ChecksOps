#!/usr/bin/env node
/**
 * Staging-only overlay for Review check correction.
 * Updates checksops-staging-api code in place. Does not SAM-deploy.
 * Does not change provider flags or production.
 *
 * Usage:
 *   node aws/workflows/scripts/overlay-review-correction-staging.mjs
 * Optional:
 *   APPLY_SQL=1 node ...   # also apply 71_review_correction.sql via admin oneshot
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REGION = process.env.AWS_REGION || 'us-east-1';
const API_FN = 'checksops-staging-api';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'review-correction-overlay-'));

const aws = (args, opts = {}) => {
  const result = spawnSync('aws', ['--region', REGION, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `aws ${args[0]} failed`);
  }
  return result.stdout;
};

const api = JSON.parse(aws(['lambda', 'get-function-configuration', '--function-name', API_FN]));
if (String(api.FunctionName) !== API_FN) throw new Error('refusing to overlay an unexpected function');
console.log(JSON.stringify({
  overlay: API_FN,
  beforeSha: api.CodeSha256,
  lastModified: api.LastModified,
  production: false,
  flagsUntouched: true,
}, null, 2));

const loc = JSON.parse(aws(['lambda', 'get-function', '--function-name', API_FN, '--query', 'Code.Location', '--output', 'json']));
const zipPath = path.join(WORK, 'current.zip');
execFileSync('curl', ['-fsSL', loc, '-o', zipPath]);
const unpacked = path.join(WORK, 'unpacked');
fs.mkdirSync(unpacked);
execFileSync('unzip', ['-o', '-q', zipPath, '-d', unpacked]);

const copies = [
  ['aws/functions/api/review-correction.mjs', 'review-correction.mjs'],
  ['aws/functions/api/workflow.mjs', 'workflow.mjs'],
];
for (const [src, dest] of copies) {
  const from = path.join(ROOT, src);
  const to = path.join(unpacked, dest);
  if (!fs.existsSync(from)) throw new Error(`missing ${src}`);
  fs.copyFileSync(from, to);
}

const outZip = path.join(WORK, 'updated.zip');
execFileSync('bash', ['-lc', `cd ${JSON.stringify(unpacked)} && zip -qr ${JSON.stringify(outZip)} .`]);
aws(['lambda', 'update-function-code', '--function-name', API_FN, '--zip-file', `fileb://${outZip}`]);
try { aws(['lambda', 'wait', 'function-updated', '--function-name', API_FN]); } catch { /* retry below */ }

const after = JSON.parse(aws(['lambda', 'get-function-configuration', '--function-name', API_FN]));
console.log(JSON.stringify({
  overlay: API_FN,
  afterSha: after.CodeSha256,
  lastModified: after.LastModified,
  production: false,
}, null, 2));

if (process.env.APPLY_SQL === '1') {
  console.log(JSON.stringify({
    applySql: 'manual',
    file: 'aws/workflows/sql/71_review_correction.sql',
    note: 'Apply with checksops_admin on staging RDS only. Do not GRANT UPDATE(amount) to checksops.',
  }));
}
