/**
 * Output hygiene for the production SQL one-shot summary and the mortgage
 * SQL 84-86 apply result: no check ids or role names leave the operator's
 * --inspect output.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INSPECT_RECORD_KEYS, inspectResultRecord, pickInspect } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { FIXED_SQL_GUARD_MESSAGES, sqlGuardErrorMessage } from '../../scripts/deployment-guard/lib/errors.mjs';
import { applyErrorMessage } from '../../scripts/deployment-guard/lib/mortgage-sql-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK_A = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c';
const CHECK_B = '1c9a7a2f-3a1d-4d8f-8b62-7b4a2e3f5c6d';

test('pickInspect copies billing_duplicates counts only, never check_ids', () => {
  assert.ok(INSPECT_RECORD_KEYS.includes('billing_duplicates'));
  const picked = pickInspect({
    read_only: true,
    billing_duplicates: { readable: true, groups: 2, extra_events: 3, check_ids: [CHECK_A, CHECK_B] },
    earn_owner: { earn_owner_safe: true },
    not_recorded: 'x',
  });
  assert.deepEqual(picked, {
    read_only: true,
    billing_duplicates: { readable: true, groups: 2, extra_events: 3 },
    earn_owner: { earn_owner_safe: true },
  });
  assert.doesNotMatch(JSON.stringify(picked), new RegExp(`${CHECK_A}|${CHECK_B}|check_ids`));
});

test('pickInspect keeps an unreadable billing_duplicates as readable:false with its reason', () => {
  assert.deepEqual(
    pickInspect({ billing_duplicates: { readable: false, reason: 'table_or_columns_missing' } }),
    { billing_duplicates: { readable: false, reason: 'table_or_columns_missing' } },
  );
  assert.deepEqual(pickInspect({ billing_duplicates: null }), { billing_duplicates: null });
});

test('SQL 84 and SQL 86 guard errors map to fixed messages without ids or role names', () => {
  const dup = new Error(`duplicate_mortgage_ops_billing_events: resolve before SQL 84; check_intake_item_id (events): ${CHECK_A} (2), ${CHECK_B} (3)`);
  const owner1 = new Error('earn_owner_unsafe: earn_mortgage_agent_compensation (owner checksops_admin) and tg_earn_mortgage_agent_compensation (owner rds_superuser_x) must have the same owner before SQL 86 revokes EXECUTE');
  const owner2 = new Error("earn_owner_unsafe: earn_mortgage_agent_compensation owner checksops is or belongs to checksops/authenticated; SQL 86 would revoke the completion trigger's EXECUTE");
  const dupMessage = applyErrorMessage(dup);
  assert.match(dupMessage, /^duplicate_mortgage_ops_billing_events: /);
  assert.doesNotMatch(dupMessage, new RegExp(`${CHECK_A}|${CHECK_B}`));
  for (const error of [owner1, owner2]) {
    const message = applyErrorMessage(error);
    assert.match(message, /^earn_owner_unsafe: /);
    assert.doesNotMatch(message, /checksops_admin|rds_superuser_x|owner checksops|authenticated/);
  }
  assert.equal(applyErrorMessage(owner1), applyErrorMessage(owner2));
});

test('other apply errors keep their (truncated) message', () => {
  assert.equal(applyErrorMessage(new Error('canceling statement due to lock timeout')), 'canceling statement due to lock timeout');
  assert.equal(applyErrorMessage(new Error('x'.repeat(400))).length, 300);
  assert.equal(applyErrorMessage('plain'), 'plain');
});

test('the mortgage apply catch block reports only applyErrorMessage', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/deployment-guard/lib/mortgage-sql-production-apply.mjs'), 'utf8');
  const start = source.indexOf('export async function executeMortgageProductionApply');
  const body = source.slice(start, source.indexOf('const FIXED_APPLY_ERROR_MESSAGES', start));
  const catchStart = body.indexOf('} catch (error) {\n    if (commitSent)');
  assert.ok(catchStart > 0);
  const catchBlock = body.slice(catchStart, body.indexOf('} finally {', catchStart));
  assert.equal((catchBlock.match(/applyErrorMessage\(error\)/g) || []).length, 2);
  assert.doesNotMatch(catchBlock, /error\?\.message/);
});

test('inspectResultRecord keeps status and picked fields only', () => {
  const record = inspectResultRecord({
    ok: false,
    code: 'SQL_COLLISION',
    message: 'state unreadable',
    details: {
      read_only: true,
      billing_duplicates: { readable: true, groups: 1, extra_events: 1, check_ids: [CHECK_A] },
      state: { functions: { x: { owner: 'secret_owner' } } },
      state_error: { code: '42501', message: 'permission denied' },
    },
  });
  assert.deepEqual(record, {
    ok: false,
    code: 'SQL_COLLISION',
    message: 'state unreadable',
    details: {
      read_only: true,
      billing_duplicates: { readable: true, groups: 1, extra_events: 1 },
      state_error: { code: '42501', message: 'permission denied' },
    },
  });
  assert.equal(inspectResultRecord(null), null);
});

test('the production apply and the staging executor share one fixed-message mapping', () => {
  assert.deepEqual(FIXED_SQL_GUARD_MESSAGES.map(([prefix]) => prefix), ['duplicate_mortgage_ops_billing_events', 'earn_owner_unsafe', 'case_owner_unsafe', 'case_callers_unsafe']);
  for (const [prefix, fixed] of FIXED_SQL_GUARD_MESSAGES) {
    assert.equal(sqlGuardErrorMessage(new Error(`${prefix}: ${CHECK_A} owner checksops_admin`), 400), fixed);
    assert.equal(applyErrorMessage(new Error(`${prefix}: ${CHECK_A}`)), fixed);
  }
  const executor = fs.readFileSync(path.join(ROOT, 'aws/write-path/guarded-sql-executor/index.mjs'), 'utf8');
  const start = executor.indexOf('async function handleMortgageMigration(');
  const body = executor.slice(start, executor.indexOf('\n}\n', start));
  const catchBlock = body.slice(body.lastIndexOf('} catch (error) {'), body.lastIndexOf('} finally {'));
  assert.equal((catchBlock.match(/sqlGuardErrorMessage\(error, 400\)/g) || []).length, 2);
  assert.doesNotMatch(catchBlock, /error\?\.message/);
});
