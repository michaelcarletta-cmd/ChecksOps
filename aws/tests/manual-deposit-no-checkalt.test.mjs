import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { executeSafeWriteRpc, SAFE_DEPOSIT_ACTIONS } from '../functions/api/workflow-rpc.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const ITEM_ID = '9e3c2d4f-5a6b-4789-abcd-ef0123456789';
const BATCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const identityClient = (handler) => ({
  query: async (sql, params) => handler(sql, params),
});

const manualDepositClient = ({ globalRoles = [], memberships = [], itemOverrides = {} } = {}) => {
  const writes = [];
  const client = identityClient((sql, params) => {
    if (/FROM public.user_roles/.test(sql)) return { rows: globalRoles.map((role) => ({ role })) };
    if (/FROM public.tenant_users/.test(sql)) {
      const targetScoped = /tenant_id\s*=\s*\$2/.test(sql);
      const tenantAdmin = memberships.some((membership) => (
        membership.user_id === params[0]
        && (!targetScoped || membership.tenant_id === params[1])
        && ['admin', 'owner'].includes(membership.role.toLowerCase())
      ));
      return { rows: tenantAdmin ? [{ '?column?': 1 }] : [] };
    }
    if (/JOIN public.check_intake_items/.test(sql)) {
      return {
        rows: [{
          id: ITEM_ID,
          status: 'provider_assigned',
          amount: 25,
          check_id: CHECK_ID,
          batch_id: BATCH_ID,
          provider: 'manual_branch',
          deposit_slip_number: null,
          tenant_id: FREEDOM,
          check_status: 'approved_for_deposit',
          check_stage: 'ready_for_deposit',
          ...itemOverrides,
        }],
      };
    }
    if (/^(UPDATE|INSERT INTO public.deposit_audit_log)/.test(sql.trim())) writes.push(sql);
    return { rows: [] };
  });
  return { client, writes };
};

test('manual deposit is a safe deposit action and CheckAlt submit is not', () => {
  assert.equal(SAFE_DEPOSIT_ACTIONS.has('mark_manual_deposit'), true);
  assert.equal(SAFE_DEPOSIT_ACTIONS.has('record_submission'), false);
  assert.equal(SAFE_DEPOSIT_ACTIONS.has('record_success'), false);
  const rpc = read('aws/functions/api/workflow-rpc.mjs');
  assert.match(rpc, /provider = 'manual_branch'/);
  assert.doesNotMatch(rpc, /checkalt-submit|FinCapture|fincapture/);
  const orchestrator = read('src/lib/checkaltDepositOrchestrator.ts');
  assert.doesNotMatch(orchestrator, /mark_manual_deposit/);
  assert.doesNotMatch(orchestrator, /deposit_action/);
});

test('Mark as Deposited frontend reuses deposit_action and never calls CheckAlt', () => {
  const src = read('src/pages/CheckCommandCenter.tsx');
  assert.match(src, /Mark as Deposited/);
  assert.match(src, /p_action: "mark_manual_deposit"/);
  const moveFn = src.slice(src.indexOf('const handleMoveToDeposited'), src.indexOf('const handleDepositWithCheckAlt'));
  assert.match(moveFn, /deposit_action/);
  assert.doesNotMatch(moveFn, /runCheckAltDepositClick/);
  assert.doesNotMatch(moveFn, /checkalt-submit/);
  assert.doesNotMatch(moveFn, /checkalt_reference|provider_transaction/);
  const checkAltFn = src.slice(src.indexOf('const handleDepositWithCheckAlt'), src.indexOf('// 5-minute safeguard'));
  assert.match(checkAltFn, /runCheckAltDepositClick/);
  assert.doesNotMatch(checkAltFn, /mark_manual_deposit/);
});

test('target-tenant admin and owner can mark deposited and write audit once', async () => {
  for (const role of ['admin', 'owner']) {
    const { client, writes } = manualDepositClient({
      memberships: [{ user_id: APP_ID, tenant_id: FREEDOM, role }],
    });
    const result = await executeSafeWriteRpc({
      client,
      mapping: { application_user_id: APP_ID },
      name: 'deposit_action',
      args: { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_ID, p_notes: 'branch deposit' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.data.success, true);
    assert.equal(result.data.provider_execution, false);
    assert.equal(result.data.provider, 'manual_branch');
    assert.equal(writes.filter((sql) => /UPDATE public.check_intake_items/.test(sql)).length, 1);
    assert.equal(writes.filter((sql) => /INSERT INTO public.deposit_audit_log/.test(sql)).length, 1);
  }
});

test('ordinary target-tenant membership cannot mark a deposit manually', async () => {
  const { client, writes } = manualDepositClient({
    memberships: [{ user_id: APP_ID, tenant_id: FREEDOM, role: 'member' }],
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_ID },
  });
  assert.equal(result.error, 'not_authorized');
  assert.equal(writes.length, 0);
});

test('tenant admin from another tenant cannot manually close a target-tenant deposit', async () => {
  const { client, writes } = manualDepositClient({
    memberships: [
      { user_id: APP_ID, tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin' },
      { user_id: APP_ID, tenant_id: FREEDOM, role: 'member' },
    ],
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_ID },
  });
  assert.equal(result.error, 'not_authorized');
  assert.equal(writes.length, 0);
});

test('platform staff and admin retain manual deposit authorization without target membership', async () => {
  for (const role of ['staff', 'admin']) {
    const { client, writes } = manualDepositClient({ globalRoles: [role] });
    const result = await executeSafeWriteRpc({
      client,
      mapping: { application_user_id: APP_ID },
      name: 'deposit_action',
      args: { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_ID },
    });
    assert.equal(result.data.success, true);
    assert.equal(writes.filter((sql) => /UPDATE public.check_intake_items/.test(sql)).length, 1);
  }
});

test('manual deposit still rejects invalid terminal transitions without ledger writes', async () => {
  const { client, writes } = manualDepositClient({
    globalRoles: ['admin'],
    itemOverrides: { status: 'failed' },
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_ID },
  });
  assert.equal(result.error, 'invalid_status');
  assert.equal(writes.length, 0);
});

test('retry of mark_manual_deposit is idempotent and does not rewrite ledger rows', async () => {
  let intakeUpdates = 0;
  let batchUpdates = 0;
  const client = identityClient((sql) => {
    if (/FROM public.user_roles|SELECT role/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/FROM public.tenant_users/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/JOIN public.check_intake_items/.test(sql)) {
      return {
        rows: [{
          id: ITEM_ID,
          status: 'succeeded',
          amount: 25,
          check_id: CHECK_ID,
          batch_id: BATCH_ID,
          provider: 'manual_branch',
          deposit_slip_number: null,
          tenant_id: FREEDOM,
          check_status: 'deposited',
          check_stage: 'deposited',
        }],
      };
    }
    if (/UPDATE public.check_intake_items/.test(sql)) intakeUpdates += 1;
    if (/UPDATE public.deposit_batches/.test(sql)) batchUpdates += 1;
    return { rows: [] };
  });
  const first = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_ID },
  });
  const second = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_ID },
  });
  assert.equal(first.data.idempotent, true);
  assert.equal(second.data.idempotent, true);
  assert.equal(intakeUpdates, 0);
  assert.equal(batchUpdates, 0);
});

test('unauthorized mark_manual_deposit remains blocked', async () => {
  const { client } = manualDepositClient({ globalRoles: ['member'] });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_ID },
  });
  assert.equal(result.error, 'not_authorized');
});

test('provider money actions stay disabled', async () => {
  const client = identityClient(() => ({ rows: [{ role: 'admin' }] }));
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'record_submission', p_deposit_item_id: ITEM_ID },
  });
  assert.equal(result.error, 'rpc_financial_disabled');
});
