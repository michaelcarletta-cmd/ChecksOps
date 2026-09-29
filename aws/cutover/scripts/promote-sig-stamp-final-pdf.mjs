#!/usr/bin/env node
/**
 * Narrow production overlay: replace only signature-submit.mjs on
 * checksops-production-prep-api using the current live package as baseline.
 * Stops if live CodeSha256 drifted from the accepted diagnosis SHA.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const PREP = 'checksops-production-prep-api';
const EXPECTED_LIVE_SHA = 'aU5OCyV4qm6057bFWDF2T9KEkZPVvmav4qoiFczpaCM=';
const OVERLAY_FILE = 'signature-submit.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const repoOverlay = join(here, '../../functions/api', OVERLAY_FILE);
const workRoot = '/tmp/sig-stamp-promote';
const apply = process.argv.includes('--apply');

const run = (args) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const trimmed = String(out || '').trim();
    if (!trimmed) return { ok: true, data: {} };
    try { return { ok: true, data: JSON.parse(trimmed) }; } catch { return { ok: true, data: { raw: trimmed.slice(0, 240) } }; }
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    return { ok: false, denied: /AccessDenied|not authorized|ExpiredToken/i.test(text), message: text.slice(0, 900) };
  }
};

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const walkFiles = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
};

const fileMap = (root) => {
  const map = {};
  for (const rel of walkFiles(root)) {
    const full = join(root, rel);
    map[rel] = { sha256: sha256File(full), bytes: statSync(full).size };
  }
  return map;
};

const diffMaps = (before, after) => {
  const changed = [];
  const added = [];
  const removed = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!before[key]) added.push(key);
    else if (!after[key]) removed.push(key);
    else if (before[key].sha256 !== after[key].sha256) changed.push(key);
  }
  return { changed, added, removed };
};

const before = run(['lambda', 'get-function', '--function-name', PREP]);
if (!before.ok) {
  console.error(JSON.stringify({ ok: false, stage: 'get_function', error: before.message }, null, 2));
  process.exit(2);
}
const liveSha = before.data.Configuration?.CodeSha256;
if (liveSha !== EXPECTED_LIVE_SHA) {
  console.error(JSON.stringify({
    ok: false,
    stage: 'sha_drift',
    expected: EXPECTED_LIVE_SHA,
    live: liveSha,
    lastModified: before.data.Configuration?.LastModified || null,
    action: 'STOP',
  }, null, 2));
  process.exit(3);
}

const location = before.data.Code?.Location;
if (!location) {
  console.error(JSON.stringify({ ok: false, stage: 'missing_code_location' }, null, 2));
  process.exit(2);
}

rmSync(workRoot, { recursive: true, force: true });
mkdirSync(workRoot, { recursive: true });
const zipPath = join(workRoot, 'live.zip');
execFileSync('curl', ['-fsSL', location, '-o', zipPath], { encoding: 'utf8' });
const extract = join(workRoot, 'extract');
mkdirSync(extract, { recursive: true });
execFileSync('unzip', ['-o', '-q', zipPath, '-d', extract], { encoding: 'utf8' });

if (!existsSync(join(extract, OVERLAY_FILE))) {
  console.error(JSON.stringify({ ok: false, stage: 'live_missing_signature_submit' }, null, 2));
  process.exit(2);
}

const beforeMap = fileMap(extract);
cpSync(repoOverlay, join(extract, OVERLAY_FILE));
const afterMap = fileMap(extract);
const overlayDiff = diffMaps(beforeMap, afterMap);
if (overlayDiff.changed.length !== 1 || overlayDiff.changed[0] !== OVERLAY_FILE || overlayDiff.added.length || overlayDiff.removed.length) {
  console.error(JSON.stringify({
    ok: false,
    stage: 'overlay_not_narrow',
    overlayDiff,
  }, null, 2));
  process.exit(4);
}

const updatedZip = join(workRoot, 'updated.zip');
execFileSync('bash', ['-lc', `cd ${extract} && zip -qr ${updatedZip} .`], { encoding: 'utf8' });

const report = {
  ok: true,
  applied: false,
  function: PREP,
  expectedLiveSha: EXPECTED_LIVE_SHA,
  oldSha: liveSha,
  lastModifiedBefore: before.data.Configuration?.LastModified || null,
  overlayFile: OVERLAY_FILE,
  liveFilesChanged: overlayDiff.changed,
  added: overlayDiff.added,
  removed: overlayDiff.removed,
  overlaySha256: afterMap[OVERLAY_FILE].sha256,
  previousOverlaySha256: beforeMap[OVERLAY_FILE].sha256,
  liveZipSha256: sha256File(zipPath),
  updatedZipSha256: sha256File(updatedZip),
};

if (!apply) {
  writeFileSync(join(workRoot, 'promote-dry-run.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const update = run([
  'lambda', 'update-function-code',
  '--function-name', PREP,
  '--zip-file', `fileb://${updatedZip}`,
]);
if (!update.ok) {
  report.ok = false;
  report.stage = 'update_function_code';
  report.error = update.message;
  report.denied = update.denied || false;
  console.error(JSON.stringify(report, null, 2));
  process.exit(update.denied ? 5 : 1);
}

try {
  execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', PREP], { encoding: 'utf8' });
} catch { /* describe below */ }

const after = run(['lambda', 'get-function', '--function-name', PREP]);
report.applied = true;
report.newSha = after.data.Configuration?.CodeSha256 || update.data.CodeSha256 || null;
report.lastModifiedAfter = after.data.Configuration?.LastModified || null;
report.updateCodeSha256 = update.data.CodeSha256 || null;

if (after.ok && after.data.Code?.Location) {
  const verifyZip = join(workRoot, 'after.zip');
  const verifyDir = join(workRoot, 'after');
  execFileSync('curl', ['-fsSL', after.data.Code.Location, '-o', verifyZip], { encoding: 'utf8' });
  mkdirSync(verifyDir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', verifyZip, '-d', verifyDir], { encoding: 'utf8' });
  const liveAfter = fileMap(verifyDir);
  const verifyDiff = diffMaps(beforeMap, liveAfter);
  report.verifyLiveFilesChanged = verifyDiff.changed;
  report.verifyAdded = verifyDiff.added;
  report.verifyRemoved = verifyDiff.removed;
  report.verifyNarrow = verifyDiff.changed.length === 1
    && verifyDiff.changed[0] === OVERLAY_FILE
    && !verifyDiff.added.length
    && !verifyDiff.removed.length;
  if (!report.verifyNarrow) report.ok = false;
}

writeFileSync(join(workRoot, 'promote-apply.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
