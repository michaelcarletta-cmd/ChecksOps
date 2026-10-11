import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateSql53StagingApply, hashFileSha256, loadSql53Pin } from '../../scripts/deployment-guard/lib/sql53-staging-apply.mjs';
import {
  evaluateSql53ProductionFunctionRepair,
  loadSql53ProductionRepairPin,
} from '../../scripts/deployment-guard/lib/sql53-production-function-repair.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = loadSql53ProductionRepairPin(ROOT);
const STAGING = loadSql53Pin(ROOT);
const SQL = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const RUNBOOK = fs.readFileSync(path.join(ROOT, 'ops/production-sql53-function-repair.md'), 'utf8');

test('production repair pin reuses the approved SQL 53 file and stays evaluate-only', () => {
  assert.equal(PIN.apply_authorized, false);
  assert.equal(PIN.execute, false);
  assert.equal(PIN.target_environment, 'production');
  assert.equal(PIN.filename, STAGING.filename);
  assert.equal(PIN.source_sha256, STAGING.source_sha256);
  assert.equal(hashFileSha256(ROOT, PIN.filename), PIN.source_sha256);
  assert.equal(PIN.function_identity, 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)');
  assert.equal(PIN.production_inspect.exists, false);
  assert.equal(PIN.production_inspect.settlement_columns_found, 17);
  assert.equal(PIN.production_inspect.ledger_triggers_found, 3);
  assert.deepEqual(PIN.production_inspect.functions_missing, [PIN.function_identity]);
});

test('SQL 53 source creates only the missing settlement function', () => {
  assert.match(SQL, /CREATE OR REPLACE FUNCTION public\.save_claim_settlement_breakdown\(/);
  assert.match(SQL, /public\.aws_can_write_claim\(p_claim_id\)/);
  assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.save_claim_settlement_breakdown[\s\S]*TO checksops/);
  assert.match(SQL, /REVOKE ALL ON FUNCTION public\.save_claim_settlement_breakdown[\s\S]*FROM PUBLIC, authenticated, anon/);
  assert.doesNotMatch(SQL, /CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+TRIGGER|DROP\s+(?:FUNCTION|TRIGGER|TABLE)/i);
  assert.doesNotMatch(SQL, /sync_homeowner_ledger_from_check|hle_on_check_intake_insert|claim_ledger_link_or_create/);
  assert.doesNotMatch(SQL, /payments|disbursement|moov|signature_request/i);
});

test('production repair evaluate-only succeeds and refuses apply', () => {
  const ready = evaluateSql53ProductionFunctionRepair({
    target_environment: 'production',
    filename: PIN.filename,
    apply: false,
    execute: false,
  }, { root: ROOT });
  assert.equal(ready.ok, true, ready.message);
  assert.equal(ready.details.sql53_function_repair_ready, true);
  assert.equal(ready.details.apply_authorized, false);
  assert.equal(ready.details.apply_executed, false);

  const apply = evaluateSql53ProductionFunctionRepair({
    target_environment: 'production',
    filename: PIN.filename,
    apply: true,
  }, { root: ROOT });
  assert.equal(apply.ok, false);
  assert.equal(apply.code, CODES.GUARD_APPLY_FORBIDDEN);

  const staging = evaluateSql53StagingApply({
    target_environment: 'production',
    filename: PIN.filename,
    apply: false,
  }, { root: ROOT });
  assert.equal(staging.ok, false);
  assert.equal(staging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.match(RUNBOOK, /SQL53_FUNCTION_REPAIR_READY: YES/);
  assert.match(RUNBOOK, /DROP FUNCTION IF EXISTS public\.save_claim_settlement_breakdown/);
});
