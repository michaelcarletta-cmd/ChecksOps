/**
 * save-tenant-wallet-withdraw-limits: the tenant's transfer-to-bank limits (SQL 164 columns). Owner
 * decision 2026-11-13: "Yes, require two-factor" — saving needs the wallet.fund step-up; membership is
 * the funding-settings check; only the two limit columns are written.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SET_MONEY_WRITE_SQL } from '../functions/api/money-write-flag.mjs';
import {
  WALLET_WITHDRAW_LIMIT_COLUMNS,
  parseWithdrawLimitsPatch,
  runSaveTenantWalletWithdrawLimits,
} from '../functions/api/wallet-withdraw-limits.mjs';
import { minutesAgo, stepUpWithinWindow } from './helpers/financial-stepup-window.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TENANT = '33333333-3333-4333-8333-333333333333';
const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
const USER = '44444444-4444-4444-8444-444444444444';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const ORIGIN_JTI = 'b2c3d4e5-aaaa-4bbb-8ccc-000011112222';
const LOGIN = `${SUB}:jti:${ORIGIN_JTI}`;
const CLAIMS = { sub: SUB, origin_jti: ORIGIN_JTI };
const mapping = { application_user_id: USER };
const STEP_UP = { id: 'stepup-1', user_id: USER, tenant_id: TENANT, action_key: 'wallet.fund', login_session: LOGIN };

const fakeClient = ({ member = true, stepUps = [STEP_UP], row = null, missingColumns = false } = {}) => {
  const queries = [];
  let stored = row ? { ...row } : null;
  return {
    queries,
    get stored() { return stored; },
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes('FROM public.tenant_users')) return { rows: member && params[0] === TENANT && params[1] === USER ? [{ role: 'member' }] : [] };
      if (text.includes('is_master_owner')) return { rows: [{ is_master: false }] };
      if (text.includes('FROM public.financial_stepup_log')) {
        const [userId, tenantId, action, login] = params;
        return {
          rows: stepUps.filter((s) => s.user_id === userId && s.tenant_id === tenantId && s.action_key === action && s.login_session === login
            && stepUpWithinWindow(text, params, s)).map((s) => ({ id: s.id, created_at: s.created_at ?? new Date().toISOString() })),
        };
      }
      if (/wallet_withdraw_max_/.test(text) && missingColumns) {
        const error = new Error('column "wallet_withdraw_max_per_transfer_cents" does not exist'); error.code = '42703'; throw error;
      }
      if (text.startsWith('SELECT wallet_withdraw_max_')) return { rows: stored ? [stored] : [] };
      if (text.includes('INSERT INTO public.tenant_wallet_funding_settings')) {
        const columns = text.match(/\(tenant_id, ([^)]+)\)/)[1].split(', ');
        stored = { ...(stored || {}) };
        columns.forEach((c, i) => { stored[c] = params[i + 1] === null ? null : String(params[i + 1]); });
        return { rows: [stored] };
      }
      return { rows: [] };
    },
  };
};

const save = (client, body, claims = CLAIMS) => runSaveTenantWalletWithdrawLimits({
  client, mapping, claims, body: { tenant_id: TENANT, action: 'save', ...body }, spoof: [],
});

test('saving writes only the two limit columns, with the money-write flag, after a fresh wallet.fund step-up', async () => {
  const client = fakeClient();
  const result = await save(client, { wallet_withdraw_max_per_transfer_cents: 500000, wallet_withdraw_max_per_day_cents: '2000000' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.limits, { wallet_withdraw_max_per_transfer_cents: 500000, wallet_withdraw_max_per_day_cents: 2000000 });
  assert.equal(result.stepup_id, 'stepup-1');
  const upsertAt = client.queries.findIndex((q) => q.sql.includes('INSERT INTO public.tenant_wallet_funding_settings'));
  const flagAt = client.queries.findIndex((q) => q.sql === SET_MONEY_WRITE_SQL);
  const stepUpAt = client.queries.findIndex((q) => q.sql.includes('financial_stepup_log'));
  assert.ok(stepUpAt >= 0 && stepUpAt < flagAt && flagAt < upsertAt);
  const upsert = client.queries[upsertAt].sql;
  assert.match(upsert, /\(tenant_id, wallet_withdraw_max_per_transfer_cents, wallet_withdraw_max_per_day_cents\)/);
  assert.match(upsert, /DO UPDATE SET wallet_withdraw_max_per_transfer_cents = EXCLUDED\.wallet_withdraw_max_per_transfer_cents, wallet_withdraw_max_per_day_cents = EXCLUDED\.wallet_withdraw_max_per_day_cents\s/);
  // No other column (not updated_at, not a funding setting) is written; RETURNING reads only the limits.
  const written = upsert.slice(upsert.indexOf('DO UPDATE SET'), upsert.indexOf('RETURNING'));
  assert.deepEqual([...written.matchAll(/(\w+) = EXCLUDED/g)].map((m) => m[1]), [...WALLET_WITHDRAW_LIMIT_COLUMNS]);
  assert.doesNotMatch(upsert, /updated_at|auto_funding|maximum_|RETURNING \*/);
  assert.equal(client.queries.filter((q) => /INSERT|UPDATE|DELETE/.test(q.sql) && !q.sql.includes('SAVEPOINT')).length, 1);
});

test('one limit at a time; empty or null clears it (no limit)', async () => {
  const client = fakeClient({ row: { wallet_withdraw_max_per_transfer_cents: '100', wallet_withdraw_max_per_day_cents: '900' } });
  const result = await save(client, { wallet_withdraw_max_per_day_cents: null });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.limits, { wallet_withdraw_max_per_transfer_cents: 100, wallet_withdraw_max_per_day_cents: null });
  const upsert = client.queries.find((q) => q.sql.includes('INSERT INTO')).sql;
  assert.match(upsert, /\(tenant_id, wallet_withdraw_max_per_day_cents\)/);
  assert.doesNotMatch(upsert.slice(0, upsert.indexOf('RETURNING')), /per_transfer/);
});

test('without a fresh wallet.fund step-up in this login, nothing is written', async () => {
  for (const [stepUps, claims] of [
    [[], CLAIMS],
    [[STEP_UP], { sub: SUB, origin_jti: 'another-login' }],
    [[{ ...STEP_UP, action_key: 'deposit.submit' }], CLAIMS],
    [[{ ...STEP_UP, tenant_id: OTHER_TENANT }], CLAIMS],
    [[{ ...STEP_UP, created_at: minutesAgo(16) }], CLAIMS],
  ]) {
    const client = fakeClient({ stepUps });
    const result = await save(client, { wallet_withdraw_max_per_transfer_cents: 100 }, claims);
    assert.equal(result.statusCode, 401, JSON.stringify(result));
    assert.equal(result.error, 'totp_required');
    assert.equal(result.actionKey, 'wallet.fund');
    assert.equal(client.stored, null);
    assert.ok(!client.queries.some((q) => q.sql.includes('INSERT INTO') || q.sql === SET_MONEY_WRITE_SQL));
  }
});

test('membership: the same check as funding settings; non-members and a missing tenant write nothing', async () => {
  const outsider = fakeClient({ member: false });
  const denied = await save(outsider, { wallet_withdraw_max_per_transfer_cents: 100 });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.error, 'cross_tenant_denied');
  assert.equal(outsider.stored, null);
  assert.ok(!outsider.queries.some((q) => q.sql.includes('financial_stepup_log')));

  const noTenant = fakeClient();
  const missing = await runSaveTenantWalletWithdrawLimits({ client: noTenant, mapping, claims: CLAIMS, body: { wallet_withdraw_max_per_day_cents: 1 }, spoof: [] });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.error, 'missing_tenant');
  assert.equal(noTenant.queries.length, 0);
});

test('reading the limits needs membership but no step-up', async () => {
  const client = fakeClient({ stepUps: [], row: { wallet_withdraw_max_per_transfer_cents: '2500', wallet_withdraw_max_per_day_cents: null } });
  const result = await runSaveTenantWalletWithdrawLimits({ client, mapping, claims: CLAIMS, body: { tenant_id: TENANT, action: 'get' }, spoof: [] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.limits, { wallet_withdraw_max_per_transfer_cents: 2500, wallet_withdraw_max_per_day_cents: null });
  const none = await runSaveTenantWalletWithdrawLimits({ client: fakeClient(), mapping, claims: CLAIMS, body: { tenant_id: TENANT, action: 'get' }, spoof: [] });
  assert.deepEqual(none.limits, { wallet_withdraw_max_per_transfer_cents: null, wallet_withdraw_max_per_day_cents: null });
  const outsider = await runSaveTenantWalletWithdrawLimits({ client: fakeClient({ member: false }), mapping, claims: CLAIMS, body: { tenant_id: TENANT, action: 'get' }, spoof: [] });
  assert.equal(outsider.statusCode, 403);
});

test('if the SQL 164 columns were missing (applied in both environments; the guard stays) the route answers 503 and writes nothing', async () => {
  const client = fakeClient({ missingColumns: true });
  const result = await save(client, { wallet_withdraw_max_per_transfer_cents: 100 });
  assert.equal(result.statusCode, 503, JSON.stringify(result));
  assert.equal(result.error, 'limits_not_ready');
  assert.ok(client.queries.some((q) => q.sql.startsWith('ROLLBACK TO SAVEPOINT')));
  const get = await runSaveTenantWalletWithdrawLimits({ client: fakeClient({ missingColumns: true }), mapping, claims: CLAIMS, body: { tenant_id: TENANT, action: 'get' }, spoof: [] });
  assert.equal(get.statusCode, 503);
});

test('values: null/empty (no limit) or whole cents from 1; nothing else; at least one limit', () => {
  for (const bad of [0, -1, 12.5, '1e3', 'abc', true, 100_000_000_001]) {
    assert.equal(parseWithdrawLimitsPatch({ wallet_withdraw_max_per_day_cents: bad }).error, 'invalid_field', String(bad));
  }
  assert.equal(parseWithdrawLimitsPatch({}).error, 'empty_patch');
  assert.equal(parseWithdrawLimitsPatch({ maximum_daily_pull_cents: 5, auto_funding_enabled: true }).error, 'empty_patch');
  assert.deepEqual(parseWithdrawLimitsPatch({ wallet_withdraw_max_per_transfer_cents: '1500', wallet_withdraw_max_per_day_cents: '' }).patch, {
    wallet_withdraw_max_per_transfer_cents: 1500, wallet_withdraw_max_per_day_cents: null,
  });
});

test('the route is a Class A app service, dispatched to this handler', () => {
  const appServices = read('aws/functions/api/app-services.mjs');
  assert.match(appServices, /^  'save-tenant-wallet-withdraw-limits',$/m);
  assert.match(appServices, /case 'save-tenant-wallet-withdraw-limits':\n\s+return handleSaveTenantWalletWithdrawLimits\(event\);/);
});
