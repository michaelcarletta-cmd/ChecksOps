import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUTHORIZED_SQL53 } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'ops/deployment-guard/sql53-staging-execute-applied.json'),
  'utf8',
));

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('SQL 53 staging apply evidence records a committed staging-only invoke', () => {
  assert.equal(EVIDENCE.sql_committed, true);
  assert.equal(EVIDENCE.target_environment, 'staging');
  assert.equal(EVIDENCE.deployment_type, 'sql-executor-invoke');
  assert.equal(EVIDENCE.function_name, 'checksops-staging-guarded-sql-executor');
  assert.equal(EVIDENCE.commit, AUTHORIZED_SQL53.commit);
  assert.equal(EVIDENCE.source_sha256, AUTHORIZED_SQL53.source_sha256);
  assert.equal(sha256File(path.join(ROOT, AUTHORIZED_SQL53.filename)), AUTHORIZED_SQL53.source_sha256);
  assert.equal(EVIDENCE.apply.result, 'applied');
  assert.equal(EVIDENCE.apply.after_hash, AUTHORIZED_SQL53.intended_replacement_sha256);
  assert.equal(EVIDENCE.inspect_after.exists, true);
  assert.equal(EVIDENCE.inspect_after.live_definition_sha256, AUTHORIZED_SQL53.intended_replacement_sha256);
  assert.equal(EVIDENCE.production_changes, false);
  assert.equal(EVIDENCE.lambda_code_updated, false);
  assert.equal(EVIDENCE.release_lock_changes, false);
  assert.equal(EVIDENCE.phase2_authorized, false);
  assert.equal(EVIDENCE.unrelated_sql, false);
});

test('SQL 53 apply evidence withholds EXECUTED_AND_VERIFIED until the official HTTP diagnostic reruns', () => {
  assert.equal(EVIDENCE.verdict, 'BLOCKED');
  assert.equal(EVIDENCE.post_apply_http_diagnostic.ran, false);
  assert.equal(EVIDENCE.post_apply_http_diagnostic.script_classification, 'staging_identity_unavailable');
  assert.equal(
    EVIDENCE.post_apply_http_diagnostic.columns_and_triggers_post_apply,
    'unconfirmed_by_official_http_diagnostic',
  );
  assert.equal(
    EVIDENCE.preserved_hashes_after['public.sync_homeowner_ledger_from_check()'],
    '9f6ec2dc9a5bcb7b7651d5b556788eb73ba5b567d457196fe82544f98aca8699',
  );
  assert.equal(
    EVIDENCE.preserved_hashes_after['public.aws_can_write_claim(uuid)'],
    '0a7e62b26bf4dd07ce9c06a104773d472ccff6b5a0207d338de4ba594eb32caf',
  );
  assert.equal(
    EVIDENCE.preserved_hashes_after['public.hle_on_check_intake_insert()'],
    'bdd9ec4b45b79ef3b3b21c5f18c2785d901edc606695fbc84f0daedecff5ff48',
  );
  assert.equal(EVIDENCE.live_executor.after.unchanged, true);
});
