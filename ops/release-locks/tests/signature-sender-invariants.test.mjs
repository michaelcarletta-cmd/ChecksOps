/**
 * Signature-sender release-lock contract.
 * Behavioral proof lives in aws/tests/signature-from-name.test.mjs and
 * aws/tests/signature-sender-production-freeze.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeOwnershipHashes,
  loadJson,
  matchProtectedPath,
  sha256File,
  validateReleaseLocks,
} from '../../../scripts/lib/release-locks.mjs';
import { loadReleaseLockInputs } from '../../../scripts/validate-release-locks.mjs';
import {
  HISTORICAL_PRE_FIX_ESIGN_SHA256,
  SIGNATURE_SENDER_SOURCE_PIN,
} from '../../../scripts/lib/signature-sender-freeze.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SIGNATURE_SENDER_PATHS = Object.freeze([
  'aws/functions/api/esign.mjs',
  'aws/audit/signature-sender-production-freeze.json',
  'scripts/lib/signature-sender-freeze.mjs',
  'aws/tests/signature-from-name.test.mjs',
  'aws/tests/signature-sender-production-freeze.test.mjs',
  'aws/tests/fixtures/historical-pre-fix-esign-37c5c742.mjs',
  'ops/release-locks/tests/signature-sender-invariants.test.mjs',
]);

test('signature-sender ownership group covers the accepted sender files', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const group = protectedPaths.ownership_groups['signature-sender'];
  assert.ok(group, 'signature-sender ownership group is required');
  assert.deepEqual([...group.paths].sort(), [...SIGNATURE_SENDER_PATHS].sort());

  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.deepEqual(hashes.groups['signature-sender'].files, [...SIGNATURE_SENDER_PATHS].sort());
  assert.equal(hashes.groups['signature-sender'].missing.length, 0);

  for (const rel of SIGNATURE_SENDER_PATHS) {
    const matches = matchProtectedPath(rel, protectedPaths);
    assert.ok(matches.some((row) => row.groupId === 'signature-sender'), `${rel} must belong to signature-sender`);
  }
});

test('signature-sender is source-locked and does not claim a whole-Lambda rollback pin', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components['signature-sender'];
  assert.ok(component, 'signature-sender manifest component is required');
  assert.equal(component.id, 'signature-sender');
  assert.equal(component.ownership_group, 'signature-sender');
  assert.equal(component.classification, 'SOURCE_LOCKED_NOT_ACTIVE');
  assert.equal(component.production_active, false);
  assert.equal(component.environment, 'production');
  assert.ok((component.required_sql || []).length === 0);
  assert.match(component.rollback.notes, /not a whole-Lambda rollback pin|do not restore historical/i);
  assert.equal(component.artifact.hash, SIGNATURE_SENDER_SOURCE_PIN.sha256);
  assert.ok((component.missing_evidence || []).some((row) => /whole-Lambda|PRODUCTION_LOCKED|rollback pin/i.test(row)));
});

test('accepted esign.mjs pin is live and historical pre-fix bytes remain rejected', () => {
  assert.equal(sha256File(path.join(ROOT, SIGNATURE_SENDER_SOURCE_PIN.path)), SIGNATURE_SENDER_SOURCE_PIN.sha256);
  assert.equal(
    sha256File(path.join(ROOT, 'aws/tests/fixtures/historical-pre-fix-esign-37c5c742.mjs')),
    HISTORICAL_PRE_FIX_ESIGN_SHA256,
  );
  const source = fs.readFileSync(path.join(ROOT, SIGNATURE_SENDER_SOURCE_PIN.path), 'utf8');
  assert.match(source, /export const signatureRequestFromHeader/);
  assert.match(source, /const mailFrom = signatureRequestFromHeader\(resolved\)/);
  assert.doesNotMatch(source, /const mailFrom = resolved\.from/);
});

test('signature-sender lock introduces no new validator errors', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors } = validateReleaseLocks(inputs);
  const senderErrors = errors.filter((row) => /signature-sender|esign\.mjs/.test(row));
  assert.deepEqual(senderErrors, []);
  assert.equal(
    errors.some((row) => /components\.production-release: protected source tree changed/.test(row)),
    false,
    'production-release tree_hash must be updated with this control-plane change',
  );
});
