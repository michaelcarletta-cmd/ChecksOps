import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PROTECTED_FILE_LABELS,
  assertAllowlistOnly,
  assertLiveBase,
  assertNoConfigurationUpdate,
  assertProtectedHashes,
  assertToctou,
  buildOverlayCandidate,
  evaluateDeployGate,
  evaluateOverlayCandidate,
  evaluatePostDeploy,
} from '../../scripts/lib/lambda-overlay-guard.mjs';
import { SIGNATURE_SENDER_ENTRY_CONTRACTS } from '../../scripts/lib/signature-sender-freeze.mjs';
import { awsCodeSha256 } from '../../scripts/lib/zip-package.mjs';
import { main as lambdaCli } from '../../scripts/production-lambda-overlay-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '../..');

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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-guard-'));

const protectedFiles = () => ({
  'esign.mjs': fs.readFileSync(path.join(REPO, 'aws/functions/api/esign.mjs')),
  'identity-env.mjs': 'R2 lock bindProductionCognitoLock',
  'tenant-admin.mjs': 'invite fail-closed',
  'workflow.mjs': 'admin_delete_check',
  'ocr-parse.mjs': 'R3 parse',
});

test('esign.mjs is part of the overlay protected set', () => {
  assert.equal(PROTECTED_FILE_LABELS['esign.mjs'].includes('signature-request'), true);
});

test('protected file change unexpectedly fails', () => {
  const dir = tmp();
  const live = makeZip(dir, protectedFiles(), path.join(dir, 'live.zip'));
  const hashes = JSON.parse(execFileSync('python3', [
    path.join(REPO, 'scripts/lib/zip-package.py'), 'hashes', live,
  ], { encoding: 'utf8' }));
  const mutated = { ...protectedFiles(), 'esign.mjs': 'tampered' };
  const cand = makeZip(dir, mutated, path.join(dir, 'cand.zip'));
  const candHashes = JSON.parse(execFileSync('python3', [
    path.join(REPO, 'scripts/lib/zip-package.py'), 'hashes', cand,
  ], { encoding: 'utf8' }));
  const result = assertProtectedHashes(candHashes, hashes);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /esign\.mjs/);
});

test('unauthorized fourth Lambda file fails the allowlist', () => {
  const result = assertAllowlistOnly(
    ['ocr-parse.mjs', 'workflow.mjs'],
    ['ocr-parse.mjs'],
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /workflow\.mjs/);
});

test('CodeSha256 change between capture and deploy fails TOCTOU', () => {
  const result = assertToctou(
    { CodeSha256: 'AAA=', RevisionId: 'rev-1' },
    { CodeSha256: 'BBB=', RevisionId: 'rev-1' },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /CodeSha256 moved/);
});

test('RevisionId change fails TOCTOU even when CodeSha256 matches', () => {
  const result = assertToctou(
    { CodeSha256: 'AAA=', RevisionId: 'rev-1' },
    { CodeSha256: 'AAA=', RevisionId: 'rev-2' },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /RevisionId moved/);
});

test('candidate built from an old production ZIP fails live-base check', () => {
  const dir = tmp();
  const oldZip = makeZip(dir, { 'a.mjs': 'old' }, path.join(dir, 'old.zip'));
  const liveZip = makeZip(dir, { 'a.mjs': 'new' }, path.join(dir, 'live.zip'));
  const result = assertLiveBase(oldZip, { CodeSha256: awsCodeSha256(liveZip) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /stale production ZIP/);
});

test('UpdateFunctionConfiguration is refused', () => {
  const result = assertNoConfigurationUpdate('UpdateFunctionConfiguration');
  assert.equal(result.ok, false);
});

test('authorized overlay of one non-esign file PASSES and keeps esign.mjs', () => {
  const dir = tmp();
  const files = protectedFiles();
  const live = makeZip(dir, files, path.join(dir, 'live.zip'));
  const hashes = JSON.parse(execFileSync('python3', [
    path.join(REPO, 'scripts/lib/zip-package.py'), 'hashes', live,
  ], { encoding: 'utf8' }));
  const replacement = write(dir, 'ocr-parse.mjs', 'R3 parse v2');
  const dest = path.join(dir, 'cand.zip');
  const pin = { CodeSha256: awsCodeSha256(live), RevisionId: 'rev-1' };
  const built = buildOverlayCandidate({
    liveZip: live,
    destZip: dest,
    replacements: { 'ocr-parse.mjs': replacement },
    allowlist: ['ocr-parse.mjs'],
    protectedHashes: hashes,
    livePin: pin,
    entryContracts: SIGNATURE_SENDER_ENTRY_CONTRACTS,
  });
  assert.equal(built.ok, true, built.errors.join('\n'));
  assert.deepEqual(built.changed, ['ocr-parse.mjs']);
  const gate = evaluateDeployGate({
    captured: pin,
    liveNow: pin,
    liveZip: live,
    candidateZip: dest,
    allowlist: ['ocr-parse.mjs'],
    protectedHashes: hashes,
    entryContracts: SIGNATURE_SENDER_ENTRY_CONTRACTS,
  });
  assert.equal(gate.ok, true, gate.errors.join('\n'));
  const post = evaluatePostDeploy({
    deployedZip: dest,
    candidateZip: dest,
    liveZipBefore: live,
    allowlist: ['ocr-parse.mjs'],
  });
  assert.equal(post.ok, true, post.errors.join('\n'));
});

test('CLI --check-candidate fails an unauthorized esign.mjs change', () => {
  const dir = tmp();
  const live = makeZip(dir, { 'esign.mjs': fs.readFileSync(path.join(REPO, 'aws/functions/api/esign.mjs')), b: '2' }, path.join(dir, 'live.zip'));
  const cand = makeZip(dir, { 'esign.mjs': 'changed', b: '2' }, path.join(dir, 'cand.zip'));
  const code = lambdaCli([
    '--check-candidate',
    '--live-zip', live,
    '--candidate-zip', cand,
    '--allowlist', 'b',
  ]);
  assert.equal(code, 1);
});

test('CLI deploy-gate fails when RevisionId moved', () => {
  const dir = tmp();
  const live = makeZip(dir, { a: '1' }, path.join(dir, 'live.zip'));
  const cand = makeZip(dir, { a: '1' }, path.join(dir, 'cand.zip'));
  write(dir, 'captured.json', JSON.stringify({ CodeSha256: awsCodeSha256(live), RevisionId: 'r1' }));
  write(dir, 'livenow.json', JSON.stringify({ CodeSha256: awsCodeSha256(live), RevisionId: 'r2' }));
  const code = lambdaCli([
    '--deploy-gate',
    '--live-zip', live,
    '--candidate-zip', cand,
    '--allowlist', '',
    '--captured', path.join(dir, 'captured.json'),
    '--live-now', path.join(dir, 'livenow.json'),
  ]);
  assert.equal(code, 1);
});

test('no-op overlay of identical packages PASSES', () => {
  const dir = tmp();
  const files = protectedFiles();
  const live = makeZip(dir, files, path.join(dir, 'live.zip'));
  const result = evaluateOverlayCandidate({
    liveZip: live,
    candidateZip: live,
    allowlist: [],
    entryContracts: SIGNATURE_SENDER_ENTRY_CONTRACTS,
  });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.changed, []);
});
