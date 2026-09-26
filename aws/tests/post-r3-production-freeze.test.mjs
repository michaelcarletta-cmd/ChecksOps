import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const r3 = JSON.parse(readFileSync(path.join(ROOT, 'aws/audit/post-r3-production-freeze.json'), 'utf8'));
const current = JSON.parse(readFileSync(path.join(ROOT, 'aws/audit/post-image-production-freeze.json'), 'utf8'));
const r3doc = readFileSync(path.join(ROOT, 'aws/audit/POST_R3_PRODUCTION_FREEZE.md'), 'utf8');

test('R3 freeze pins are provenance only and are not the current live authority', () => {
  assert.equal(r3.lambda.CodeSha256, 'o/U/pbZ2FR38T3HI6A6kUxp9wik4pci92KmEVfmhF6I=');
  assert.equal(r3.lambda.package_sha256, 'a3f53fa5b676151dfc4f71c8e80ea4531a7dc22938a5c8bdd8a98455f9a117a2');
  assert.equal(r3.lambda.RevisionId, '470ad806-c710-415b-8f93-59232d8ee13c');
  assert.notEqual(r3.lambda.CodeSha256, current.lambda.CodeSha256);
  assert.notEqual(r3.spa.current_live.index_sha256, current.spa.current_live.index_sha256);
  assert.match(r3doc, /SUPERSEDED as current-live authority/);
  assert.match(JSON.stringify(current.provenance_not_deployment_baselines), /o\/U\/pbZ2FR38T3HI6A6kUxp9wik4pci92KmEVfmhF6I=/);
});

test('newer billing and R3 files remain recorded on the historical R3 freeze', () => {
  assert.equal(
    r3.protected_files['tenant-billing-engine.mjs'],
    'f17199aaf630d015313ea80ab4cdf5d19af0b7fb6e189833587a36471453605d',
  );
  assert.equal(
    r3.protected_files['ocr-parse.mjs'],
    '16c15529f9bb4d975baa31ba5cbe824dd3eee4bd984487f7e4717b77c8878ede',
  );
});

test('SQL migration 42 must not be reapplied', () => {
  assert.equal(r3.sql_invariants.ocr_persist_extracted_amount.reapply_forbidden, true);
  assert.equal(current.sql_invariants.ocr_persist_extracted_amount.reapply_forbidden, true);
});

test('historical R1 SPA pin is not the current live index', () => {
  const r1 = r3.provenance_not_deployment_baselines['accepted_r1_spa_at_2026-09-25T17:19:12Z'];
  assert.equal(r1.index, 'ffa6c8354fc6aae86e5f684bdd1025012a2fc59a407424b87fd22d12fac70baf');
  assert.notEqual(current.spa.current_live.index_sha256, r1.index);
});

test('safeguards still prohibit sync --delete and require index-last / start-from-live', () => {
  assert.equal(r3.safeguards.s3_sync_delete_prohibited, true);
  assert.equal(current.safeguards.s3_sync_delete_prohibited, true);
  assert.equal(current.safeguards.index_last, true);
  assert.equal(current.safeguards.start_from_current_live, true);
  assert.equal(current.production_application_state_changed_by_this_workstream, false);
});
