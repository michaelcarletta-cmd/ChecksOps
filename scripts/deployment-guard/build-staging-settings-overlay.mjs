#!/usr/bin/env node
/**
 * Build a STAGING Lambda overlay for settings billing/branding/stakeholder.
 * Starts from a freshly downloaded checksops-staging-api package.
 * Never writes AWS. Never targets production.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'aws/functions/api');
const AWS = process.env.AWS_CLI || process.env.AWS || `${process.env.HOME}/.local/bin/aws`;
const FUNCTION_NAME = 'checksops-staging-api';

export const OWNED_MEMBERS = Object.freeze([
  'app-services.mjs',
  'tenant-settings-handlers.mjs',
  'tenant-email-domain-handlers.mjs',
  'providers/parity/moov-functions.mjs',
  'providers/parity/moov-stakeholder-status.mjs',
]);

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const hashTree = (dir) => {
  const members = {};
  const walk = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else members[rel] = sha256File(abs);
    }
  };
  walk(dir);
  return members;
};

export function applySettingsOverlay(unpackDir) {
  for (const rel of OWNED_MEMBERS) {
    const from = path.join(SRC, rel);
    const to = path.join(unpackDir, rel);
    if (!fs.existsSync(from)) throw new Error(`missing source member ${rel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return OWNED_MEMBERS.slice();
}

export function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-staging-overlay-'));
  const zipPath = path.join(work, 'staging-live.zip');
  const loc = execFileSync(AWS, [
    '--region', 'us-east-1', 'lambda', 'get-function',
    '--function-name', FUNCTION_NAME,
    '--query', 'Code.Location', '--output', 'text',
  ], { encoding: 'utf8' }).trim();
  execFileSync('curl', ['-fsSL', loc, '-o', zipPath]);
  const unpack = path.join(work, 'unpack');
  fs.mkdirSync(unpack);
  execFileSync('unzip', ['-q', zipPath, '-d', unpack]);
  const liveMembers = hashTree(unpack);
  applySettingsOverlay(unpack);
  const candidateMembers = hashTree(unpack);
  const outZip = path.join(work, 'checksops-staging-settings-overlay.zip');
  execFileSync('zip', ['-qr', outZip, '.'], { cwd: unpack });
  const result = {
    overlay: OWNED_MEMBERS,
    zip: outZip,
    sha256: sha256File(outZip),
    target: FUNCTION_NAME,
    production: false,
    origin: 'fresh-live-download',
    downloaded_at: new Date().toISOString(),
    live_members: liveMembers,
    candidate_members: candidateMembers,
    work_dir: work,
  };
  const outFile = path.join(work, 'overlay-manifest.json');
  fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    zip: result.zip,
    sha256: result.sha256,
    overlay: result.overlay,
    manifest: outFile,
    origin: result.origin,
    downloaded_at: result.downloaded_at,
    owned_changed: OWNED_MEMBERS.filter((key) => liveMembers[key] !== candidateMembers[key]),
  }, null, 2));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
