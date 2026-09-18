import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyCheckAltSettlementInvariant,
  mapCheckAltStatus,
  resolveCheckAltProviderStatus,
} from '../functions/api/providers/amounts.mjs';
import { persistPollOutcome } from '../functions/api/providers/production/checkalt-idempotency.mjs';
import { checkaltStatusReconcileEnabled, PRODUCTION_CHECKALT_FUNCTIONS } from '../functions/api/providers/production/checkalt-holds.mjs';
import { handleCheckAltStatusReconcileJob } from '../functions/api/providers/production/checkalt-status-reconcile.mjs';
import { handleScheduledRequest } from '../functions/api/scheduled.mjs';

const isBankDepositSettled = (row) => row?.status === 'cleared' && Boolean(row?.cleared_at);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPA = path.join(ROOT, '../src');

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('status map: 40 pending, 127 submitted, Approved submitted, 120 rejected, 200 needs depositDate', () => {
  assert.equal(mapCheckAltStatus({ statusCode: 40 }), 'pending_approval');
  assert.equal(mapCheckAltStatus({ status: 40 }), 'pending_approval');
  assert.equal(resolveCheckAltProviderStatus({ statusCode: 127 }), 'submitted');
  assert.equal(resolveCheckAltProviderStatus({ status: 127 }), 'submitted');
  assert.equal(resolveCheckAltProviderStatus({ status: 'Approved' }), 'submitted');
  assert.equal(resolveCheckAltProviderStatus({ status: 'approved' }), 'submitted');
  assert.equal(resolveCheckAltProviderStatus({ status: 'submitted' }), 'submitted');
  assert.equal(resolveCheckAltProviderStatus({ statusCode: 120 }), 'rejected');
  assert.equal(resolveCheckAltProviderStatus({ status: 'rejected' }), 'rejected');
  assert.equal(resolveCheckAltProviderStatus({ statusCode: 200, depositDate: '2026-09-16' }), 'cleared');
  assert.equal(resolveCheckAltProviderStatus({ statusCode: 200 }), 'submitted');
  assert.equal(resolveCheckAltProviderStatus({ status: 'Approved' }), 'submitted');
  assert.notEqual(resolveCheckAltProviderStatus({ status: 'Approved' }), 'cleared');
  assert.notEqual(resolveCheckAltProviderStatus({ statusCode: 127 }), 'cleared');
  assert.equal(resolveCheckAltProviderStatus({ statusCode: 127, depositDate: '2026-09-16' }), 'submitted');
  assert.equal(resolveCheckAltProviderStatus({ status: 'Approved', depositDate: '2026-09-16' }), 'submitted');
});

test('approval persist never stamps cleared_at', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: params[0], status: params[1], cleared_at: null }] };
    },
  };
  for (const payload of [
    { statusCode: 127, statusDescription: 'Approved' },
    { status: 'Approved' },
    { status: 'approved' },
  ]) {
    calls.length = 0;
    const saved = await persistPollOutcome(client, {
      rowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: resolveCheckAltProviderStatus(payload),
      reference: '9562-ref',
      providerPayload: payload,
    });
    assert.equal(saved.status, 'submitted');
    assert.equal(calls[0].params[1], 'submitted');
    assert.equal(calls[0].params[4], null);
    assert.match(calls[0].sql, /\$2 = 'cleared' AND \$5::timestamptz IS NOT NULL/);
  }
});

test('200 + depositDate → cleared + cleared_at; 200 without date stays submitted', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: params[0], status: params[1], cleared_at: params[1] === 'cleared' ? params[4] : null }] };
    },
  };
  const withDatePayload = { statusCode: 200, depositDate: '2026-09-16' };
  const withDateStatus = resolveCheckAltProviderStatus(withDatePayload);
  assert.equal(withDateStatus, 'cleared');
  const withDate = await persistPollOutcome(client, {
    rowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: withDateStatus,
    reference: '1',
    providerPayload: withDatePayload,
  });
  assert.equal(withDate.status, 'cleared');
  assert.equal(withDate.cleared_at, '2026-09-16T12:00:00.000Z');
  assert.equal(calls[0].params[1], 'cleared');
  assert.equal(calls[0].params[4], '2026-09-16T12:00:00.000Z');
  assert.equal(isBankDepositSettled(withDate), true);

  calls.length = 0;
  const noDatePayload = { statusCode: 200 };
  const noDateStatus = resolveCheckAltProviderStatus(noDatePayload);
  assert.equal(noDateStatus, 'submitted');
  const withoutDate = await persistPollOutcome(client, {
    rowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'cleared',
    reference: '1',
    providerPayload: noDatePayload,
  });
  assert.equal(withoutDate.status, 'submitted');
  assert.equal(withoutDate.cleared_at, null);
  assert.equal(calls[0].params[1], 'submitted');
  assert.equal(calls[0].params[4], null);
  assert.equal(isBankDepositSettled(withoutDate), false);
  assert.notEqual(withoutDate.status, 'cleared');
});

test('Bank Deposits never treats status=cleared without cleared_at as settled', () => {
  assert.equal(isBankDepositSettled({ status: 'cleared', cleared_at: '2026-09-16T12:00:00.000Z' }), true);
  assert.equal(isBankDepositSettled({ status: 'cleared', cleared_at: null }), false);
  assert.equal(isBankDepositSettled({ status: 'submitted', cleared_at: null }), false);
  assert.equal(applyCheckAltSettlementInvariant('cleared', { statusCode: 200 }), 'submitted');
  const src = fs.readFileSync(path.join(SPA, 'components/deposit-ops/BankDepositReconciliation.tsx'), 'utf8');
  assert.match(src, /isBankDepositSettled\(row\)/);
  assert.equal(/const settled = !!row\.cleared_at/.test(src), false);
});

test('scheduled CheckAlt status job stays disabled and is not a money job', async () => {
  assert.equal(checkaltStatusReconcileEnabled(), false);
  assert.equal(PRODUCTION_CHECKALT_FUNCTIONS.has('checkalt-approve-deposit'), true);
  const scheduled = fs.readFileSync(path.join(ROOT, 'functions/api/scheduled.mjs'), 'utf8');
  assert.match(scheduled, /checkalt-poll-deposits/);
  assert.match(scheduled, /handleCheckAltStatusReconcileJob/);
  assert.equal(/'checkalt-poll-deposits'/.test(scheduled.split('FINANCIAL_JOBS')[1].split(']')[0]), false);

  await withEnv({ AWS_SCHEDULED_JOB_SECRET: 'cron-secret', AWS_CHECKALT_STATUS_RECONCILE_ENABLED: undefined }, async () => {
    const disabled = await handleScheduledRequest({
      headers: { 'x-scheduled-job-secret': 'cron-secret' },
      body: JSON.stringify({ job: 'checkalt-poll-deposits' }),
    }, '/scheduled');
    assert.equal(disabled.statusCode, 403);
    assert.equal(disabled.error, 'checkalt_status_reconcile_disabled');
    assert.equal(disabled.liveProviderCalled, false);
    assert.equal(disabled.moneyMoved, false);
    assert.equal(disabled.approvePosted, false);
    assert.equal(disabled.submitPosted, false);

    const direct = await handleCheckAltStatusReconcileJob({
      headers: { 'x-scheduled-job-secret': 'cron-secret' },
      body: JSON.stringify({ job: 'checkalt-poll-deposits' }),
    });
    assert.equal(direct.error, 'checkalt_status_reconcile_disabled');
  });
});

test('Pending Approvals UI uses empty-body Poll Now and refresh-before-act responses', () => {
  const settings = fs.readFileSync(path.join(SPA, 'components/settings/CheckAltSettings.tsx'), 'utf8');
  assert.match(settings, /checkalt-poll-status/);
  assert.match(settings, /body: \{\}/);
  assert.match(settings, /already_resolved/);
  assert.match(settings, /eq\("status", "pending_approval"\)/);
  assert.match(settings, /checkalt-approve-deposit/);
});

test('Deposit Ops Manager tab is gone while the console module remains', () => {
  const hub = fs.readFileSync(path.join(SPA, 'pages/CheckCommandCenter.tsx'), 'utf8');
  assert.equal(/value="deposit_ops"/.test(hub), false);
  assert.equal(/Deposit Ops/.test(hub), false);
  assert.match(hub, /pending_approvals/);
  const ops = fs.readFileSync(path.join(SPA, 'components/deposit-ops/DepositOperationsConsole.tsx'), 'utf8');
  assert.match(ops, /deposit_action/);
  assert.match(ops, /deposit_items/);
});
