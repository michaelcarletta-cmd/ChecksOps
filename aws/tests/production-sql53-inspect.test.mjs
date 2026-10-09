import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-sql53-inspect.json'), 'utf8'));
const INSPECTOR = fs.readFileSync(path.join(ROOT, 'scripts/deployment-guard/production-readonly-inspect.mjs'), 'utf8');
const DOCS = fs.readFileSync(path.join(ROOT, 'ops/production-readonly-inspector.md'), 'utf8');

test('SQL 53 inspect pin is BLOCKED and does not authorize SQL or apply', () => {
  assert.equal(PIN.id, 'production-sql53-inspect');
  assert.equal(PIN.verdict, 'BLOCKED');
  assert.equal(PIN.sql53_result, null);
  assert.equal(PIN.apply_authorized, false);
  assert.equal(PIN.sql_writes, false);
  assert.equal(PIN.sql_migrations, false);
  assert.equal(PIN.database_contacted, false);
  assert.equal(PIN.refused_unproven_bypassed, false);
  assert.equal(PIN.secret_values_read, false);
  assert.equal(PIN.automatic_fixes, false);
});

test('official mechanism is the production-readonly inspector and it never queries SQL', () => {
  assert.equal(PIN.official_mechanism.workflow, '.github/workflows/inspect-production-readonly.yml');
  assert.equal(PIN.official_mechanism.contacts_database, false);
  assert.equal(PIN.official_mechanism.inspects_sql_function_hashes, false);
  assert.match(DOCS, /never accepts a database\nconnection string, contacts a database/);
  assert.match(INSPECTOR, /refused_unproven_aws_production_target/);
  assert.doesNotMatch(INSPECTOR, /BEGIN READ ONLY/);
  assert.doesNotMatch(INSPECTOR, /pg_get_functiondef/);
  assert.doesNotMatch(INSPECTOR, /GetSecretValue/);
});

test('target remains refused_unproven and names the exact missing evidence', () => {
  assert.equal(PIN.target_verification.proven, false);
  assert.equal(PIN.target_verification.status, 'refused_unproven_aws_production_target');
  assert.equal(PIN.target_verification.observed_db_instance_count, 2);
  assert.equal(PIN.target_verification.vpc_match_count, 2);
  assert.equal(PIN.target_verification.security_group_match_count, 0);
  assert.equal(PIN.target_verification.master_user_association_count, 0);
  assert.equal(PIN.target_verification.required_permission, 'ec2:DescribeSecurityGroups');
  assert.equal(PIN.target_verification.required_permission_authorized, false);
  assert.equal(PIN.sql53_inspection.attempted, false);
  assert.equal(PIN.sql53_inspection.exists, null);
  assert.ok(PIN.missing_evidence.some((row) => row.includes('ec2:DescribeSecurityGroups')));
  assert.ok(PIN.target_verification.not_used.includes('GetSecretValue'));
  assert.ok(PIN.target_verification.not_used.includes('production /db-readonly-validate'));
});

test('expected SQL 53 hash is recorded but was not compared to a live definition', () => {
  assert.equal(PIN.function_identity, 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)');
  assert.equal(PIN.expected_definition_sha256, '6542c3f6fb3f7d50b758b3d7352fe6fb49cbe8cd2bd5c6061dbc35a6e9fccf52');
  assert.equal(PIN.sql53_inspection.definition_sha256, null);
  assert.equal(PIN.official_inspect.workflow_run, 37821736928);
  assert.equal(PIN.fresh_this_turn.lambda_config.matches_official_inspect, true);
  assert.equal(PIN.fresh_this_turn.workflow_dispatch.httpStatus, 403);
});
