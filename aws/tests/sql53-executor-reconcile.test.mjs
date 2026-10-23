import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL39,
  AUTHORIZED_SQL40,
  AUTHORIZED_SQL44,
  AUTHORIZED_SQL53,
  AUTHORIZED_LEDGER_20261007193200,
  AUTHORIZED_SQL71_AMOUNT_GRANT,
  AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES,
  AUTHORIZED_SQL76_PARTNERSHIP_CONSENT,
  AUTHORIZED_STAGING_SQL,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { packExecutor } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE_SHA = {
  sql39: 'a3ec9922d33cf75fc554ac9bdd3e7c1b14429112f38ce23f517d64e06b9442a9',
  sql40: '9f691e72da8e3490489854f685f470884441e61e2475b91e92fec55fd80b5de8',
  sql53: '5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197',
  cleanup: '55f80f5b1203e845722748b358e6aba49b415147bf05e50eb8ce4f315ed12ece',
  catalog: 'f1920862efaaccebcf85cc8f1a4c31c5472f3ddcb71b7189b6483966d14491b0',
};

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function zipSourceMembers(zipPath) {
  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split('\n')
    .map((row) => row.replace(/^\.\//, ''))
    .filter((row) => row && !row.startsWith('node_modules/'));
  const extract = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-reconcile-zip-'));
  execFileSync('unzip', ['-qo', zipPath, '-d', extract]);
  const members = {};
  for (const rel of listing) {
    const full = path.join(extract, rel);
    if (!fs.statSync(full).isFile()) continue;
    members[rel] = sha256File(full);
  }
  return members;
}

const PACK_SQL39 = 'aws/write-path/guarded-sql-executor/sql/39_tmp_write_policy_reconcile.sql';
const PACK_SQL40 = 'aws/write-path/guarded-sql-executor/sql/40_collection_v2_synthetic_uat_cleanup.sql';

test('composed source pins keep live SQL 39/40 bytes and merged SQL 53', () => {
  assert.equal(AUTHORIZED_SQL39.filename, 'aws/rls/sql/39_tmp_write_policy_reconcile.sql');
  assert.equal(AUTHORIZED_SQL40.filename, 'aws/rls/sql/40_collection_v2_synthetic_uat_cleanup.sql');
  assert.equal(sha256File(path.join(ROOT, PACK_SQL39)), LIVE_SHA.sql39);
  assert.equal(sha256File(path.join(ROOT, PACK_SQL40)), LIVE_SHA.sql40);
  assert.equal(sha256File(path.join(ROOT, AUTHORIZED_SQL53.filename)), LIVE_SHA.sql53);
  assert.equal(
    sha256File(path.join(ROOT, 'scripts/deployment-guard/lib/collection-v2-synthetic-uat-cleanup.mjs')),
    LIVE_SHA.cleanup,
  );
  assert.equal(
    sha256File(path.join(ROOT, 'scripts/deployment-guard/lib/tmp-rls-catalog.mjs')),
    LIVE_SHA.catalog,
  );
  assert.equal(AUTHORIZED_SQL39.source_sha256, LIVE_SHA.sql39);
  assert.equal(AUTHORIZED_SQL40.source_sha256, LIVE_SHA.sql40);
  assert.equal(fs.existsSync(path.join(ROOT, AUTHORIZED_SQL39.filename)), false);
  assert.equal(fs.existsSync(path.join(ROOT, AUTHORIZED_SQL40.filename)), false);
});

test('packExecutor retains live-only members and adds SQL 53 and the ledger migration', () => {
  const packed = packExecutor(ROOT);
  const members = zipSourceMembers(packed.zip);
  assert.equal(members['sql/39_tmp_write_policy_reconcile.sql'], LIVE_SHA.sql39);
  assert.equal(members['sql/40_collection_v2_synthetic_uat_cleanup.sql'], LIVE_SHA.sql40);
  assert.equal(members['sql/53_claim_settlement_breakdown.sql'], LIVE_SHA.sql53);
  assert.equal(members['lib/collection-v2-synthetic-uat-cleanup.mjs'], LIVE_SHA.cleanup);
  assert.equal(members['lib/tmp-rls-catalog.mjs'], LIVE_SHA.catalog);
  assert.equal(members['sql/44_claim_ledger_link_or_create.sql'], AUTHORIZED_SQL44.source_sha256);
  assert.ok(members['index.mjs']);
  assert.ok(members['lib/sql-executor-auth.mjs']);
  assert.equal(
    members['sql/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql'],
    AUTHORIZED_LEDGER_20261007193200.source_sha256,
  );
  assert.equal(
    members['sql/71_review_amount_column_grant.sql'],
    AUTHORIZED_SQL71_AMOUNT_GRANT.source_sha256,
  );
  assert.equal(
    members['sql/72_member_payment_writes.sql'],
    AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES.source_sha256,
  );
  assert.equal(
    members['sql/76_tenant_partnership_invitee_consent.sql'],
    AUTHORIZED_SQL76_PARTNERSHIP_CONSENT.source_sha256,
  );
  // 24 reviewed pins plus the twenty-three release 2026-10-17 pins (SQL 90-106, 108-113).
  assert.equal(AUTHORIZED_STAGING_SQL.length, 47);
});

test('unmatched authorization never falls through to SQL 44', () => {
  assert.equal(resolveAuthorizedMigration({}), null);
  assert.equal(resolveAuthorizedMigration({ filename: 'other.sql', migration_id: 'other' }), null);
  assert.equal(resolveAuthorizedMigration({
    filename: AUTHORIZED_SQL53.filename,
    migration_id: AUTHORIZED_SQL44.migration_id,
  }), null);
});

test('SQL 39 and SQL 40 inspect routes exist and do not use the SQL 44 handler', async () => {
  const { module } = await importGuardedSqlExecutor();
  const now = () => Date.parse('2026-10-05T12:00:00.000Z');
  const missing39 = path.join(os.tmpdir(), `missing-sql39-${process.pid}.sql`);
  const missing40 = path.join(os.tmpdir(), `missing-sql40-${process.pid}.sql`);
  try { fs.unlinkSync(missing39); } catch { /* ok */ }
  try { fs.unlinkSync(missing40); } catch { /* ok */ }

  const handler = module.createHandler({
    now,
    connect: async () => {
      throw new Error('should-not-connect');
    },
    sqlFile39: missing39,
    sqlFile40: missing40,
  });

  const sql39 = await handler({
    action: 'inspect',
    workstream_id: 'tmp-write-policy',
    branch: 'cursor/staging-sql53-executor-reconcile-3bc9',
    commit: AUTHORIZED_SQL39.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [AUTHORIZED_SQL39.filename],
    filename: AUTHORIZED_SQL39.filename,
    migration_id: AUTHORIZED_SQL39.migration_id,
    source_sha256: AUTHORIZED_SQL39.source_sha256,
    intended_replacement_sha256: AUTHORIZED_SQL39.intended_replacement_sha256,
    expected_live_definition_sha256: '1'.repeat(64),
    one_use_id: 'sql39-inspect-0001',
    expiry: '2026-10-05T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: '2026-10-05T12:00:00.000Z',
  });
  assert.equal(sql39.ok, false);
  assert.match(sql39.message, /embedded SQL file is missing from the executor package/);

  const sql40 = await handler({
    action: 'inspect',
    workstream_id: 'collection-v2-cleanup',
    branch: 'cursor/staging-sql53-executor-reconcile-3bc9',
    commit: AUTHORIZED_SQL40.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [AUTHORIZED_SQL40.filename],
    filename: AUTHORIZED_SQL40.filename,
    migration_id: AUTHORIZED_SQL40.migration_id,
    source_sha256: AUTHORIZED_SQL40.source_sha256,
    intended_replacement_sha256: AUTHORIZED_SQL40.intended_replacement_sha256,
    expected_live_definition_sha256: AUTHORIZED_SQL40.expected_live_fixture_sha256,
    one_use_id: 'sql40-inspect-0001',
    expiry: '2026-10-05T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: '2026-10-05T12:00:00.000Z',
  });
  assert.equal(sql40.ok, false);
  assert.match(sql40.message, /embedded SQL file is missing from the executor package/);
  assert.notEqual(sql39.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.notEqual(sql40.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
});
