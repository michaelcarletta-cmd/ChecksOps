import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_COMPAT_ENTRY_CONTRACTS,
  PRE_COMPAT_PROVENANCE_HASHES,
  assertImageCompatClaimCheck,
  assertImageCompatInvariants,
  assertImageCompatLambdaPins,
  assertImageCompatStorage,
  assertImageCompatStoragePaths,
  sha256Bytes,
} from '../../scripts/lib/image-compat-freeze.mjs';
import {
  assertAllowlistOnly,
  assertToctou,
  evaluateDeployGate,
  evaluateOverlayCandidate,
} from '../../scripts/lib/lambda-overlay-guard.mjs';
import { awsCodeSha256, overlayZip } from '../../scripts/lib/zip-package.mjs';
import { parseEnvText, assertProductionSpaBuild } from '../../scripts/lib/spa-production-build-guard.mjs';
import { main as lambdaCli } from '../../scripts/production-lambda-overlay-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const LIVE_ZIP = '/tmp/post-image-freeze/live-lambda.zip';
const PRE = '/tmp/pre-compat';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'image-compat-freeze-'));

const write = (dir, name, body) => {
  const dest = path.join(dir, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  return dest;
};

const makeZip = (dir, files, dest) => {
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(files)) write(src, name, body);
  execFileSync('python3', ['-c', `
import zipfile
z=zipfile.ZipFile(${JSON.stringify(dest)},'w')
${Object.keys(files).map((name) => `z.write(${JSON.stringify(path.join(src, name))}, ${JSON.stringify(name)})`).join('\n')}
z.close()
`]);
  return dest;
};

const old = (name) => fs.readFileSync(path.join(PRE, name), 'utf8');

test('substituting pre-compat storage.mjs fails the image-compat contract', () => {
  const source = old('storage.mjs');
  const hash = sha256Bytes(source);
  assert.equal(hash, PRE_COMPAT_PROVENANCE_HASHES['storage.mjs']);
  const result = assertImageCompatStorage(source, { hash });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /authorizeCleanStemSibling|pre-compat/);
});

test('substituting pre-compat storage-paths.mjs fails the image-compat contract', () => {
  const source = old('storage-paths.mjs');
  const hash = sha256Bytes(source);
  assert.equal(hash, PRE_COMPAT_PROVENANCE_HASHES['storage-paths.mjs']);
  const result = assertImageCompatStoragePaths(source, { hash });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /endorsedGeneratedStem|pre-compat/);
});

test('substituting old Claim Check / image recovery code fails the freeze', () => {
  const invariants = old('checkImageInvariants.ts');
  const ccc = old('CheckCommandCenter.tsx');
  const inv = assertImageCompatInvariants(invariants, { hash: sha256Bytes(invariants) });
  const claim = assertImageCompatClaimCheck(ccc, { hash: sha256Bytes(ccc) });
  assert.equal(inv.ok, false);
  assert.equal(claim.ok, false);
  assert.match(inv.errors.join(' '), /endorsedGeneratedStem|pre-compat|probeCleanStemPaths/);
  assert.match(claim.errors.join(' '), /probeCleanStemPaths|pre-compat/);
});

test('SPA built from staging .env.aws fails the production build guard', () => {
  const env = parseEnvText(fs.readFileSync(path.join(ROOT, '.env.aws'), 'utf8'));
  assert.equal(env.VITE_COGNITO_USER_POOL_ID, 'us-east-1_vPmQ7cL1F');
  assert.match(env.VITE_CHECKSOPS_API_URL, /psr19uhop4/);
  const result = assertProductionSpaBuild({
    mode: 'aws',
    env,
    argv: ['npx', 'vite', 'build', '--mode', 'aws'],
    entryJs: `const api=${JSON.stringify(env.VITE_CHECKSOPS_API_URL)};const pool="${env.VITE_COGNITO_USER_POOL_ID}"`,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /--mode aws/);
  assert.match(result.errors.join(' '), /staging Cognito|staging execute-api/);
});

test('unexpected non-allowlisted Lambda file change is rejected', () => {
  const result = assertAllowlistOnly(
    ['storage.mjs', 'workflow.mjs'],
    ['storage.mjs', 'storage-paths.mjs'],
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /workflow\.mjs/);
});

test('Lambda TOCTOU pin movement fails the deploy gate', () => {
  const sha = assertToctou(
    { CodeSha256: 'HzqcBPqWAtyIM61iEKHOdpfiO2lEPi8vWilo9xIcb9w=', RevisionId: '31295ac7-f358-49bd-b29f-0e984d20b37f' },
    { CodeSha256: 'HzqcBPqWAtyIM61iEKHOdpfiO2lEPi8vWilo9xIcb9w=', RevisionId: 'moved-revision' },
  );
  assert.equal(sha.ok, false);
  assert.match(sha.errors.join(' '), /RevisionId moved/);
  const code = assertToctou(
    { CodeSha256: 'HzqcBPqWAtyIM61iEKHOdpfiO2lEPi8vWilo9xIcb9w=', RevisionId: '31295ac7-f358-49bd-b29f-0e984d20b37f' },
    { CodeSha256: 'Z5PR5OcmZSyiSPQxn6yYbuCd3jZK5F/NDrQnyF9A3U8=', RevisionId: '31295ac7-f358-49bd-b29f-0e984d20b37f' },
  );
  assert.equal(code.ok, false);
  assert.match(code.errors.join(' '), /CodeSha256 moved/);
});

test('overlaying old storage.mjs onto current live package fails image-compat even when allowlisted', (t) => {
  if (!fs.existsSync(LIVE_ZIP) || !fs.existsSync(path.join(PRE, 'storage.mjs'))) {
    t.skip('live production zip or pre-compat fixture not present');
    return;
  }
  const dir = tmp();
  const dest = path.join(dir, 'cand.zip');
  overlayZip({
    baseZip: LIVE_ZIP,
    destZip: dest,
    replacements: { 'storage.mjs': path.join(PRE, 'storage.mjs') },
  });
  const result = evaluateOverlayCandidate({
    liveZip: LIVE_ZIP,
    candidateZip: dest,
    allowlist: ['storage.mjs'],
    entryContracts: IMAGE_COMPAT_ENTRY_CONTRACTS,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /authorizeCleanStemSibling|pre-compat|CLEAN_STEM/);
  const hashes = JSON.parse(execFileSync('python3', [
    path.join(ROOT, 'scripts/lib/zip-package.py'), 'hashes', dest,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const pins = assertImageCompatLambdaPins(hashes);
  assert.equal(pins.ok, false);
});

test('overlaying old storage-paths.mjs onto current live package fails image-compat', (t) => {
  if (!fs.existsSync(LIVE_ZIP) || !fs.existsSync(path.join(PRE, 'storage-paths.mjs'))) {
    t.skip('live production zip or pre-compat fixture not present');
    return;
  }
  const dir = tmp();
  const dest = path.join(dir, 'cand.zip');
  overlayZip({
    baseZip: LIVE_ZIP,
    destZip: dest,
    replacements: { 'storage-paths.mjs': path.join(PRE, 'storage-paths.mjs') },
  });
  const result = evaluateOverlayCandidate({
    liveZip: LIVE_ZIP,
    candidateZip: dest,
    allowlist: ['storage-paths.mjs'],
    entryContracts: IMAGE_COMPAT_ENTRY_CONTRACTS,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /endorsedGeneratedStem|pre-compat|isNarrowCleanStemPath/);
});

test('CLI deploy-gate fails when current-live TOCTOU pins move', () => {
  const dir = tmp();
  const live = makeZip(dir, { 'storage.mjs': 'new', 'keep.mjs': 'keep' }, path.join(dir, 'live.zip'));
  const cand = makeZip(dir, { 'storage.mjs': 'new', 'keep.mjs': 'keep' }, path.join(dir, 'cand.zip'));
  write(dir, 'captured.json', JSON.stringify({
    CodeSha256: awsCodeSha256(live),
    RevisionId: '31295ac7-f358-49bd-b29f-0e984d20b37f',
  }));
  write(dir, 'livenow.json', JSON.stringify({
    CodeSha256: awsCodeSha256(live),
    RevisionId: 'moved-before-write',
  }));
  const code = lambdaCli([
    '--deploy-gate',
    '--live-zip', live,
    '--candidate-zip', cand,
    '--allowlist', 'storage.mjs',
    '--captured', path.join(dir, 'captured.json'),
    '--live-now', path.join(dir, 'livenow.json'),
  ]);
  assert.equal(code, 1);
  const gate = evaluateDeployGate({
    captured: { CodeSha256: awsCodeSha256(live), RevisionId: '31295ac7-f358-49bd-b29f-0e984d20b37f' },
    liveNow: { CodeSha256: 'other', RevisionId: '31295ac7-f358-49bd-b29f-0e984d20b37f' },
    liveZip: live,
    candidateZip: cand,
    allowlist: ['storage.mjs'],
  });
  assert.equal(gate.ok, false);
  assert.match(gate.errors.join(' '), /CodeSha256 moved|stale production ZIP/);
});

test('unexpected extra file in a synthetic overlay fails allowlist', () => {
  const dir = tmp();
  const live = makeZip(dir, { a: '1', b: '2', c: '3' }, path.join(dir, 'live.zip'));
  const cand = makeZip(dir, { a: '1', b: 'changed', c: 'changed-too' }, path.join(dir, 'cand.zip'));
  const result = evaluateOverlayCandidate({
    liveZip: live,
    candidateZip: cand,
    allowlist: ['b'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /unauthorized file differs: c/);
});
