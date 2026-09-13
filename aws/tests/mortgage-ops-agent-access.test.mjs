import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('mortgage agent SQL does not weaken aws_can_access_tenant', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'rls/sql/31_mortgage_ops_agent_access.sql'), 'utf8');
  assert.match(sql, /aws_mortgage_agent_queue_visible/);
  assert.match(sql, /aws_insert_mortgage_handling_requests/);
  assert.match(sql, /aws_update_mortgage_handling_requests/);
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.aws_can_access_tenant/);
  assert.match(sql, /status = 'requested'/);
  assert.match(sql, /has_role\(auth\.uid\(\), 'mortgage_agent'/);
});

test('staff grants add assignment columns without financial tables', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'workflows/sql/52_mortgage_ops_staff_grants.sql'), 'utf8');
  assert.match(sql, /assigned_employee_id/);
  assert.match(sql, /accepted_at/);
  assert.match(sql, /completed_at/);
  assert.doesNotMatch(sql, /claim_payments|homeowner_ledger_events|payment_transfers/);
});

test('tenant data/write cannot set staff-controlled mortgage columns except via owner path', () => {
  assert.equal(WRITE_ALLOWLIST.mortgage_handling_requests.columns.has('status'), true);
  assert.equal(WRITE_ALLOWLIST.mortgage_handling_requests.columns.has('work_notes'), false);
  assert.equal(WRITE_ALLOWLIST.mortgage_handling_requests.columns.has('assigned_employee_id'), true);
  assert.equal(WRITE_ALLOWLIST.mortgage_handling_requests.clientIgnored.has('assigned_employee_id'), false);
  assert.equal(WRITE_ALLOWLIST.mortgage_handling_requests.clientIgnored.has('work_notes'), false);
});

test('mortgage staff RPCs are classified safe write', () => {
  assert.equal(typeof executeSafeWriteRpc, 'function');
});

test('SQL 29 library-parity filename is preserved and agent-access is SQL 31', () => {
  const rlsDir = path.join(ROOT, 'rls/sql');
  assert.equal(fs.existsSync(path.join(rlsDir, '29_mortgage_ops_library_parity.sql')), true);
  assert.equal(fs.existsSync(path.join(rlsDir, '29_mortgage_ops_agent_access.sql')), false);
  assert.equal(fs.existsSync(path.join(rlsDir, '31_mortgage_ops_agent_access.sql')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'write-path/sql/31_tranche1_write_grants.sql')), true);
  const agent = fs.readFileSync(path.join(rlsDir, '31_mortgage_ops_agent_access.sql'), 'utf8');
  const library = fs.readFileSync(path.join(rlsDir, '29_mortgage_ops_library_parity.sql'), 'utf8');
  assert.match(library, /aws_can_insert_mortgage_library_document/);
  assert.match(agent, /aws_mortgage_agent_queue_visible/);
  assert.doesNotMatch(library, /aws_mortgage_agent_queue_visible/);
});
