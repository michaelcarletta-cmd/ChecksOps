import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const freeze = JSON.parse(readFileSync(path.join(ROOT, 'aws/audit/post-r3-production-freeze.json'), 'utf8'));

test('freeze pins current live Lambda, not obsolete hashes', () => {
  assert.equal(freeze.lambda.CodeSha256, 'o/U/pbZ2FR38T3HI6A6kUxp9wik4pci92KmEVfmhF6I=');
  assert.equal(freeze.lambda.package_sha256, 'a3f53fa5b676151dfc4f71c8e80ea4531a7dc22938a5c8bdd8a98455f9a117a2');
  assert.equal(freeze.lambda.RevisionId, '470ad806-c710-415b-8f93-59232d8ee13c');
  assert.match(JSON.stringify(freeze.provenance_not_deployment_baselines), /KdqRSV|DMWpDQ|bae57b/);
});

test('newer billing and R3 files are the live protected hashes', () => {
  assert.equal(
    freeze.protected_files['tenant-billing-engine.mjs'],
    'f17199aaf630d015313ea80ab4cdf5d19af0b7fb6e189833587a36471453605d',
  );
  assert.equal(
    freeze.protected_files['tenant-billing-handlers.mjs'],
    'd64c7538317d6b20df6a28e3551cfec73cdc60ab47546e8d8059951c87b423e1',
  );
  assert.equal(
    freeze.protected_files['ocr-parse.mjs'],
    '16c15529f9bb4d975baa31ba5cbe824dd3eee4bd984487f7e4717b77c8878ede',
  );
});

test('SQL migration 42 must not be reapplied', () => {
  assert.equal(freeze.sql_invariants.ocr_persist_extracted_amount.reapply_forbidden, true);
  assert.equal(freeze.sql_invariants.ocr_persist_extracted_amount.present_in_production, true);
});

test('current live SPA pin is not the superseded R1 index', () => {
  const r1 = freeze.provenance_not_deployment_baselines['accepted_r1_spa_at_2026-09-25T17:19:12Z'];
  assert.equal(freeze.spa.current_live.missing_count, 0);
  assert.equal(freeze.spa.current_live.cloudfront_failures, 0);
  assert.equal(freeze.spa.objects.length, 102);
  assert.equal(r1.index, 'ffa6c8354fc6aae86e5f684bdd1025012a2fc59a407424b87fd22d12fac70baf');
  assert.notEqual(freeze.spa.current_live.index_sha256, r1.index);
});

test('safeguards prohibit sync --delete and require index-last', () => {
  assert.equal(freeze.safeguards.s3_sync_delete_prohibited, true);
  assert.equal(freeze.safeguards.index_last, true);
  assert.equal(freeze.safeguards.start_from_current_live, true);
  assert.equal(freeze.production_application_state_changed_by_this_workstream, false);
});
