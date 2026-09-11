#!/usr/bin/env node
/**
 * Build a coherent staging Lambda zip from the CURRENT live package + this Git tree.
 * Does not deploy, change env, send email, or touch production / production-prep.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const ROOT = dirname(fileURLToPath(import.meta.url));
const WORK = process.env.COHERENT_WORK || '/tmp/coherent-package';
const LIVE_ZIP = process.env.LIVE_ZIP || '/tmp/coherent/live.zip';
const OUT_ZIP = process.env.OUT_ZIP || '/tmp/coherent-package/checksops-staging-api-coherent.zip';
const SKIP = new Set([
  'node_modules',
  'build-ledger-send-overlay.mjs',
  'build-coherent-staging-zip.mjs',
  'validate-coherent-staging-zip.mjs',
]);

const walk = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
};

if (!existsSync(LIVE_ZIP)) throw new Error(`missing live zip ${LIVE_ZIP}`);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, 'pkg'), { recursive: true });
execFileSync('unzip', ['-o', '-q', LIVE_ZIP, '-d', join(WORK, 'pkg')]);

const copied = [];
for (const full of walk(ROOT)) {
  const rel = relative(ROOT, full);
  const dest = join(WORK, 'pkg', rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(full, dest);
  copied.push(rel);
}

if (!existsSync(join(WORK, 'pkg', 'identity-link.mjs'))) throw new Error('identity-link.mjs missing');
if (!existsSync(join(WORK, 'pkg', 'platform-authz.mjs'))) throw new Error('platform-authz.mjs missing');
if (!existsSync(join(WORK, 'pkg', 'email-audited.mjs'))) throw new Error('email-audited.mjs missing');
if (!existsSync(join(WORK, 'pkg', 'node_modules'))) throw new Error('live node_modules missing');

execFileSync('zip', ['-qr', OUT_ZIP, '.'], { cwd: join(WORK, 'pkg') });
const zipBytes = readFileSync(OUT_ZIP);
const sha256Base64 = createHash('sha256').update(zipBytes).digest('base64');

const report = {
  liveZip: LIVE_ZIP,
  outZip: OUT_ZIP,
  bytes: zipBytes.length,
  sha256Base64,
  copiedCount: copied.length,
  skipped: [...SKIP],
  deploy: false,
};
writeFileSync(join(WORK, 'build.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
