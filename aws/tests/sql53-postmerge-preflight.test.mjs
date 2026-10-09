import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AUTHORIZED_SQL39,
  AUTHORIZED_SQL40,
  AUTHORIZED_SQL53,
  AUTHORIZED_STAGING_SQL,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN_PATH = path.join(ROOT, 'ops/deployment-guard/sql53-postmerge-preflight.json');
const PIN = JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('post-merge preflight pin is evaluate-only and does not authorize ensure or invoke', () => {
  assert.equal(PIN.authorization, 'source-only');
  assert.equal(PIN.apply_authorized, false);
  assert.equal(PIN.execute, false);
  assert.equal(PIN.ensure_authorized, false);
  assert.equal(PIN.invoke_authorized, false);
  assert.equal(PIN.phase2_authorized, false);
  assert.equal(PIN.receipt_issued, false);
  assert.equal(PIN.verdict, 'GO');
  assert.equal(PIN.staging_executor_deployment, 'GO');
  assert.equal(PIN.merged_source_commit, '3b186ef27f9a3e27a10b8368ef2eb737998898f2');
  assert.equal(PIN.ensure_commit, '3b186ef27f9a3e27a10b8368ef2eb737998898f2');
  assert.equal(PIN.invoke_auth_commit, AUTHORIZED_SQL53.commit);
  assert.equal(PIN.function_name, 'checksops-staging-guarded-sql-executor');
  assert.equal(PIN.source_sha256, AUTHORIZED_SQL53.source_sha256);
  assert.equal(PIN.intended_replacement_sha256, AUTHORIZED_SQL53.intended_replacement_sha256);
  assert.equal(PIN.absent_live_definition_sha256, AUTHORIZED_SQL53.absent_live_definition_sha256);
  assert.equal(
    sha256File(path.join(ROOT, AUTHORIZED_SQL53.filename)),
    AUTHORIZED_SQL53.source_sha256,
  );
  assert.ok(PIN.ensure_procedure_for_separate_approval.do_not.includes('invoke the executor'));
  assert.ok(PIN.ensure_procedure_for_separate_approval.do_not.includes('issue a receipt'));
  assert.ok(PIN.ensure_procedure_for_separate_approval.do_not.includes('execute SQL 53'));
});

test('post-merge pack delta records no live-only drop and preserves SQL 39/40 bytes', () => {
  assert.deepEqual(PIN.pack_delta_from_3b186ef.only_live_would_be_dropped, []);
  assert.deepEqual(PIN.pack_delta_from_3b186ef.only_pack_would_be_added, [
    'sql/53_claim_settlement_breakdown.sql',
  ]);
  assert.equal(AUTHORIZED_STAGING_SQL.length, 5);
  assert.equal(resolveAuthorizedMigration({}), null);
  assert.equal(
    PIN.pack_delta_from_3b186ef.unchanged.includes('sql/39_tmp_write_policy_reconcile.sql'),
    true,
  );
  assert.equal(
    PIN.pack_delta_from_3b186ef.unchanged.includes('sql/40_collection_v2_synthetic_uat_cleanup.sql'),
    true,
  );
  assert.equal(
    sha256File(path.join(ROOT, 'aws/write-path/guarded-sql-executor/sql/39_tmp_write_policy_reconcile.sql')),
    AUTHORIZED_SQL39.source_sha256,
  );
  assert.equal(
    sha256File(path.join(ROOT, 'aws/write-path/guarded-sql-executor/sql/40_collection_v2_synthetic_uat_cleanup.sql')),
    AUTHORIZED_SQL40.source_sha256,
  );
  assert.equal(fs.existsSync(path.join(ROOT, AUTHORIZED_SQL39.filename)), false);
  assert.equal(fs.existsSync(path.join(ROOT, AUTHORIZED_SQL40.filename)), false);
});

test('recorded live fingerprints stay bound to the Oct 5 SQL 39/40 package', () => {
  assert.equal(PIN.live_executor.CodeSha256, 'eWyfw2kGKayio0CGs13FQWYDsyB1jrS5wKEIs+Pk6iM=');
  assert.equal(PIN.live_executor.RevisionId, '419c3227-a55a-4c29-9ba8-16cca009350f');
  assert.equal(PIN.live_executor.LastModified, '2026-10-05T19:43:49.000+0000');
  assert.equal(PIN.latest_absent_inspect.exists, false);
  assert.equal(PIN.latest_absent_inspect.workflow_run, 37959470214);
  assert.equal(
    PIN.latest_absent_inspect.missing_function,
    'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)',
  );
});
