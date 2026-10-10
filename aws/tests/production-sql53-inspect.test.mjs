import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_DEF_INSPECT_SQL,
  LEDGER_TRIGGER_INSPECT_SQL,
  PINNED_FUNCTION_LOOKUPS,
  REQUIRED_LEDGER_TRIGGERS,
  REQUIRED_SETTLEMENT_COLUMNS,
  SETTLEMENT_COLUMN_INSPECT_SQL,
} from '../functions/api/db-readonly-validate.mjs';
import { FUNCTION_DEF_LOOKUP_SQL } from '../../scripts/deployment-guard/lib/function-def-lookup.mjs';
import { AUTHORIZED_SQL53 } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-sql53-inspect.json'), 'utf8'));
const VALIDATOR = fs.readFileSync(path.join(ROOT, 'aws/functions/api/db-readonly-validate.mjs'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'aws/functions/api/index.mjs'), 'utf8');
const HOST_COMPARE = fs.readFileSync(path.join(ROOT, '.github/workflows/inspect-production-secret-host-compare.yml'), 'utf8');
const READONLY = fs.readFileSync(path.join(ROOT, '.github/workflows/inspect-production-readonly.yml'), 'utf8');

test('SQL 53 inspect pin is PREPARED and does not authorize SQL or apply', () => {
  assert.equal(PIN.id, 'production-sql53-inspect');
  assert.equal(PIN.verdict, 'PREPARED');
  assert.equal(PIN.execute, false);
  assert.equal(PIN.apply_authorized, false);
  assert.equal(PIN.sql_writes, false);
  assert.equal(PIN.sql_migrations, false);
  assert.equal(PIN.database_contacted, false);
  assert.equal(PIN.secret_values_read, false);
  assert.equal(PIN.workflow_dispatched, false);
  assert.equal(PIN.objects_assumed_missing, false);
  assert.equal(PIN.sql53_result, null);
  assert.equal(PIN.sql53_inspection.attempted, false);
  assert.equal(PIN.sql53_inspection.exists, null);
});

test('official host-compare evidence pins checksops-production and the live Lambda identity', () => {
  assert.equal(PIN.official_target.proven, true);
  assert.equal(PIN.official_target.workflow_run, 38067130648);
  assert.equal(PIN.official_target.head_sha, 'a49808099121c3f97d8a15a3d7a0f0e957cf46a1');
  assert.equal(PIN.official_target.matched_rds_identifier, 'checksops-production');
  assert.equal(PIN.official_target.host_compare_unique_match, true);
  assert.equal(PIN.official_target.host_compare_match_count, 1);
  assert.equal(
    PIN.official_target.candidate_resource_arn,
    'arn:aws:rds:us-east-1:806168576068:db:checksops-production',
  );
  assert.equal(PIN.official_target.lambda_function_name, 'checksops-production-prep-api');
  assert.equal(PIN.official_target.lambda_code_sha256, 'DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI=');
  assert.equal(PIN.official_target.lambda_revision_id, 'fb17cb70-7b50-468d-a0a6-59a020c43f8c');
  assert.deepEqual(PIN.official_target.missing_read_permissions, []);
  assert.deepEqual(PIN.official_target.read_errors, []);
});

test('official AWS inspect workflows still cannot hash SQL 53', () => {
  assert.equal(PIN.official_aws_inspector.contacts_database, false);
  assert.equal(PIN.official_aws_inspector.inspects_sql_function_hashes, false);
  assert.equal(PIN.official_aws_inspector.can_inspect_sql53, false);
  assert.doesNotMatch(READONLY, /pg_get_functiondef|BEGIN READ ONLY|save_claim_settlement_breakdown/);
  assert.doesNotMatch(HOST_COMPARE, /pg_get_functiondef|BEGIN READ ONLY|rds-db:connect/);
  assert.ok(PIN.do_not_use.includes('inspect-production-readonly.yml for SQL hashes'));
  assert.ok(PIN.do_not_use.includes('inspect-production-secret-host-compare.yml for SQL hashes'));
});

test('existing hash inspect pins the four functions, 17 columns, and three triggers', () => {
  assert.equal(FUNCTION_DEF_INSPECT_SQL, FUNCTION_DEF_LOOKUP_SQL);
  assert.deepEqual(PINNED_FUNCTION_LOOKUPS.map((row) => row.identity), [
    PIN.function_identity,
    ...PIN.preserved_function_identities,
  ]);
  assert.equal(REQUIRED_SETTLEMENT_COLUMNS.length, PIN.expected_settlement_column_count);
  assert.equal(REQUIRED_LEDGER_TRIGGERS.length, PIN.expected_ledger_trigger_count);
  assert.deepEqual(REQUIRED_LEDGER_TRIGGERS.map((row) => row.trigger), [
    'trg_sync_homeowner_ledger_ins',
    'trg_sync_homeowner_ledger_upd',
    'trg_hle_check_intake_insert',
  ]);
  assert.doesNotMatch(FUNCTION_DEF_INSPECT_SQL, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/im);
  assert.doesNotMatch(SETTLEMENT_COLUMN_INSPECT_SQL, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/im);
  assert.doesNotMatch(LEDGER_TRIGGER_INSPECT_SQL, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/im);
  assert.equal(AUTHORIZED_SQL53.source_sha256, PIN.source_sql_sha256);
  assert.equal(AUTHORIZED_SQL53.intended_replacement_sha256, PIN.intended_replacement_sha256);
});

test('current source and live package cannot return production SQL 53 hashes', () => {
  assert.match(VALIDATOR, /CHECKSOPS_ENV \|\| ''\)\.toLowerCase\(\) !== 'production'/);
  assert.match(INDEX, /access\.reason === 'staging_admin'/);
  assert.equal(PIN.existing_hash_inspect.current_main_skips_when, 'CHECKSOPS_ENV=production');
  assert.equal(PIN.existing_hash_inspect.live_has_sql53_function_inspect, false);
  assert.equal(PIN.existing_hash_inspect.live_matches_origin_main, false);
  assert.equal(PIN.existing_hash_inspect.live_claim_settlement_rpc_present, false);
  assert.match(PIN.sql53_inspection.stop, /Objects are not assumed missing/);
});
