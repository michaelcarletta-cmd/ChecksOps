/**
 * Mortgage Desk request page: Monitored / Not Monitored (SQL 166; owner 2026-11-14: "Mortgage agent needs to be able to
 * change the claim from monitor to not monitored, so the tenants see that type of update").
 *
 * Owner decisions: only while the request is in progress; switching to Not Monitored when escrow or draws are recorded is
 * allowed with a warning (a confirm dialog before the call, from the loss-draft values the page reads, and the server's
 * escrow_or_draws_recorded in the success toast); refused when there is no loss draft (the control is not shown); the
 * tenant sees a check-thread message (the server posts it). AWS only: the legacy backend has no such path, so the control is
 * hidden there. The call is mortgage_desk_set_monitoring through the Desk writes helper. Fake clients and source checks.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MORTGAGE_DESK_CLOSED_LOSS_DRAFT_STATUSES,
  MORTGAGE_DESK_LOSS_DRAFT_SELECT,
  MORTGAGE_DESK_MONITORING_LABEL,
  MORTGAGE_DESK_RPC,
  mortgageDeskEscrowOrDrawsRecorded,
  mortgageDeskLossDraftClosed,
  mortgageDeskMonitoringConfirm,
  mortgageDeskMonitoringToast,
  mortgageDeskMonitoringType,
  setMortgageDeskMonitoring,
  showMortgageDeskMonitoringControl,
} from '../../src/lib/mortgageDeskWrites.ts';
import { canWorkMortgageDeskRequest } from '../../src/lib/mortgageDeskEsign.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const AGENT = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const LD = { id: '66666666-6666-4666-8666-666666666666', monitoring_type: 'monitored', escrow_status: 'pending' };

test('the control shows only on AWS, for a workable request (in progress, assigned agent or owner), with a loss draft', () => {
  const working = { status: 'in_progress', assigned_employee_id: AGENT };
  assert.equal(showMortgageDeskMonitoringControl(true, canWorkMortgageDeskRequest(working, AGENT, false), LD), true);
  assert.equal(showMortgageDeskMonitoringControl(true, canWorkMortgageDeskRequest(working, OTHER, true), LD), true, 'platform owner');
  assert.equal(showMortgageDeskMonitoringControl(false, true, LD), false, 'legacy backend');
  assert.equal(showMortgageDeskMonitoringControl(true, true, null), false, 'no loss draft');
  assert.equal(showMortgageDeskMonitoringControl(true, true, { id: '' }), false, 'no loss draft id');
  assert.equal(showMortgageDeskMonitoringControl(true, canWorkMortgageDeskRequest(working, OTHER, false), LD), false, 'not assigned');
  for (const status of ['open', 'requested', 'completed', 'cancelled']) {
    assert.equal(showMortgageDeskMonitoringControl(true, canWorkMortgageDeskRequest({ status, assigned_employee_id: AGENT }, AGENT, false), LD), false, status);
  }
});

test('current type, closed loss draft and the escrow rule match SQL 166', () => {
  assert.equal(mortgageDeskMonitoringType(null), 'monitored');
  assert.equal(mortgageDeskMonitoringType({ id: 'x', monitoring_type: null }), 'monitored');
  assert.equal(mortgageDeskMonitoringType({ id: 'x', monitoring_type: 'not_monitored' }), 'not_monitored');
  assert.deepEqual([...MORTGAGE_DESK_CLOSED_LOSS_DRAFT_STATUSES], ['endorsing', 'final_release_complete']);
  assert.equal(mortgageDeskLossDraftClosed({ id: 'x', escrow_status: 'endorsing' }), true);
  assert.equal(mortgageDeskLossDraftClosed({ id: 'x', escrow_status: 'escrowed' }), false);
  assert.equal(mortgageDeskEscrowOrDrawsRecorded(LD), false);
  assert.equal(mortgageDeskEscrowOrDrawsRecorded({ id: 'x', total_escrowed: '0.00', draw_stage: 0 }), false);
  for (const field of ['total_escrowed', 'draw_amount_requested', 'draw_amount_released', 'holdback_amount', 'draw_stage']) {
    assert.equal(mortgageDeskEscrowOrDrawsRecorded({ id: 'x', [field]: '12.50' }), true, field);
  }
  for (const status of ['escrowed', 'first_draw_requested', 'partial_release']) {
    assert.equal(mortgageDeskEscrowOrDrawsRecorded({ id: 'x', escrow_status: status }), true, status);
  }
  // The rule is SQL 166's (d), field for field.
  const sql = read('aws/workflows/sql/166_mortgage_desk_set_monitoring.sql');
  for (const field of ['total_escrowed', 'draw_amount_requested', 'draw_amount_released', 'holdback_amount', 'draw_stage']) {
    assert.match(sql, new RegExp(`COALESCE\\(v_ld\\.${field}, 0\\) > 0`), field);
    assert.ok(MORTGAGE_DESK_LOSS_DRAFT_SELECT.split(',').includes(field), field);
  }
  assert.match(sql, /IN \('escrowed', 'first_draw_requested', 'partial_release'\)/);
  assert.match(sql, /IN \('endorsing', 'final_release_complete'\)/);
  assert.deepEqual(MORTGAGE_DESK_LOSS_DRAFT_SELECT.split(','),
    ['id', 'monitoring_type', 'escrow_status', 'total_escrowed', 'draw_amount_requested', 'draw_amount_released', 'holdback_amount', 'draw_stage']);
});

test('confirm text: the tenant message, and the escrow warning only for Not Monitored with escrow or draws recorded', () => {
  const plain = mortgageDeskMonitoringConfirm('not_monitored', LD);
  assert.equal(plain.title, 'Set this loss draft to Not Monitored?');
  assert.match(plain.description, /ChecksOps Mortgage Desk changed this loss draft to Not Monitored\./);
  assert.equal(plain.warning, null);
  const recorded = { ...LD, total_escrowed: 5000 };
  assert.match(mortgageDeskMonitoringConfirm('not_monitored', recorded).warning, /Escrow or draws are already recorded/);
  assert.equal(mortgageDeskMonitoringConfirm('monitored', recorded).warning, null);
  // The tenant message is the server's own text.
  const sql = read('aws/workflows/sql/166_mortgage_desk_set_monitoring.sql');
  for (const type of ['monitored', 'not_monitored']) {
    const label = MORTGAGE_DESK_MONITORING_LABEL[type];
    assert.ok(sql.includes(`'ChecksOps Mortgage Desk changed this loss draft to ${label}.'`), label);
  }
});

test('toast: the server result, with its escrow_or_draws_recorded', () => {
  assert.deepEqual(mortgageDeskMonitoringToast({ ok: true, changed: true, monitoring_type: 'not_monitored', escrow_or_draws_recorded: true }), {
    title: 'Loss draft set to Not Monitored; the tenant sees it on the check',
    description: 'Escrow or draws were already recorded on this loss draft.',
  });
  assert.equal(mortgageDeskMonitoringToast({ ok: true, changed: true, monitoring_type: 'monitored', escrow_or_draws_recorded: false }).description, null);
  assert.equal(mortgageDeskMonitoringToast({ ok: true, changed: false, monitoring_type: 'monitored' }).title, 'Already Monitored');
});

test('client: AWS calls mortgage_desk_set_monitoring with the request id and type only; the legacy backend calls nothing', async () => {
  const calls = [];
  const client = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: { ok: true, changed: true, monitoring_type: args._monitoring_type, escrow_or_draws_recorded: false }, error: null };
    },
  };
  const out = await setMortgageDeskMonitoring(client, true, { requestId: REQUEST_ID, monitoringType: 'not_monitored' });
  assert.equal(MORTGAGE_DESK_RPC.setMonitoring, 'mortgage_desk_set_monitoring');
  assert.deepEqual(calls, [{ name: 'mortgage_desk_set_monitoring', args: { _request_id: REQUEST_ID, _monitoring_type: 'not_monitored' } }]);
  assert.equal(out.error, null);
  assert.equal(out.data.monitoring_type, 'not_monitored');

  const refused = await setMortgageDeskMonitoring({
    rpc: async () => ({ data: null, error: { message: 'This check has no loss draft file, so there is nothing to monitor', code: 'request_has_no_loss_draft' } }),
  }, true, { requestId: REQUEST_ID, monitoringType: 'monitored' });
  assert.equal(refused.data, null);
  assert.match(refused.error.message, /no loss draft/);

  const legacy = [];
  const off = await setMortgageDeskMonitoring({ rpc: async (...a) => { legacy.push(a); return { data: null, error: null }; } }, false, { requestId: REQUEST_ID, monitoringType: 'monitored' });
  assert.equal(legacy.length, 0);
  assert.match(off.error.message, /AWS only/);
});

test('the request page reads the loss-draft fields, shows the control when allowed, confirms, calls, toasts and reloads', () => {
  const page = read('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx');
  // The loss-draft read the page already does now selects the monitoring and escrow fields.
  assert.match(page, /\.from\("loss_draft_tracking"\)\s*\n\s*\.select\(MORTGAGE_DESK_LOSS_DRAFT_SELECT\)\s*\n\s*\.eq\("check_intake_item_id", r\.check_intake_item_id\)/);
  assert.match(page, /setLossDraft\(ldt\?\.id \? \(ldt as unknown as MortgageDeskLossDraft\) : null\);/);
  // Shown only by the rule: AWS backend, canWork (in progress, assigned agent or owner) and a loss draft.
  assert.match(page, /const showMonitoring = showMortgageDeskMonitoringControl\(mortgageUsesAwsBackend, canWork, lossDraft\);/);
  assert.match(page, /\{showMonitoring && lossDraft && \(/);
  // A button opens the confirm; the confirm shows the escrow warning; only the confirm calls the server.
  assert.match(page, /onClick=\{\(\) => setMonitoringTarget\(type\)\}/);
  assert.match(page, /mortgageDeskMonitoringConfirm\(monitoringTarget, lossDraft\)/);
  assert.match(page, /\{monitoringConfirm\?\.warning && \(/);
  assert.match(page, /onClick=\{\(\) => void confirmSetMonitoring\(\)\}/);
  const start = page.indexOf('const confirmSetMonitoring = async');
  assert.ok(start > 0);
  const handler = page.slice(start, page.indexOf('\n  };\n', start));
  assert.match(handler, /setMortgageDeskMonitoring\(deskClient, mortgageUsesAwsBackend, \{\s*requestId: req\.id,\s*monitoringType: monitoringTarget,/);
  assert.match(handler, /toast\.error\(error\.message \|\| "Could not change monitoring"\)/);
  assert.match(handler, /const shown = mortgageDeskMonitoringToast\(data\);/);
  assert.match(handler, /await load\(\);/);
  assert.ok(handler.indexOf('toast.success') < handler.indexOf('await load()'));
  // No direct write: the agent cannot write loss_draft_tracking on AWS.
  assert.doesNotMatch(page, /from\("loss_draft_tracking"\)\s*\n?\s*\.update/);
  assert.doesNotMatch(page, /set_monitoring_type/);
});
