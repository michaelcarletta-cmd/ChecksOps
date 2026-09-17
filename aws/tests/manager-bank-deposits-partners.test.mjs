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
  assert.match(calls[0].sql, /COALESCE\(cleared_at, \$5::timestamptz\)/);
  assert.doesNotMatch(calls[0].sql, /COALESCE\(cleared_at, \$5::timestamptz, now\(\)\)/);
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

test('Manager tab order keeps Reports after the seven Manager items and omits Deposit Ops', () => {
  const src = fs.readFileSync(path.join(spaRoot, 'pages/CheckCommandCenter.tsx'), 'utf8');
  const triggers = [...src.matchAll(/<TabsTrigger value="([^"]+)"/g)].map((m) => m[1]);
  const manager = [];
  for (const value of triggers) {
    if ([
      'pending_approvals', 'bank_deposits', 'deposit_history', 'returned',
      'mortgage_cos', 'partners', 'homeowner_uploads', 'deposit_ops', 'reports',
    ].includes(value)) manager.push(value);
  }
  const start = manager.lastIndexOf('pending_approvals');
  const slice = manager.slice(start, start + 8);
  assert.deepEqual(slice, [
    'pending_approvals',
    'bank_deposits',
    'deposit_history',
    'returned',
    'mortgage_cos',
    'partners',
    'homeowner_uploads',
    'reports',
  ]);
  assert.equal(src.includes('value="deposit_ops"'), false);
  assert.equal(/DepositOperationsConsole/.test(src), false);
  assert.match(src, /defaultValue=\{SHOW_CHECKALT \? "pending_approvals" : "reports"\}/);
  assert.match(src, /setActiveTab\("reissue"\)/);
  assert.match(src, /<DepositReports/);
});

test('Deposit Ops backend console remains intact after Manager tab removal', () => {
  const ops = fs.readFileSync(path.join(spaRoot, 'components/deposit-ops/DepositOperationsConsole.tsx'), 'utf8');
  assert.match(ops, /export function DepositOperationsConsole/);
  assert.match(ops, /from\("deposit_items"\)/);
  assert.match(ops, /rpc\("deposit_action"/);
  assert.match(ops, /prepare_deposit/);
  assert.match(ops, /assign_provider/);
  const whiteLabel = fs.readFileSync(path.join(spaRoot, 'components/white-label/WhiteLabelSettings.tsx'), 'utf8');
  assert.equal(/DepositOperationsConsole/.test(whiteLabel), false);
});

test('Bank Deposits exposes date jump, Auto-Deposit only, and TOTAL = sum of checks', () => {
  const src = fs.readFileSync(path.join(spaRoot, 'components/deposit-ops/BankDepositReconciliation.tsx'), 'utf8');
  assert.match(src, /type="date"/);
  assert.match(src, /Jump to deposit date/);
  assert.match(src, /TenantAutoApproveCard/);
  assert.match(src, /sumDepositAmounts/);
  assert.match(src, />TOTAL</);
  assert.match(src, /bankDepositDayKey/);
  assert.equal(/CheckAltSettings/.test(src), false);
  assert.equal(/from\("checkalt_config"\)/.test(src), false);
  assert.equal(/deposit_date/.test(src), false);
});

test('SQL 35 recreates tenants_public as public-column security_invoker=false', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'rls/sql/35_manager_partner_parity.sql'), 'utf8');
  assert.match(sql, /CREATE VIEW public\.tenants_public/);
  assert.match(sql, /security_invoker = false/);
  assert.match(sql, /partner_code/);
  assert.equal(/ALTER TABLE public\.tenants/i.test(sql), false);
  assert.equal(/aws_select_tenants/i.test(sql), false);
  assert.match(sql, /checkalt_config_public/);
  assert.match(sql, /deposit_provider_config_public/);
  assert.match(sql, /aws_is_tenant_manager_admin/);
  assert.equal(/cached_jwt/.test(sql), false);
  assert.equal(/webhook_secret/.test(sql), false);
  const providerView = sql.slice(sql.indexOf('CREATE VIEW public.deposit_provider_config_public'));
  assert.equal(/^\s+config,/m.test(providerView), false);
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
