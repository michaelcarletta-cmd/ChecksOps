#!/usr/bin/env node
/**
 * Build a STAGING Lambda overlay for Tenant Collection v2.
 * Never writes production. Never enables production billing POST.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'aws/functions/api');
const OVERLAY = [
  'tenant-collection-v2.mjs',
  'tenant-collection-contract-v2.mjs',
  'tenant-billing-engine.mjs',
  'tenant-billing-destination.mjs',
  'tenant-billing-handlers.mjs',
  'providers/parity/tenant-receivables.mjs',
];

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function applyCollectionOverlay(unpackDir) {
  for (const rel of OVERLAY) {
    const from = path.join(SRC, rel);
    const to = path.join(unpackDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return OVERLAY.slice();
}

export function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-v2-staging-'));
  const zipPath = path.join(work, 'staging-base.zip');
  const loc = execFileSync('aws', [
    '--region', 'us-east-1', 'lambda', 'get-function',
    '--function-name', 'checksops-production-prep-api',
    '--query', 'Code.Location', '--output', 'text',
  ], { encoding: 'utf8' }).trim();
  execFileSync('curl', ['-fsSL', loc, '-o', zipPath]);
  const unpack = path.join(work, 'unpack');
  fs.mkdirSync(unpack);
  execFileSync('unzip', ['-q', zipPath, '-d', unpack]);
  applyCollectionOverlay(unpack);
  const outZip = path.join(work, 'checksops-staging-collection-v2.zip');
  execFileSync('zip', ['-qr', outZip, '.'], { cwd: unpack });
  const digest = sha256(outZip);
  const result = {
    overlay: OVERLAY,
    zip: outZip,
    sha256: digest,
    target: 'checksops-staging-api',
    production: false,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
