import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateAdminOverride,
  withSavepoint,
} from '../functions/api/workflow-override.mjs';
import { ADMIN_OVERRIDE_STATUSES, stageForStatus } from '../functions/api/check-status-stage.mjs';
import { matchWorkflowRoute } from '../functions/api/workflow.mjs';
import { SAFE_WRITE_RPCS, SAFE_WRITE_RPC_CLASSIFICATION } from '../functions/api/workflow-rpc.mjs';

test('override HTTP route is registered', () => {
  assert.equal(matchWorkflowRoute('POST', '/workflow/override'), 'override');
  assert.equal(matchWorkflowRoute('POST', '/workflow/checks/override'), 'override');
  assert.equal(matchWorkflowRoute('GET', '/workflow/override'), null);
});

test('admin_override_check_status is the same safe write engine', () => {
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.admin_override_check_status, 'safe_now');
  assert.equal(SAFE_WRITE_RPCS.has('admin_override_check_status'), true);
});

test('evaluateAdminOverride requires a reason and a permitted destination', () => {
  const current = { status: 'endorsements_in_progress', check_stage: 'endorsing', deposited_at: null };
  assert.equal(evaluateAdminOverride({ current, destinationStatus: 'needs_review', reason: 'ok' }).error, 'reason_required');
  assert.equal(evaluateAdminOverride({ current, destinationStatus: 'deposited', reason: 'move to deposited now' }).error, 'invalid_destination');
  assert.equal(evaluateAdminOverride({ current, destinationStatus: 'funds_released', reason: 'release funds now' }).error, 'invalid_destination');
  const ok = evaluateAdminOverride({ current, destinationStatus: 'needs_review', reason: 'return to review queue' });
  assert.equal(ok.ok, true);
  assert.equal(ok.nextStatus, 'needs_review');
  assert.equal(ok.nextStage, 'review');
  assert.equal(ok.providerExecution, false);
  assert.equal(ok.financialAuthorization, false);
});

test('evaluateAdminOverride refuses deposited or released checks', () => {
  const deposited = { status: 'deposited', check_stage: 'deposited', deposited_at: '2026-09-01T00:00:00Z' };
  const blocked = evaluateAdminOverride({
    current: deposited,
    destinationStatus: 'needs_review',
    reason: 'undo deposit',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'financial_or_provider');
});

test('admin override destinations stay operational and map to canonical stages', () => {
  for (const status of ADMIN_OVERRIDE_STATUSES) {
    assert.ok(stageForStatus(status), status);
    assert.notEqual(status, 'deposited');
    assert.notEqual(status, 'funds_released');
  }
});

test('withSavepoint rolls back isolated failures without throwing', async () => {
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(String(sql));
      if (String(sql).includes('SAVEPOINT')) return { rows: [] };
      if (String(sql).includes('ROLLBACK')) return { rows: [] };
      if (String(sql).includes('RELEASE')) return { rows: [] };
      return { rows: [] };
    },
  };
  const result = await withSavepoint(client, 'claim_checks_mirror', async () => {
    throw new Error('permission denied for table claim_checks');
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /permission denied/);
  assert.ok(queries.some((sql) => sql.includes('ROLLBACK TO SAVEPOINT')));
});
