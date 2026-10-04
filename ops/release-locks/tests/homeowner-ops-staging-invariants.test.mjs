/**
 * Thin Homeowner Ops staging lock contract.
 * Behavioral proof stays in aws/tests/homeowner-ops-staging-baseline.test.mjs
 * and the existing SQL71/72/73 ledger tests.
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
} from '../../../scripts/lib/release-locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const HOMEOWNER_PATHS = Object.freeze([
  'aws/tests/homeowner-ops-staging-baseline.test.mjs',
  'aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql',
  'ops/deployment-guard/homeowner-check-signing-plan.md',
  'ops/deployment-guard/homeowner-ops-staging-accepted.json',
  'ops/release-locks/proof/homeowner-ops-staging-baseline.md',
  'ops/release-locks/tests/homeowner-ops-staging-invariants.test.mjs',
]);

test('homeowner-ops-staging ownership group covers the accepted portal pin only', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const group = protectedPaths.ownership_groups['homeowner-ops-staging'];
  assert.ok(group, 'homeowner-ops-staging ownership group is required');
  assert.deepEqual([...group.paths].sort(), [...HOMEOWNER_PATHS].sort());

  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.deepEqual(hashes.groups['homeowner-ops-staging'].files, [...HOMEOWNER_PATHS].sort());
  assert.equal(hashes.groups['homeowner-ops-staging'].missing.length, 0);

  for (const rel of HOMEOWNER_PATHS) {
    const matches = matchProtectedPath(rel, protectedPaths);
    assert.ok(matches.some((row) => row.groupId === 'homeowner-ops-staging'), `${rel} must belong to homeowner-ops-staging`);
  }
});

test('homeowner-ops-staging is STAGING_LOCKED_NOT_PRODUCTION and not production-active', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components['homeowner-ops-staging'];
  assert.ok(component, 'homeowner-ops-staging manifest component is required');
  assert.equal(component.id, 'homeowner-ops-staging');
  assert.equal(component.ownership_group, 'homeowner-ops-staging');
  assert.equal(component.classification, 'STAGING_LOCKED_NOT_PRODUCTION');
  assert.equal(component.production_active, false);
  assert.equal(component.environment, 'staging');
  assert.equal(component.required_sql.length, 1);
  assert.equal(
    component.required_sql[0].path,
    'aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql',
  );
  assert.equal(component.required_sql[0].applied, true);
  assert.equal(component.required_sql[0].applied_environment, 'staging');
  assert.ok(component.production_validation.evidence_refs.some((ref) => /staging/i.test(ref)));
  assert.equal(component.deployment_fingerprint.recorded, true);
  assert.equal(component.deployment_fingerprint.spa_bundle, '/assets/index-BomgsBaq.js');
  assert.match(component.notes, /forward change/i);
});
