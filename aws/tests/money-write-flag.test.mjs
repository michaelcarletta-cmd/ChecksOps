/**
 * Security audit 2026-10-29, finding 14, step 1 of 2: every API write to a money table sets the
 * server-only request.money_write flag (money-write-flag.mjs) in its transaction before it writes,
 * or runs under a server-only GUC SQL 72 / SQL 91 already gate on. The generic /data/write route
 * never sets it. Nothing reads the flag yet (behavior-neutral); SQL 136 (step 2) will.
 * Design note: aws/docs/money-write-flag.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MONEY_WRITE_GUC,
  MONEY_WRITE_ON,
  SET_MONEY_WRITE_SQL,
  setMoneyWriteFlag,
} from '../functions/api/money-write-flag.mjs';
import { MORTGAGE_USAGE_MONEY_WRITE_SQL, accrueMortgageOpsAcceptedRequest } from '../functions/api/mortgage-ops-usage.mjs';
import { createPostgresCollectionStore } from '../functions/api/tenant-collection-v2.mjs';
import { toggleTenantAutoDebit } from '../functions/api/tenant-settings-handlers.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleWrite } from '../functions/api/write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'aws/functions/api');
const read = (rel) => fs.readFileSync(path.join(API, rel), 'utf8');

// The SQL 24 FOR ALL tables of finding 14 (stakeholder_accounts is out of scope: SQL 114).
export const MONEY_TABLES = Object.freeze([
  'ach_authorizations', 'actum_transactions', 'check_billing_events', 'claim_check_payments',
  'disbursement_splits', 'external_payment_recipients', 'micro_deposit_verifications',
  'moov_invoice_customers', 'moov_invoices', 'payment_method_verifications',
  'payment_provider_methods', 'payment_sweep_configs', 'payment_transfer_groups',
  'payment_transfers', 'payment_wallet_sub_ledgers', 'payment_wallets', 'payroll_runs',
  'stakeholder_limit_requests', 'tenant_bank_accounts', 'tenant_billing_accounts',
  'tenant_credit_balances', 'tenant_credit_transactions', 'tenant_maintenance_payments',
  'tenant_wallet_funding_settings',
]);
const writeRe = () => new RegExp(`\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?(${MONEY_TABLES.join('|')})\\b`, 'g');

// How each file's money writes are gated. A new writer file fails the inventory test until it is
// classified here (and, for step 2, in aws/docs/money-write-flag.md).
const FLAG_BEFORE_WRITE = new Set([
  'mortgage-ops-usage.mjs',
  'tenant-billing-engine.mjs',
  'tenant-billing-handlers.mjs',
  'tenant-collection-v2-settlement.mjs',
  'tenant-collection-v2-uat.mjs',
  'tenant-collection-v2.mjs',
  'tenant-settings-handlers.mjs',
]);
const FLAG_AT_ACTION_ENTRY = new Set(['invoice-provider.mjs']);
// Run only inside MOOV_PARITY_HANDLERS (moov-functions.mjs wrap sets the flag) or, for the two
// libraries, also from the production wallet callers (moov-wallet-sync sets the flag;
// moov-wallet-fund and moov-send set the SQL 72 GUCs).
const FLAG_IN_PARITY_DISPATCH = new Set([
  'providers/parity/db.mjs',
  'providers/parity/moov-functions.mjs',
  'providers/parity/moov-money.mjs',
  'providers/parity/moov-onboard.mjs',
  'providers/parity/moov-rails.mjs',
  'providers/parity/moov-wallet.mjs',
]);
const SQL72_FINANCIAL_EXECUTION = new Set([
  'providers/production/moov-send.mjs',
  'providers/production/moov-wallet-fund.mjs',
]);
const SQL91_MOOV_ONBOARDING = new Set([
  'providers/onboarding/handlers.mjs',
  'providers/onboarding/moov-sync.mjs',
]);
const SQL91_WEBHOOK_APPLY = new Set(['providers/webhook-apply.mjs']);

const apiFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(mjs|js)$/.test(entry.name)) out.push(path.relative(API, abs).split(path.sep).join('/'));
    }
  };
  walk(API);
  return out.sort();
};

const lineOf = (src, index) => src.slice(0, index).split('\n').length;
const FLAG_CALL_RE = /await setMoneyWriteFlag\(client\)|await client\.query\(MORTGAGE_USAGE_MONEY_WRITE_SQL\)/;
const FUNCTION_START_RE = /^(export\s+)?(async\s+)?function\s|^\s*async\s+[A-Za-z_]\w*\s*\([^)]*\)\s*\{\s*$|^(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/;

/** The money-write flag call nearest above each write, with no function start in between. */
const flagGapsBeforeWrites = (rel) => {
  const src = read(rel);
  const lines = src.split('\n');
  const gaps = [];
  for (const m of src.matchAll(writeRe())) {
    const at = lineOf(src, m.index);
    let ok = false;
    for (let i = at - 2; i >= 0; i -= 1) {
      if (FLAG_CALL_RE.test(lines[i])) { ok = true; break; }
      if (FUNCTION_START_RE.test(lines[i])) break;
    }
    if (!ok) gaps.push(`${rel}:${at} ${m[0]}`);
  }
  return gaps;
};

const recordingClient = (route = () => null) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      const routed = route(String(sql), params);
      return routed || { rows: [] };
    },
  };
};
const flagIndexes = (queries) => queries
  .map((q, i) => (q.sql === SET_MONEY_WRITE_SQL || q.sql === MORTGAGE_USAGE_MONEY_WRITE_SQL ? i : -1))
  .filter((i) => i >= 0);
const assertFlagBefore = (queries, pattern, label) => {
  const writes = queries.map((q, i) => (pattern.test(q.sql) ? i : -1)).filter((i) => i >= 0);
  assert.ok(writes.length > 0, `${label}: no write ran`);
  const flags = flagIndexes(queries);
  for (const w of writes) assert.ok(flags.some((f) => f < w), `${label}: write #${w} ran before the money-write flag`);
};

test('the helper sets the transaction-local server-only GUC request.money_write = 1', async () => {
  assert.equal(MONEY_WRITE_GUC, 'request.money_write');
  assert.equal(MONEY_WRITE_ON, '1');
  assert.equal(SET_MONEY_WRITE_SQL, "SELECT set_config('request.money_write', '1', true)");
  const client = recordingClient();
  await setMoneyWriteFlag(client);
  assert.deepEqual(client.queries, [{ sql: SET_MONEY_WRITE_SQL, params: [] }]);
  // mortgage-ops-usage.mjs stays import-free and inlines the same statement.
  assert.equal(MORTGAGE_USAGE_MONEY_WRITE_SQL, SET_MONEY_WRITE_SQL);
});

test('request.money_write is a new name: no other server GUC or SQL file uses it but SQL 136, which reads it', () => {
  const users = apiFiles().filter((rel) => read(rel).includes('request.money_write'));
  assert.deepEqual(users, ['money-write-flag.mjs', 'mortgage-ops-usage.mjs']);
  // Step 2 (SQL 136): the one SQL file that names it, and it only reads it (current_setting), never sets it.
  const SQL136 = '136_money_write_restrictive_policies.sql';
  for (const dir of ['aws/workflows/sql', 'aws/rls/sql', 'aws/financial/sql']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (dir === 'aws/workflows/sql' && name === SQL136) continue;
      assert.equal(fs.readFileSync(path.join(ROOT, dir, name), 'utf8').includes('money_write'), false, `${dir}/${name}`);
    }
  }
  const sql136 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql', SQL136), 'utf8').replace(/--[^\n]*/g, '');
  assert.match(sql136, /current_setting\('request\.money_write', true\) = '1'/);
  assert.doesNotMatch(sql136, /set_config\(\s*'request\.money_write'/);
});

test('inventory: every API money-table write is in a classified file', () => {
  const classified = new Set([
    ...FLAG_BEFORE_WRITE, ...FLAG_AT_ACTION_ENTRY, ...FLAG_IN_PARITY_DISPATCH,
    ...SQL72_FINANCIAL_EXECUTION, ...SQL91_MOOV_ONBOARDING, ...SQL91_WEBHOOK_APPLY,
  ]);
  const writers = apiFiles().filter((rel) => writeRe().test(read(rel)));
  assert.deepEqual(writers, [...classified].sort());
});

test('flag-before-write files set the flag above every money write, in the same function', () => {
  for (const rel of FLAG_BEFORE_WRITE) {
    assert.deepEqual(flagGapsBeforeWrites(rel), [], rel);
  }
});

test('invoice lifecycle: the flag is set once per write action, before every invoice write and SAVEPOINT', () => {
  const src = read('invoice-provider.mjs');
  const entry = src.indexOf('export async function runProviderInvoiceAction');
  const flag = src.indexOf('await setMoneyWriteFlag(client);', entry);
  assert.ok(entry > 0 && flag > entry);
  // Only preflight and list (no write) answer before it.
  const before = src.slice(entry, flag);
  assert.equal(writeRe().test(before), false);
  assert.equal(/client\.query\('SAVEPOINT/.test(before), false);
  assert.match(before, /action === 'list'/);
  const persistAt = src.indexOf('const persistInvoiceCustomer');
  for (const m of src.matchAll(writeRe())) {
    if (m.index > flag) continue;
    // The only write defined above the flag is persistInvoiceCustomer's; it is called only below it.
    assert.ok(m.index > persistAt && m.index < entry, `invoice write above the flag at line ${lineOf(src, m.index)}`);
  }
  const calls = [...src.matchAll(/await persistInvoiceCustomer\(/g)].map((m) => m.index);
  assert.ok(calls.length > 0);
  for (const call of calls) assert.ok(call > flag, `persistInvoiceCustomer called above the flag at line ${lineOf(src, call)}`);
  // invoice-actions.mjs (staging and production) reaches the writes only through this function.
  assert.equal(writeRe().test(read('invoice-actions.mjs')), false);
});

test('Moov parity dispatch sets the flag before every write-mode handler, never on the production read path', () => {
  const src = read('providers/parity/moov-functions.mjs');
  assert.match(src, /import \{ setMoneyWriteFlag \} from '\.\.\/\.\.\/money-write-flag\.mjs';/);
  const wrap = src.slice(src.indexOf('const wrap = '), src.indexOf('const accountCreate = '));
  const ctxError = wrap.indexOf('if (ctx.error) return');
  const flag = wrap.indexOf('if (!productionRead) await setMoneyWriteFlag(client);');
  const run = wrap.indexOf('handler.run({');
  assert.ok(ctxError > 0 && flag > ctxError && run > flag, 'flag after the access check, before handler.run');
  assert.match(wrap, /const identity = productionRead \? withIdentity : withIdentityWrite;/);
});

test('parity writer modules are reached only from the parity dispatch or flagged / SQL 72 production callers', () => {
  const importers = (target) => apiFiles().filter((rel) => {
    if (rel === target) return false;
    const src = read(rel);
    const spec = path.posix.relative(path.posix.dirname(rel), target);
    const rels = new Set([spec, spec.startsWith('.') ? spec : `./${spec}`]);
    return [...src.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .some((m) => rels.has(m[1] || m[2]));
  });
  assert.deepEqual(importers('providers/parity/moov-functions.mjs'), ['providers/parity/dispatch.mjs']);
  assert.deepEqual(importers('providers/parity/moov-onboard.mjs'), ['providers/parity/moov-functions.mjs']);
  assert.deepEqual(importers('providers/parity/moov-money.mjs'), ['providers/parity/moov-functions.mjs']);
  assert.deepEqual(importers('providers/parity/moov-rails.mjs'), [
    'providers/parity/moov-money.mjs', 'tenant-billing-engine.mjs',
  ]);
  // tenant-billing-engine.mjs imports only the read resolveDebitSourceMethodId.
  assert.match(read('tenant-billing-engine.mjs'), /const \{ resolveDebitSourceMethodId \} = await import\('\.\/providers\/parity\/moov-rails\.mjs'\)/);
  // syncWallet (writes) is used only by parity modules; syncWalletReadOnly (writes) by the
  // production wallet routes: moov-wallet-sync sets the flag, wallet-fund and send the SQL 72 GUCs.
  const syncWalletUsers = apiFiles().filter((rel) => /\bsyncWallet\(/.test(read(rel)) && rel !== 'providers/parity/moov-wallet.mjs');
  assert.deepEqual(syncWalletUsers, ['providers/parity/moov-functions.mjs', 'providers/parity/moov-money.mjs', 'providers/parity/moov-onboard.mjs']);
  const readOnlyUsers = apiFiles().filter((rel) => /\bsyncWalletReadOnly\(/.test(read(rel)) && rel !== 'providers/parity/moov-wallet.mjs');
  assert.deepEqual(readOnlyUsers, [
    'providers/production/moov-send.mjs', 'providers/production/moov-wallet-fund.mjs', 'providers/production/moov-wallet-sync.mjs',
  ]);
  const sync = read('providers/production/moov-wallet-sync.mjs');
  assert.ok(sync.indexOf('await setMoneyWriteFlag(client);') > 0);
  assert.ok(sync.indexOf('await setMoneyWriteFlag(client);') < sync.indexOf('syncProductionWallet({\n        client'));
  // insertTransferDraft / updateTransferAfterMoov (parity db.mjs writes) are parity-only.
  const draftUsers = apiFiles().filter((rel) => /\b(insertTransferDraft|updateTransferAfterMoov)\(/.test(read(rel)) && rel !== 'providers/parity/db.mjs');
  assert.deepEqual(draftUsers, ['providers/parity/moov-money.mjs']);
});

test('paths already gated by a server-only SQL 72 / SQL 91 GUC keep setting it', () => {
  for (const rel of SQL72_FINANCIAL_EXECUTION) assert.match(read(rel), /set_config\('request\.financial_execution', '1', true\)/, rel);
  assert.match(read('providers/onboarding/handlers.mjs'), /set_config\('request\.moov_onboarding', '1', true\)/);
  for (const rel of SQL91_WEBHOOK_APPLY) assert.match(read(rel), /set_config\('request\.provider_webhook_apply', '1', true\)/, rel);
});

test('collection v2 store: the flag runs before the obligation update and each leg write', async () => {
  const existing = { idempotency_key: 'leg-existing', status: 'submitted' };
  const client = recordingClient((sql, params) => (
    sql.includes('SELECT * FROM public.payment_transfers') && params[0] === 'leg-existing' ? { rows: [existing] } : null
  ));
  const store = await createPostgresCollectionStore(client);
  await store.putObligation({ id: '11111111-1111-4111-8111-111111111111', status: 'submitted' });
  assertFlagBefore(client.queries, /UPDATE public\.tenant_maintenance_payments/, 'putObligation');
  await store.putLeg({ idempotency_key: 'leg-new', tenant_id: '22222222-2222-4222-8222-222222222222', amount_cents: 100, leg_type: 'bank' });
  assertFlagBefore(client.queries, /INSERT INTO public\.payment_transfers/, 'putLeg insert');
  await store.putLeg({ idempotency_key: 'leg-existing', amount_cents: 100, leg_type: 'wallet' });
  assertFlagBefore(client.queries, /UPDATE public\.payment_transfers/, 'putLeg update');
});

test('billing auto-debit toggle sets the flag before the tenant_billing_accounts update', async () => {
  const client = recordingClient((sql) => {
    if (sql.includes('FROM public.tenant_billing_accounts') && sql.trim().startsWith('SELECT')) {
      return { rows: [{ id: 'a', tenant_id: 't', auto_debit_enabled: true }] };
    }
    // The update applies: it returns the row with the requested value (a no-op update is refused).
    if (/UPDATE public\.tenant_billing_accounts/.test(sql)) return { rows: [{ id: 'a', tenant_id: 't', auto_debit_enabled: false }] };
    return null;
  });
  const result = await toggleTenantAutoDebit(client, { tenantId: '33333333-3333-4333-8333-333333333333', enabled: false });
  assert.equal(result.ok, true);
  assertFlagBefore(client.queries, /UPDATE public\.tenant_billing_accounts/, 'toggleTenantAutoDebit');
});

test('Mortgage Ops accrual sets the flag before the check_billing_events insert', async () => {
  const client = recordingClient((sql, params) => {
    if (/FROM public\.mortgage_ops_billing_launch/.test(sql)) return { rows: [{ launched_at: '2026-01-01T00:00:00.000Z' }] };
    if (/FROM public\.check_intake_items/.test(sql)) return { rows: [{ claim_id: null }] };
    if (/FROM public\.tenants/.test(sql)) return { rows: [{ id: params[0] }] };
    if (/INSERT INTO public\.check_billing_events/.test(sql)) return { rows: [{ id: 'evt-1', event_type: params[2] }] };
    return null;
  });
  const result = await accrueMortgageOpsAcceptedRequest(client, {
    request: {
      id: '44444444-4444-4444-8444-444444444444',
      tenant_id: '55555555-5555-4555-8555-555555555555',
      check_intake_item_id: '66666666-6666-4666-8666-666666666666',
      status: 'in_progress',
      accepted_at: '2026-10-02T18:00:00.000Z',
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assertFlagBefore(client.queries, /INSERT INTO public\.check_billing_events/, 'accrual');
});

// ---------------------------------------------------------------- generic /data/write

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const writeEvent = (body) => ({
  rawPath: '/data/write',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/write' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});
const writeClient = () => {
  const client = recordingClient((sql, params) => {
    if (sql === LOOKUP_MAPPING_SQL) {
      return { rows: params[0] === COGNITO_SUB ? [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', status: 'active' }] : [] };
    }
    if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params?.[1] || '1' }] };
    if (sql.includes('INSERT INTO public.check_message_reads')) return { rows: [{ user_id: APP_ID, check_id: CHECK_ID }] };
    return null;
  });
  client.connect = async () => {};
  client.end = async () => {};
  return client;
};
const writeDeps = (client) => ({
  forceEnabled: true,
  loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only', host: 'db.example.internal', database: 'checksops' }),
  createClient: () => client,
});
const setsMoneyFlag = (client) => client.queries.some((q) => q.sql.includes('money_write') || q.params.includes('request.money_write'));

test('generic /data/write never sets the money-write flag (allowed write, refused money tables)', async () => {
  const allowed = writeClient();
  const ok = await handleWrite(writeEvent({ table: 'check_message_reads', op: 'upsert', values: { check_id: CHECK_ID, last_read_at: '2026-10-31T00:00:00.000Z' } }), writeDeps(allowed));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(allowed.queries.some((q) => q.sql.includes('INSERT INTO public.check_message_reads')));
  assert.equal(allowed.queries.some((q) => q.sql === 'COMMIT'), true);
  assert.equal(setsMoneyFlag(allowed), false);
  for (const table of MONEY_TABLES) {
    for (const op of ['insert', 'update', 'upsert', 'delete']) {
      const client = writeClient();
      const refused = await handleWrite(writeEvent({
        table, op, values: { tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', status: 'settled' },
        filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
      }), writeDeps(client));
      assert.equal(refused.ok, false, `${table} ${op}`);
      assert.equal(refused.statusCode, 403, `${table} ${op}`);
      assert.equal(setsMoneyFlag(client), false, `${table} ${op}`);
      assert.equal(client.queries.some((q) => writeRe().test(q.sql)), false, `${table} ${op}`);
    }
  }
});

test('the generic write and RPC modules never import or name the money-write flag', () => {
  for (const rel of ['write.mjs', 'write-check-workflow.mjs', 'write-allowlist.mjs', 'write-app-metadata.mjs', 'write-signature.mjs', 'write-claim-settlement.mjs', 'data.mjs']) {
    const src = read(rel);
    assert.equal(src.includes('money-write-flag'), false, rel);
    assert.equal(src.includes('money_write'), false, rel);
    assert.equal(src.includes('setMoneyWriteFlag'), false, rel);
  }
});
