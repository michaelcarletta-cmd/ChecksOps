import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { persistPollOutcome } from '../functions/api/providers/production/checkalt-idempotency.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const spaRoot = path.join(ROOT, '../src');

test('persistPollOutcome stamps cleared_at from FinCapture depositDate, not poll now()', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: params[0], status: params[1], cleared_at: params[4] }] };
    },
  };
  const saved = await persistPollOutcome(client, {
    rowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'cleared',
    reference: '12345',
    providerPayload: { statusCode: 200, history: { depositDate: '2026-09-16' } },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /COALESCE\(cleared_at, \$5::timestamptz, now\(\)\)/);
  assert.equal(calls[0].params[4], '2026-09-16T12:00:00.000Z');
  assert.match(String(calls[0].params[3]), /2026-09-16T12:00:00.000Z/);
  assert.equal(saved.cleared_at, '2026-09-16T12:00:00.000Z');
});

test('persistPollOutcome does not invent a date from submittedDate', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: params[0] }] };
    },
  };
  await persistPollOutcome(client, {
    rowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'cleared',
    reference: '12345',
    providerPayload: { submittedDate: '2026-09-01', createdDate: '2026-09-02' },
  });
  assert.equal(calls[0].params[4], null);
});

test('Manager tab order keeps Deposit Ops and Reports after the eight Manager items', () => {
  const src = fs.readFileSync(path.join(spaRoot, 'pages/CheckCommandCenter.tsx'), 'utf8');
  const triggers = [...src.matchAll(/<TabsTrigger value="([^"]+)"/g)].map((m) => m[1]);
  const manager = [];
  for (const value of triggers) {
    if ([
      'pending_approvals', 'bank_deposits', 'deposit_history', 'returned',
      'mortgage_cos', 'partners', 'homeowner_uploads', 'deposit_ops', 'reports',
    ].includes(value)) manager.push(value);
  }
  // Last occurrence of this block is the Manager hub (unique pending_approvals).
  const start = manager.lastIndexOf('pending_approvals');
  const slice = manager.slice(start, start + 9);
  assert.deepEqual(slice, [
    'pending_approvals',
    'bank_deposits',
    'deposit_history',
    'returned',
    'mortgage_cos',
    'partners',
    'homeowner_uploads',
    'deposit_ops',
    'reports',
  ]);
  assert.match(src, /setActiveTab\("reissue"\)/);
  assert.match(src, /<DepositOperationsConsole/);
  assert.match(src, /<DepositReports/);
});

test('Bank Deposits exposes date jump, CheckAlt Settings, and TOTAL = sum of checks', () => {
  const src = fs.readFileSync(path.join(spaRoot, 'components/deposit-ops/BankDepositReconciliation.tsx'), 'utf8');
  assert.match(src, /type="date"/);
  assert.match(src, /Jump to deposit date/);
  assert.match(src, /CheckAlt Settings/);
  assert.match(src, /sumDepositAmounts/);
  assert.match(src, />TOTAL</);
  assert.match(src, /bankDepositDayKey/);
  assert.equal(/deposit_date/.test(src), false);
});

test('this change does not rewrite Partner Codes or shared_checks', () => {
  const partnerSql = fs.readFileSync(path.join(ROOT, 'rls/sql/32_partner_share_lifecycle.sql'), 'utf8');
  const immutability = fs.readFileSync(
    path.join(ROOT, '../supabase/migrations/20260913120000_partner_code_immutability.sql'),
    'utf8',
  );
  assert.match(partnerSql, /aws_connect_partner_by_code/);
  assert.match(partnerSql, /aws_share_check_with_partner/);
  assert.match(immutability, /tenants\.partner_code is immutable once assigned/);
});
