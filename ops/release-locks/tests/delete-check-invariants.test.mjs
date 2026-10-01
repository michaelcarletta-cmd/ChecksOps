/**
 * Delete Check production contract lock.
 *
 * Behavioral proof lives in frontend bridge/unit tests.
 *
 * This file is a thin contract test that pins the accepted capability markers
 * so future overlays cannot silently regress the Delete Check contract without
 * an intentional lock update.
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
  validateReleaseLocks,
} from '../../../scripts/lib/release-locks.mjs';
import { loadReleaseLockInputs } from '../../../scripts/validate-release-locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const DELETE_CHECK_FILES = Object.freeze([
  'src/integrations/aws/deleteCheckBridge.ts',
  'src/integrations/aws/client.ts',
  'src/components/checks/AdminDeleteCheckButton.tsx',
  'ops/release-locks/contracts/delete-check-contract.json',
  'ops/release-locks/proof/delete-check-production-acceptance-2026-09-26.md',
]);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('delete-check-contract ownership group is narrowly scoped', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const group = protectedPaths.ownership_groups['delete-check-contract'];
  assert.ok(group, 'delete-check-contract ownership group is required');
  assert.deepEqual([...group.paths].sort(), [...DELETE_CHECK_FILES].sort());

  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.deepEqual(hashes.groups['delete-check-contract'].files, [...DELETE_CHECK_FILES].sort());
  assert.equal(hashes.groups['delete-check-contract'].missing.length, 0);

  for (const rel of DELETE_CHECK_FILES) {
    const matches = matchProtectedPath(rel, protectedPaths);
    assert.ok(
      matches.some((row) => row.groupId === 'delete-check-contract'),
      `${rel} must belong to delete-check-contract`,
    );
  }
});

test('delete-check-contract manifest component exists and pins the protected tree hash', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components['delete-check-contract'];
  assert.ok(component, 'delete-check-contract manifest component is required');
  assert.equal(component.id, 'delete-check-contract');
  assert.equal(component.ownership_group, 'delete-check-contract');
  assert.equal(component.classification, 'UNVERIFIED');
  assert.equal(component.production_active, false);
  assert.equal(component.environment, 'production');
  assert.equal(component.source.git_sha, 'f5d616431642ce5938827379c9221c822fea5bf3');
  assert.equal(component.source.merged, false);
  assert.equal(component.source.merged_pr, 501);
  assert.ok(Array.isArray(component.required_sql));
  assert.equal(component.required_sql.length, 0);
  assert.ok(
    (component.production_validation?.evidence_refs || [])
      .includes('ops/release-locks/proof/delete-check-production-acceptance-2026-09-26.md'),
  );

  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.equal(component.source.tree_hash, hashes.groups['delete-check-contract'].tree_hash);
});

test('delete-check-contract records accepted production provenance', () => {
  const contract = loadJson(path.join(ROOT, 'ops/release-locks/contracts/delete-check-contract.json'));
  assert.equal(contract.version, 1);
  assert.ok(Array.isArray(contract.invariants));
  assert.ok(contract.invariants.includes('bridge_forwards_trimmed_reason'));
});

test('Delete Check capability markers remain intact (bridge + dispatcher)', () => {
  const bridge = read('src/integrations/aws/deleteCheckBridge.ts');
  const client = read('src/integrations/aws/client.ts');

  // 1. Frontend/RPC bridge forwards trimmed reason (and is tested).
  assert.match(bridge, /String\(reasonRaw\)\.trim\(\)/);
  assert.match(bridge, /if \(reason\.length\) body\.reason = reason;/);

  // 2. Dispatcher invariant: the actual runtime dispatch in client.ts must forward deleteBody (not {check_id} only).
  assert.match(client, /import \{ buildWorkflowDeleteCheckBody \} from "\.\/deleteCheckBridge";/);
  assert.match(client, /if \(name === "admin_delete_check"\) \{/);
  assert.match(client, /const \{ checkId, body: deleteBody \} = buildWorkflowDeleteCheckBody\(args\);/);
  assert.match(client, /body:\s*JSON\.stringify\(deleteBody\)/);
  assert.doesNotMatch(client, /JSON\.stringify\(\{\s*check_id\s*:\s*checkId\s*\}\)/);

  // 3. UI passes a trimmed reason (min length validation remains UI-side).
  const button = read('src/components/checks/AdminDeleteCheckButton.tsx');
  assert.match(button, /const trimmed = reason\.trim\(\);/);
  assert.match(button, /const reasonValid = trimmed\.length >= 3;/);
  assert.match(button, /p_reason:\s*trimmed/);
});

test('delete-check lock introduces no new validator errors for this component', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors } = validateReleaseLocks(inputs);
  const scoped = errors.filter((row) => /delete-check-contract|deleteCheckBridge|handleDeleteCheck|delete-check-production-acceptance/i.test(row));
  assert.deepEqual(scoped, []);
  assert.equal(
    errors.some((row) => /components\.production-release: protected source tree changed/.test(row)),
    false,
    'production-release tree_hash must be updated with this control-plane change',
  );
});

