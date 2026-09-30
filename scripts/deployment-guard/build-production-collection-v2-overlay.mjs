#!/usr/bin/env node
/**
 * Build a PRODUCTION Lambda candidate from CURRENT live package + accepted
 * Tenant Collection V2 hunks only.
 *
 * Never deploys. Never changes env. Never enables billing POST.
 * Never copies the staging zip. Never restores an old production zip.
 * If live anchors moved, STOP — do not invent a new overlay.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'aws/functions/api');
const PATCH_DIR = path.join(ROOT, 'scripts/deployment-guard/patches/tenant-collection-v2');

export const FUNCTION_NAME = 'checksops-production-prep-api';

/** Current live hashes captured 2026-09-29T19:51:22Z (srotSrFR…). */
export const EXPECTED_LIVE_HASHES = Object.freeze({
  'tenant-billing-engine.mjs': '267fb89559d2c39c70d9227cc3b1ea3a0d45c7576ed1641f880b109b23d41241',
  'providers/parity/tenant-receivables.mjs': 'c83f4eae3a1653f0d7aa85682a0542fe55b15131dbc0b016aab7263b5033ea79',
  'tenant-billing-destination.mjs': '7f9f24569d8d3112bcb829380de17b56ac5076fe8a8b38fd6a7633b44bcdfd80',
  'tenant-billing-handlers.mjs': '8aeb8b7f431742249ace72ee32c1cbc1bf62789565a1eaa9a0249aa00c48586c',
  'app-services.mjs': '09745fb570098b6309aeeba748541663f0b9259e9a0ea22309878f11de54e7b8',
  'scheduled.mjs': '78daabb298f187b180e1435cc75c3bd519179aab82a0b83a9632a5f41c577090',
});

export const OWNED_ADDED = Object.freeze([
  'tenant-collection-v2.mjs',
  'tenant-collection-contract-v2.mjs',
]);

export const OWNED_CHANGED = Object.freeze([
  'tenant-billing-engine.mjs',
  'providers/parity/tenant-receivables.mjs',
]);

export const OWNED_MEMBERS = Object.freeze([...OWNED_ADDED, ...OWNED_CHANGED]);

export const PROTECTED_IDENTICAL = Object.freeze([
  'tenant-billing-destination.mjs',
  'tenant-billing-handlers.mjs',
  'app-services.mjs',
  'scheduled.mjs',
  'providers/parity/caller.mjs',
  'providers/parity/moov-functions.mjs',
  'providers/parity/moov-onboard.mjs',
  'providers/parity/moov-money.mjs',
  'write-allowlist.mjs',
  'write-app-metadata.mjs',
  'write.mjs',
  'workflow-rpc.mjs',
  'ocr-parse.mjs',
]);

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export const walkHashes = (dir, prefix = '', out = {}) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (rel === 'node_modules' || rel.startsWith('node_modules/')) continue;
      walkHashes(abs, rel, out);
      continue;
    }
    out[rel] = sha256(abs);
  }
  return out;
};

export function assertLiveAnchors(unpack) {
  const mismatches = [];
  for (const [rel, expected] of Object.entries(EXPECTED_LIVE_HASHES)) {
    const abs = path.join(unpack, rel);
    if (!fs.existsSync(abs)) {
      mismatches.push({ rel, expected, actual: null, reason: 'missing' });
      continue;
    }
    const actual = sha256(abs);
    if (actual !== expected) {
      mismatches.push({ rel, expected, actual, reason: 'hash_mismatch' });
    }
  }
  if (mismatches.length) {
    const err = new Error('LIVE_ANCHOR_MOVED: current live members do not match the accepted V2 hunk baseline; STOP');
    err.code = 'LIVE_ANCHOR_MOVED';
    err.mismatches = mismatches;
    throw err;
  }
  if (fs.existsSync(path.join(unpack, 'tenant-collection-v2.mjs'))) {
    const err = new Error('LIVE_ALREADY_HAS_V2: refuse to re-apply or restore');
    err.code = 'LIVE_ALREADY_HAS_V2';
    throw err;
  }
}

function applyUnifiedPatch(unpack, patchName) {
  const patchFile = path.join(PATCH_DIR, patchName);
  if (!fs.existsSync(patchFile)) {
    throw new Error(`missing accepted V2 hunk file: ${patchName}`);
  }
  execFileSync('patch', ['-p0', '--forward', '--silent', '-i', patchFile], {
    cwd: unpack,
    encoding: 'utf8',
  });
}

export function applyAcceptedV2Hunks(unpack) {
  assertLiveAnchors(unpack);

  for (const rel of OWNED_ADDED) {
    const from = path.join(SRC, rel);
    const to = path.join(unpack, rel);
    if (!fs.existsSync(from)) throw new Error(`missing accepted V2 source ${rel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  applyUnifiedPatch(unpack, 'tenant-billing-engine.mjs.patch');
  applyUnifiedPatch(unpack, 'tenant-receivables.mjs.patch');

  return {
    added: OWNED_ADDED.slice(),
    patched: OWNED_CHANGED.slice(),
  };
}

export function candidateManifest(liveHashes, candidateHashes) {
  const added = Object.keys(candidateHashes).filter((rel) => !liveHashes[rel]).sort();
  const deleted = Object.keys(liveHashes).filter((rel) => !candidateHashes[rel]).sort();
  const changed = Object.keys(liveHashes)
    .filter((rel) => candidateHashes[rel] && liveHashes[rel] !== candidateHashes[rel])
    .sort();
  const unexpectedChanged = changed.filter((rel) => !OWNED_CHANGED.includes(rel));
  const unexpectedAdded = added.filter((rel) => !OWNED_ADDED.includes(rel));
  const unexpectedDeleted = deleted.slice();
  const protectedProof = {};
  for (const rel of PROTECTED_IDENTICAL) {
    protectedProof[rel] = {
      live: liveHashes[rel] || null,
      candidate: candidateHashes[rel] || null,
      identical: Boolean(liveHashes[rel] && liveHashes[rel] === candidateHashes[rel]),
    };
  }
  return {
    added,
    deleted,
    changed,
    unexpectedAdded,
    unexpectedChanged,
    unexpectedDeleted,
    protectedProof,
    expected: unexpectedAdded.length === 0
      && unexpectedChanged.length === 0
      && unexpectedDeleted.length === 0
      && Object.values(protectedProof).every((row) => row.identical || row.live == null),
  };
}

export function applyOverlayToUnpack(unpack) {
  const liveHashes = walkHashes(unpack);
  const applied = applyAcceptedV2Hunks(unpack);
  const candidateHashes = walkHashes(unpack);
  const manifest = candidateManifest(liveHashes, candidateHashes);
  return { liveHashes, candidateHashes, applied, manifest };
}

export function downloadFreshLiveZip({
  functionName = FUNCTION_NAME,
  destZip,
  env = process.env,
} = {}) {
  const loc = execFileSync('aws', [
    '--region', env.AWS_REGION || 'us-east-1',
    'lambda', 'get-function',
    '--function-name', functionName,
    '--query', 'Code.Location',
    '--output', 'text',
  ], { encoding: 'utf8', env }).trim();
  execFileSync('curl', ['-fsSL', loc, '-o', destZip]);
  return destZip;
}

export function main({
  liveZip = process.argv[2],
  outZip = process.argv[3],
  env = process.env,
} = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-v2-prod-'));
  const zipPath = liveZip || path.join(work, 'live.zip');
  if (!liveZip) {
    downloadFreshLiveZip({ destZip: zipPath, env });
  } else if (!fs.existsSync(liveZip)) {
    throw new Error(`live zip not found: ${liveZip}`);
  }
  const unpack = path.join(work, 'unpack');
  fs.mkdirSync(unpack);
  execFileSync('unzip', ['-q', zipPath, '-d', unpack]);
  const result = applyOverlayToUnpack(unpack);
  if (!result.manifest.expected) {
    const err = new Error('UNEXPECTED_CANDIDATE_DIFF: stop; do not deploy');
    err.code = 'UNEXPECTED_CANDIDATE_DIFF';
    err.manifest = result.manifest;
    throw err;
  }
  const candidateZip = outZip || path.join(work, 'checksops-production-collection-v2.zip');
  execFileSync('zip', ['-qr', candidateZip, '.'], { cwd: unpack });
  const output = {
    function_name: FUNCTION_NAME,
    live_zip: path.resolve(zipPath),
    live_zip_sha256: sha256(zipPath),
    candidate_zip: path.resolve(candidateZip),
    candidate_zip_sha256: sha256(candidateZip),
    owned_members: OWNED_MEMBERS,
    applied: result.applied,
    manifest: {
      added: result.manifest.added,
      changed: result.manifest.changed,
      deleted: result.manifest.deleted,
      unexpectedAdded: result.manifest.unexpectedAdded,
      unexpectedChanged: result.manifest.unexpectedChanged,
      unexpectedDeleted: result.manifest.unexpectedDeleted,
      expected: result.manifest.expected,
      protectedProof: result.manifest.protectedProof,
      owned: Object.fromEntries(OWNED_MEMBERS.map((rel) => [rel, {
        live: result.liveHashes[rel] || null,
        candidate: result.candidateHashes[rel] || null,
      }])),
    },
    env_changed: false,
    sql: false,
    billing_activation: false,
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
      code: error.code || null,
      mismatches: error.mismatches || null,
      manifest: error.manifest || null,
    }, null, 2));
    process.exit(1);
  }
}
