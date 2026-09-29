#!/usr/bin/env node
/**
 * Overlay Platform Finance read-model files onto CURRENT staging Lambda zip.
 * Refuses production. Does not change moov-money funding execution.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const TARGET = process.argv[2] || 'staging';
const API = 'checksops-staging-api';
const SRC = path.join(ROOT, 'aws/functions/api');
const OVERLAY = [
  'providers/parity/tenant-receivables.mjs',
  'providers/parity/caller.mjs',
  'providers/parity/moov-functions.mjs',
  'providers/parity/moov-onboard.mjs',
];
const FORBIDDEN = [
  'providers/parity/moov-money.mjs',
  'tenant-billing-engine.mjs',
  'tenant-billing-destination.mjs',
];

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const main = async () => {
  if (TARGET === 'production') {
    throw new Error('This overlay refuses production. Staging only.');
  }
  await assumeCursorRole('platform-finance-receivables-overlay');
  const before = JSON.parse(execFileSync(AWS, [
    '--region', REGION, '--output', 'json',
    'lambda', 'get-function-configuration', '--function-name', API,
  ], { encoding: 'utf8' }));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-overlay-'));
  const zipPath = path.join(tmp, 'fn.zip');
  const unpack = path.join(tmp, 'unpack');
  const fn = JSON.parse(execFileSync(AWS, [
    '--region', REGION, '--output', 'json',
    'lambda', 'get-function', '--function-name', API,
  ], { encoding: 'utf8' }));
  execFileSync('curl', ['-fsSL', fn.Code.Location, '-o', zipPath], { maxBuffer: 80 * 1024 * 1024 });
  execFileSync('unzip', ['-q', zipPath, '-d', unpack]);
  for (const rel of FORBIDDEN) {
    const live = path.join(unpack, rel);
    const repo = path.join(SRC, rel);
    if (fs.existsSync(live) && fs.existsSync(repo) && sha256(live) !== sha256(repo)) {
      console.log(JSON.stringify({ skipped_funding_file: rel, reason: 'not overlaying moov-money / billing engine' }));
    }
  }
  const replaced = [];
  for (const rel of OVERLAY) {
    const from = path.join(SRC, rel);
    const to = path.join(unpack, rel);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
    replaced.push({ rel, sha256: sha256(to) });
  }
  const outZip = path.join(tmp, 'overlay.zip');
  execFileSync('bash', ['-lc', `cd ${JSON.stringify(unpack)} && zip -qr ${JSON.stringify(outZip)} .`]);
  const updated = JSON.parse(execFileSync(AWS, [
    '--region', REGION, '--output', 'json',
    'lambda', 'update-function-code',
    '--function-name', API,
    '--zip-file', `fileb://${outZip}`,
  ], { encoding: 'utf8' }));
  const report = {
    target: API,
    beforeSha: before.CodeSha256,
    afterSha: updated.CodeSha256,
    replaced,
    productionTouched: false,
    fundingFilesOverlaid: false,
  };
  await mkdir('/opt/cursor/artifacts/platform-finance-receivables', { recursive: true });
  await writeFile('/opt/cursor/artifacts/platform-finance-receivables/overlay.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
