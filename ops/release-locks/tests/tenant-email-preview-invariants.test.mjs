/**
 * Tenant Email Preview release-lock contract.
 * Pins capability markers so a future PR cannot silently drop the accepted
 * preview after updating tree_hash. TenantBrandingSettings.tsx is mount-
 * tested only and is not wholly owned by this group.
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
import {
  ACCEPTED_PRODUCTION_SPA,
  EMAIL_PREVIEW_MOUNT_FILE,
  EMAIL_PREVIEW_SOURCE_PINS,
  FUTURE_OVERLAY_RULES,
  HISTORICAL_R4A_SPA,
  REJECTED_HISTORICAL_ESIGN_SHA256,
  assertEmailPreviewSourcePins,
  assertFromContract,
  assertHistoricalSpaCannotSatisfy,
  assertPreviewMount,
  assertRejectedHistoricalEsign,
  sha256Bytes,
} from '../../../scripts/lib/tenant-email-preview-freeze.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PREVIEW_OWNED = Object.freeze([
  'src/lib/signatureRequestSender.ts',
  'src/components/settings/SignatureRequestEmailPreview.tsx',
  'scripts/lib/tenant-email-preview-freeze.mjs',
  'aws/audit/tenant-email-preview-production-freeze.json',
  'aws/tests/tenant-email-preview-production-freeze.test.mjs',
  'tests/signature-request-email-preview.test.mjs',
]);

test('tenant-email-preview ownership covers dedicated preview files, not all Branding Settings', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const group = protectedPaths.ownership_groups['tenant-email-preview'];
  assert.ok(group, 'tenant-email-preview ownership group is required');
  assert.deepEqual([...group.paths].sort(), [...PREVIEW_OWNED].sort());
  assert.ok(!group.paths.includes(EMAIL_PREVIEW_MOUNT_FILE));

  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.deepEqual(hashes.groups['tenant-email-preview'].files, [...PREVIEW_OWNED].sort());
  assert.equal(hashes.groups['tenant-email-preview'].missing.length, 0);

  for (const rel of PREVIEW_OWNED) {
    const matches = matchProtectedPath(rel, protectedPaths);
    assert.ok(matches.some((row) => row.groupId === 'tenant-email-preview'), `${rel} must belong to tenant-email-preview`);
  }

  const mountMatches = matchProtectedPath(EMAIL_PREVIEW_MOUNT_FILE, protectedPaths);
  assert.ok(
    !mountMatches.some((row) => row.groupId === 'tenant-email-preview'),
    'TenantBrandingSettings.tsx must not be wholly owned; mount is contract-tested only',
  );
});

test('tenant-email-preview is source-locked; SPA SHA is provenance not a rollback pin', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components['tenant-email-preview'];
  assert.ok(component, 'tenant-email-preview manifest component is required');
  assert.equal(component.id, 'tenant-email-preview');
  assert.equal(component.ownership_group, 'tenant-email-preview');
  assert.equal(component.classification, 'SOURCE_LOCKED_NOT_ACTIVE');
  assert.equal(component.production_active, false);
  assert.equal(component.environment, 'production');
  assert.equal(component.artifact.type, 'spa');
  assert.equal(component.artifact.hash, ACCEPTED_PRODUCTION_SPA.sha256);
  assert.match(component.rollback.notes, /provenance/i);
  assert.match(component.rollback.notes, /6b211037ae70b510a9b5cfe316f006dbbc308ee3c94687ccea943b24cfd09f2e/);
  assert.ok((component.required_sql || []).length === 0);
  assert.ok((component.missing_evidence || []).some((row) => /provenance|rollback pin/i.test(row)));
});

test('Email Preview contract markers remain intact without locking unrelated branding work', () => {
  const pins = assertEmailPreviewSourcePins(ROOT);
  assert.equal(pins.ok, true, pins.errors.join('\n'));
  assert.equal(assertFromContract('Freedom Adjustment', 'Freedom Adjustment <support@checksops.com>').ok, true);
  assert.equal(assertPreviewMount(read(EMAIL_PREVIEW_MOUNT_FILE)).ok, true);
  assert.equal(FUTURE_OVERLAY_RULES.start_from_then_current_live_spa, true);
  assert.equal(FUTURE_OVERLAY_RULES.sha_version_are_provenance_not_rollback_pins, true);
  assert.equal(FUTURE_OVERLAY_RULES.historical_r4a_spa_must_not_auto_replace, true);
});

test('historical R4A SPA and pre-fix esign cannot silently satisfy this lock', () => {
  const oldSpa = assertHistoricalSpaCannotSatisfy({
    sha256: HISTORICAL_R4A_SPA.sha256,
    source: 'Branding & Appearance without preview',
  });
  assert.equal(oldSpa.ok, false);
  const esign = read('aws/functions/api/esign.mjs');
  assert.equal(sha256Bytes(esign), REJECTED_HISTORICAL_ESIGN_SHA256);
  const rejected = assertRejectedHistoricalEsign(REJECTED_HISTORICAL_ESIGN_SHA256, esign);
  assert.equal(rejected.ok, false);
});

test('tenant-email-preview lock introduces no new validator errors for this component', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors } = validateReleaseLocks(inputs);
  const previewErrors = errors.filter((row) => /tenant-email-preview/.test(row));
  assert.deepEqual(previewErrors, []);
  assert.equal(
    errors.some((row) => /components\.production-release: protected source tree changed/.test(row)),
    false,
    'production-release tree_hash must be updated with this control-plane change',
  );
});
