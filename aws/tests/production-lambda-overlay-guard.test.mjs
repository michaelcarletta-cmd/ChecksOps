import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
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
import { awsCodeSha256, overlayZip, sha256File } from '../../scripts/lib/zip-package.mjs';
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
  'identity-env.mjs': 'R2 lock bindProductionCognitoLock',
  'tenant-admin.mjs': 'invite fail-closed',
  'workflow.mjs': 'admin_delete_check',
  'workflow-rpc.mjs': 'delete rpc',
  'endorsement-material-invalidation.mjs': 'S2',
  'financial-idempotency.mjs': 'S11',
  'check-deposited.mjs': 'S14',
  'tenant-billing-engine.mjs': 'monthly engine',
  'tenant-billing-handlers.mjs': 'monthly handlers',
  'ocr-parse.mjs': 'R3 parse',
});

test('protected file change unexpectedly fails', () => {
  const dir = tmp();
  const live = makeZip(dir, protectedFiles(), path.join(dir, 'live.zip'));
  const hashes = JSON.parse(execFileSync('python3', [
    path.join(REPO, 'scripts/lib/zip-package.py'), 'hashes', live,
  ], { encoding: 'utf8' }));
  const mutated = { ...protectedFiles(), 'identity-env.mjs': 'tampered' };
  const cand = makeZip(dir, mutated, path.join(dir, 'cand.zip'));
  const candHashes = JSON.parse(execFileSync('python3', [
    path.join(REPO, 'scripts/lib/zip-package.py'), 'hashes', cand,
  ], { encoding: 'utf8' }));
  const result = assertProtectedHashes(candHashes, hashes);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /identity-env/);
});

test('unauthorized fourth Lambda file fails the allowlist', () => {
  const result = assertAllowlistOnly(
    ['ocr-parse.mjs', 'ocr-descriptive-persist.mjs', 'check-ocr-provider.mjs', 'workflow.mjs'],
    ['ocr-parse.mjs', 'ocr-descriptive-persist.mjs', 'check-ocr-provider.mjs'],
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

test('authorized overlay of one file PASSES and keeps protected files', () => {
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

test('CLI --check-candidate fails an unauthorized extra file', () => {
  const dir = tmp();
  const live = makeZip(dir, { a: '1', b: '2' }, path.join(dir, 'live.zip'));
  const cand = makeZip(dir, { a: '1', b: 'changed' }, path.join(dir, 'cand.zip'));
  const code = lambdaCli([
    '--check-candidate',
    '--live-zip', live,
    '--candidate-zip', cand,
    '--allowlist', 'a',
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

test('accepted R3 production ZIP is a no-op overlay PASS when present', (t) => {
  const accepted = '/opt/cursor/artifacts/r3-production-promotion/prod-deployed-after-r3.zip';
  if (!fs.existsSync(accepted)) {
    t.skip('accepted R3 artifact not present in this environment');
    return;
  }
  const result = evaluateOverlayCandidate({
    liveZip: accepted,
    candidateZip: accepted,
    allowlist: [],
  });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.changed, []);
  assert.equal(result.candidateZipSha256, sha256File(accepted));
  assert.equal(result.candidateCodeSha256, 'o/U/pbZ2FR38T3HI6A6kUxp9wik4pci92KmEVfmhF6I=');
});
