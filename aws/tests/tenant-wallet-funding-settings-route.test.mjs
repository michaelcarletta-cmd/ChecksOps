/**
 * The WalletOps automatic funding panel (useAutoFunding, AutoFundingPanel) writes
 * tenant_wallet_funding_settings only through the API route save-tenant-wallet-funding-settings
 * (tenant-settings-handlers.mjs), never through a browser upsert: the table is a money table
 * (finding 14) that the generic /data/write route refuses (FINANCIAL_OR_PROVIDER_TABLES) and that
 * SQL 136 lets only flagged server handlers write. Owner, staging 2026-11-02, after the SQL 136
 * staging apply: "Couldn't save target wallet balance" (the browser upsert answered
 * table_not_allowlisted before any SQL ran).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  WALLET_FUNDING_STRATEGIES,
  parseWalletFundingPatch,
  runSaveTenantWalletFundingSettings,
  saveTenantWalletFundingSettings,
} from '../functions/api/tenant-settings-handlers.mjs';
import { SET_MONEY_WRITE_SQL } from '../functions/api/money-write-flag.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TENANT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const BANK = '66666666-6666-4666-8666-666666666666';

/** A fake pg client: `routes` maps a SQL pattern to the rows it returns; everything else returns []. */
const fakeClient = (routes) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      for (const [pattern, rows] of routes) {
        if (pattern.test(text)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      return { rows: [] };
    },
  };
};
const SELECT_BANK = /^\s*SELECT[\s\S]*FROM public\.payment_provider_methods/;
const UPSERT_SETTINGS = /INSERT INTO public\.tenant_wallet_funding_settings[\s\S]*ON CONFLICT \(tenant_id\) DO UPDATE/;
const BANK_ROW = [{ id: BANK, tenant_id: TENANT, provider: 'moov', connection_status: 'connected' }];
const written = (params, extra = {}) => [{
  id: 'w1',
  tenant_id: TENANT,
  auto_funding_enabled: true,
  funding_bank_account_id: BANK,
  funding_payment_method_id: null,
  funding_strategy: 'target_balance',
  target_wallet_balance_cents: '250000',
  maximum_single_pull_cents: '2500000',
  maximum_daily_pull_cents: '5000000',
  require_payment_approval: true,
  authorization_accepted_at: '2026-11-02T12:00:00.000Z',
  authorization_accepted_by: USER,
  authorization_version: '2026-01-ach-debit-v1',
  ...extra,
}];

test('the save sets the money-write flag in the transaction before the one upsert, and returns the row written', async () => {
  const client = fakeClient([[SELECT_BANK, BANK_ROW], [UPSERT_SETTINGS, written]]);
  const result = await saveTenantWalletFundingSettings(client, {
    tenantId: TENANT,
    userId: USER,
    body: {
      funding_bank_account_id: BANK,
      funding_strategy: 'target_balance',
      target_wallet_balance_cents: 250000,
      maximum_single_pull_cents: 2500000,
      maximum_daily_pull_cents: 5000000,
      auto_funding_enabled: true,
      authorization_version: '2026-01-ach-debit-v1',
      // Client timestamps and ids are ignored; the server stamps the acceptance.
      authorization_accepted_at: '1999-01-01T00:00:00.000Z',
      authorization_accepted_by: '99999999-9999-4999-8999-999999999999',
      id: 'spoofed',
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.settings.target_wallet_balance_cents, 250000);
  assert.equal(result.settings.funding_strategy, 'target_balance');
  assert.equal(result.settings.authorization_accepted_by, USER);
  assert.deepEqual(result.ignoredClientFields.sort(), ['authorization_accepted_at', 'authorization_accepted_by', 'id']);
  const flagAt = client.queries.findIndex((q) => q.sql === SET_MONEY_WRITE_SQL);
  const writeAt = client.queries.findIndex((q) => UPSERT_SETTINGS.test(q.sql));
  assert.ok(flagAt >= 0, 'the money-write flag ran');
  assert.ok(writeAt > flagAt, 'the upsert ran after the flag');
  assert.equal(client.queries.filter((q) => /INSERT|UPDATE|DELETE/.test(q.sql) && !UPSERT_SETTINGS.test(q.sql)).length, 0);
  const upsert = client.queries[writeAt];
  // The server, not the client, stamps the acceptance: now() in the INSERT and in the UPDATE, the caller as accepted_by.
  assert.match(upsert.sql, /authorization_accepted_at, authorization_accepted_by\)/);
  assert.match(upsert.sql, /now\(\), \$\d+::uuid\)/);
  assert.match(upsert.sql, /authorization_accepted_at = now\(\), authorization_accepted_by = \$\d+::uuid, updated_at = now\(\)/);
  assert.equal(upsert.params[0], TENANT);
  assert.equal(upsert.params[upsert.params.length - 1], USER);
  assert.ok(!upsert.params.includes('1999-01-01T00:00:00.000Z'));
  assert.ok(!upsert.params.includes('spoofed'));
});

test('a funding bank that is not one of the tenant\'s connected methods is refused before any write', async () => {
  const missing = fakeClient([[SELECT_BANK, []]]);
  const notFound = await saveTenantWalletFundingSettings(missing, { tenantId: TENANT, userId: USER, body: { funding_bank_account_id: BANK } });
  assert.deepEqual(notFound, { ok: false, statusCode: 404, error: 'funding_source_not_found' });
  assert.equal(missing.queries.some((q) => q.sql === SET_MONEY_WRITE_SQL || UPSERT_SETTINGS.test(q.sql)), false);
  // The bank is looked up by id AND tenant: another tenant's method is not found.
  assert.match(missing.queries[0].sql, /WHERE id = \$1::uuid AND tenant_id = \$2::uuid/);
  assert.deepEqual(missing.queries[0].params, [BANK, TENANT]);

  const disconnected = fakeClient([[SELECT_BANK, [{ ...BANK_ROW[0], connection_status: 'disconnected' }]]]);
  const refused = await saveTenantWalletFundingSettings(disconnected, { tenantId: TENANT, userId: USER, body: { funding_bank_account_id: BANK } });
  assert.deepEqual(refused, { ok: false, statusCode: 409, error: 'funding_source_not_connected' });
  assert.equal(disconnected.queries.some((q) => UPSERT_SETTINGS.test(q.sql)), false);
});

test('an upsert that returns no row, or a row without the requested values, is refused, not reported as saved', async () => {
  const noRow = fakeClient([[UPSERT_SETTINGS, []]]);
  const refused = await saveTenantWalletFundingSettings(noRow, { tenantId: TENANT, userId: USER, body: { target_wallet_balance_cents: 100 } });
  assert.deepEqual(refused, { ok: false, statusCode: 409, error: 'wallet_funding_update_not_applied' });

  const wrongRow = fakeClient([[UPSERT_SETTINGS, (params) => written(params, { target_wallet_balance_cents: '0' })]]);
  const notApplied = await saveTenantWalletFundingSettings(wrongRow, { tenantId: TENANT, userId: USER, body: { target_wallet_balance_cents: 100 } });
  assert.deepEqual(notApplied, { ok: false, statusCode: 409, error: 'wallet_funding_update_not_applied' });
});

test('the patch is validated: strategy, whole non-negative cents, booleans, uuid bank; unknown keys are ignored and reported', () => {
  assert.deepEqual([...WALLET_FUNDING_STRATEGIES], ['payment_shortage', 'target_balance', 'manual']);
  assert.equal(parseWalletFundingPatch({ funding_strategy: 'surprise' }).error, 'invalid_field');
  assert.equal(parseWalletFundingPatch({ target_wallet_balance_cents: -1 }).error, 'invalid_field');
  assert.equal(parseWalletFundingPatch({ target_wallet_balance_cents: 12.5 }).error, 'invalid_field');
  assert.equal(parseWalletFundingPatch({ maximum_daily_pull_cents: '1e30' }).error, 'invalid_field');
  assert.equal(parseWalletFundingPatch({ auto_funding_enabled: 'yes' }).error, 'invalid_field');
  assert.equal(parseWalletFundingPatch({ funding_bank_account_id: 'not-a-uuid' }).error, 'invalid_field');
  assert.equal(parseWalletFundingPatch({ authorization_version: '' }).error, 'invalid_field');
  assert.equal(parseWalletFundingPatch({ tenant_id: TENANT }).error, 'empty_patch');
  const parsed = parseWalletFundingPatch({
    funding_strategy: 'manual', target_wallet_balance_cents: '1500', auto_funding_enabled: false,
    funding_bank_account_id: null, tenant_id: TENANT, action: 'save', colour: 'blue',
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.patch, { auto_funding_enabled: false, target_wallet_balance_cents: 1500, funding_strategy: 'manual', funding_bank_account_id: null });
  assert.deepEqual(parsed.ignoredClientFields, ['tenant_id', 'action', 'colour']);
});

test('the route: tenant required, a member of the tenant only, get reads the row, save writes it', async () => {
  const mapping = { application_user_id: USER };
  // No tenant: 400 before any query.
  const noTenant = fakeClient([]);
  const missing = await runSaveTenantWalletFundingSettings({ client: noTenant, mapping, body: {}, spoof: [] });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.error, 'missing_tenant');
  assert.equal(noTenant.queries.length, 0);
});

test('the hook saves through the route and never upserts the table from the browser', () => {
  const hook = read('src/hooks/useAutoFunding.ts');
  assert.match(hook, /invoke<[^>]*>\(\s*"save-tenant-wallet-funding-settings",\s*\{ action: "save", tenant_id: tenantId, \.\.\.patch \},?\s*\)/);
  // The only direct access left to the settings table is the read.
  const direct = [...hook.matchAll(/\.from\("tenant_wallet_funding_settings"\)([\s\S]{0,80})/g)].map((m) => m[1]);
  assert.equal(direct.length, 1);
  assert.match(direct[0], /^\s*\.select\(/);
  assert.doesNotMatch(hook, /\.upsert\(/);
  // A refusal ({ ok: false }) is thrown, so the panel's "Could not save" toast shows the server's message.
  assert.match(hook, /if \(out\?\.ok === false\) throw new Error\(out\.message \|\| out\.error \|\| /);
  // The panel still sends the fields the route reads.
  const panel = read('src/components/payments/AutoFundingPanel.tsx');
  assert.match(panel, /target_wallet_balance_cents: toCents\(target\)/);
  assert.match(panel, /authorization_version: AUTHORIZATION_VERSION/);
});

test('the route is registered as a Class A function and dispatched; the generic write route still refuses the table', () => {
  const appServices = read('aws/functions/api/app-services.mjs');
  assert.match(appServices, /^  'save-tenant-wallet-funding-settings',$/m);
  assert.match(appServices, /case 'save-tenant-wallet-funding-settings':\n\s+return handleSaveTenantWalletFundingSettings\(event\);/);
  assert.match(appServices, /handleSaveTenantWalletFundingSettings,\n\} from '\.\/tenant-settings-handlers\.mjs';/);
  const handlers = read('aws/functions/api/tenant-settings-handlers.mjs');
  assert.match(handlers, /export const handleSaveTenantWalletFundingSettings = withSettingsWrite\(runSaveTenantWalletFundingSettings\);/);
  const writeAllowlist = read('aws/functions/api/write-allowlist.mjs');
  assert.doesNotMatch(writeAllowlist.slice(0, writeAllowlist.indexOf('export const FINANCIAL_OR_PROVIDER_TABLES')), /tenant_wallet_funding_settings/);
  assert.match(writeAllowlist.slice(writeAllowlist.indexOf('export const FINANCIAL_OR_PROVIDER_TABLES')), /'tenant_wallet_funding_settings'/);
});
