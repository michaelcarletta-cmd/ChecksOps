import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  validateParitySql,
  validateTriggerOnlySql,
} from '../write-path/scripts/validate-parity-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('39 trigger-only SQL is the Sept 3 function body and nothing else', () => {
  const result = validateTriggerOnlySql();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.forbidden, []);
  assert.equal(result.functionMatches38, true);
  assert.equal(result.dataMutationStatements, 0);
});

test('38 parity SQL remains isolated-rehearsal only and still validates', () => {
  const result = validateParitySql();
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('oneshot refuses apply_parity_ddl on live checksops and gates trigger overlay', () => {
  const oneshot = read('aws/db-copy/rehearsal/oneshot-apply/index.mjs');
  assert.match(oneshot, /refusing parity DDL on checksops/);
  assert.match(oneshot, /apply_trigger_parity/);
  assert.match(oneshot, /confirmChecksopsTriggerParity/);
  assert.match(oneshot, /39_parity_payee_mirror_trigger_only\.sql/);
  assert.match(oneshot, /validate_trigger_rename_txn/);
  assert.match(oneshot, /ROLLBACK/);
  assert.doesNotMatch(oneshot, /64_financial_activation_grants\.sql/);
});

test('post-parity driver never applies 38, 64, or cutover switches', () => {
  const driver = read('aws/write-path/scripts/run-post-parity-readiness.mjs');
  assert.match(driver, /39_parity_payee_mirror_trigger_only\.sql/);
  assert.match(driver, /confirmChecksopsTriggerParity/);
  assert.match(driver, /refuse38/);
  assert.match(driver, /step: 'apply_parity_ddl'/);
  assert.match(driver, /64_financial_activation_grants/);
  assert.match(driver, /productionCutoverPerformed: false/);
  assert.match(driver, /pr125StillOpen/);
});
