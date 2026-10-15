import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import {
  CHECKALT_AUTO_DEPOSIT_PUBLIC,
  CHECKALT_AUTO_DEPOSIT_READ_COLUMNS,
  CHECKALT_AUTO_DEPOSIT_REGISTERED_EXPR,
  handleDataQuery,
  IS_PLATFORM_OWNER_SQL,
  autoDepositColumnSql,
} from '../functions/api/data.mjs';
import {
  autoDepositSaveMismatch,
  parseAutoDepositCeilingCents,
  resolveAutoDepositUiState,
} from '../../src/lib/autoDepositUiState.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const sourceOf = (rel) => fs.readFileSync(path.join(ROOT, '..', rel), 'utf8');

const jwtEvent = (body) => ({
  rawPath: '/data/query',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/query' },
    authorizer: {
      jwt: { claims: { sub: 'c4386408-60e1-70e2-abb6-e6194e8e635f', email: 'mcarletta@freedomadj.com', token_use: 'id' } },
    },
  },
});

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

const identityClient = ({ platformOwner = false, tenantAdminFor = FREEDOM } = {}, handler = () => ({ rows: [] })) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
      return { rows: [] };
    }
    if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (sql === LOOKUP_MAPPING_SQL) {
      return {
        rows: [{
          application_user_id: APP_ID,
          email: platformOwner ? 'checksopsadmin@gmail.com' : 'mcarletta@freedomadj.com',
          status: 'active',
        }],
      };
    }
    if (sql === USER_ROLES_SQL) return { rows: [{ role: 'admin' }] };
    if (sql === IS_PLATFORM_OWNER_SQL) return { rows: [{ is_owner: platformOwner }] };
    if (/FROM public\.tenant_users\s+WHERE user_id = \$1::uuid AND tenant_id = \$2::uuid/.test(sql)) {
      if (params[0] === APP_ID && params[1] === tenantAdminFor) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    }
    if (/SELECT tenant_id FROM public\.tenant_users WHERE user_id/.test(sql)) {
      return { rows: [{ tenant_id: tenantAdminFor }] };
    }
    return handler(sql, params);
  },
});

const queryAutoDeposit = (client, { filters = [{ column: 'tenant_id', op: 'eq', value: FREEDOM }], maybeSingle = true } = {}) => (
  handleDataQuery(jwtEvent({
    table: CHECKALT_AUTO_DEPOSIT_PUBLIC,
    select: 'tenant_id, auto_approve_enabled, auto_approve_max_cents, registered, sso_user_id, deposit_account_number, last_register_payload, email, registered_at',
    filters,
    maybeSingle,
  }), depsFor(client))
);

test('derived registered expression is non-secret and not a physical column select', () => {
  assert.equal(CHECKALT_AUTO_DEPOSIT_REGISTERED_EXPR, '(registered_at IS NOT NULL)');
  assert.equal(autoDepositColumnSql('registered'), '(registered_at IS NOT NULL) AS registered');
  assert.equal(autoDepositColumnSql('tenant_id'), 'tenant_id');
  assert.deepEqual([...CHECKALT_AUTO_DEPOSIT_READ_COLUMNS], [
    'tenant_id',
    'auto_approve_enabled',
    'auto_approve_max_cents',
    'registered',
  ]);
});

test('Freedom registered row returns registered=true and no secrets', async () => {
  const selects = [];
  const client = identityClient({ platformOwner: false }, (sql) => {
    if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
    if (sql.includes('FROM public.checkalt_tenant_accounts')) {
      selects.push(sql);
      assert.match(sql, /\(registered_at IS NOT NULL\) AS registered/);
      assert.equal(/sso_user_id/.test(sql), false);
      assert.equal(/deposit_account_number/.test(sql), false);
      assert.equal(/last_register_payload/.test(sql), false);
      assert.equal(/first_name/.test(sql), false);
      assert.equal(/last_name/.test(sql), false);
      assert.equal(/\bemail\b/.test(sql), false);
      assert.equal(/SELECT registered_at/.test(sql), false);
      return {
        rows: [{
          tenant_id: FREEDOM,
          auto_approve_enabled: false,
          auto_approve_max_cents: null,
          registered: true,
        }],
      };
    }
    return { rows: [] };
  });
  const result = await queryAutoDeposit(client);
  assert.equal(result.ok, true, result.message || result.error);
  assert.deepEqual(Object.keys(result.data).sort(), [...CHECKALT_AUTO_DEPOSIT_READ_COLUMNS].sort());
  assert.equal(result.data.tenant_id, FREEDOM);
  assert.equal(result.data.registered, true);
  assert.equal(result.data.auto_approve_enabled, false);
  assert.equal(result.data.auto_approve_max_cents, null);
  assert.equal(result.data.sso_user_id, undefined);
  assert.equal(result.data.deposit_account_number, undefined);
  assert.equal(result.data.last_register_payload, undefined);
  assert.equal(result.data.email, undefined);
  assert.equal(result.data.registered_at, undefined);
  assert.equal(selects.length, 1);
  assert.equal(resolveAutoDepositUiState(result.data), 'ready');
});

test('no row is a no-account state, not unregistered-incomplete', async () => {
  const client = identityClient({ platformOwner: false }, (sql) => {
    if (sql.includes('count(*)')) return { rows: [{ n: 0 }] };
    if (sql.includes('FROM public.checkalt_tenant_accounts')) return { rows: [] };
    return { rows: [] };
  });
  const result = await queryAutoDeposit(client);
  assert.equal(result.ok, true, result.message || result.error);
  assert.equal(result.data, null);
  assert.equal(resolveAutoDepositUiState(result.data), 'no_account');
  assert.equal(resolveAutoDepositUiState(null), 'no_account');
});

test('unregistered row returns registered=false and incomplete-registration state', async () => {
  const client = identityClient({ platformOwner: false }, (sql) => {
    if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
    if (sql.includes('FROM public.checkalt_tenant_accounts')) {
      return {
        rows: [{
          tenant_id: FREEDOM,
          auto_approve_enabled: false,
          auto_approve_max_cents: null,
          registered: false,
        }],
      };
    }
    return { rows: [] };
  });
  const result = await queryAutoDeposit(client);
  assert.equal(result.ok, true, result.message || result.error);
  assert.equal(result.data.registered, false);
  assert.equal(resolveAutoDepositUiState(result.data), 'unregistered');
});

test('loading and error do not masquerade as unregistered', () => {
  const freedomRow = {
    tenant_id: FREEDOM,
    auto_approve_enabled: false,
    auto_approve_max_cents: null,
    registered: true,
  };
  assert.equal(resolveAutoDepositUiState(undefined, { isLoading: true }), 'loading');
  assert.equal(resolveAutoDepositUiState(null, { isLoading: true }), 'loading');
  assert.equal(resolveAutoDepositUiState(freedomRow, { isLoading: true }), 'loading');
  assert.equal(resolveAutoDepositUiState(undefined, { isError: true }), 'error');
  assert.equal(resolveAutoDepositUiState(null, { isError: true }), 'error');
  assert.equal(resolveAutoDepositUiState(undefined, { isLoading: true, isError: true }), 'loading');
  assert.notEqual(resolveAutoDepositUiState(undefined, { isLoading: true }), 'unregistered');
  assert.notEqual(resolveAutoDepositUiState(undefined, { isError: true }), 'unregistered');
  assert.notEqual(resolveAutoDepositUiState(undefined, { isLoading: true }), 'no_account');
  assert.notEqual(resolveAutoDepositUiState(undefined, { isError: true }), 'no_account');
});

test('secret or physical registration columns cannot be used as Auto-Deposit filters', async () => {
  const client = identityClient({ platformOwner: false }, () => {
    throw new Error('secret filter must not reach SQL');
  });
  for (const column of ['sso_user_id', 'deposit_account_number', 'last_register_payload', 'registered_at', 'email']) {
    const result = await queryAutoDeposit(client, {
      filters: [{ column, op: 'eq', value: 'x' }],
    });
    assert.equal(result.ok, false, column);
    assert.match(String(result.message || result.error), /invalid column/);
  }
});

test('TenantAutoApproveCard uses distinct copy for each registration state', () => {
  const card = sourceOf('src/components/billing/TenantAutoApproveCard.tsx');
  assert.match(card, /resolveAutoDepositUiState/);
  assert.match(card, /isLoading, isError/);
  assert.match(card, /Loading Auto-Deposit settings/);
  assert.match(card, /Couldn't load Auto-Deposit settings/);
  assert.match(card, /No CheckAlt deposit account is on file/);
  assert.match(card, /registration isn't complete/);
  assert.match(card, /Auto-approve clean deposits/);
  assert.match(card, /Save settings/);
  assert.equal(/Your deposit account isn't registered yet/.test(card), false);
  assert.equal(/sso_user_id/.test(card), false);
  assert.equal(/deposit_account_number/.test(card), false);
  assert.equal(/last_register_payload/.test(card), false);
  assert.equal(/from\("checkalt_config"\)/.test(card), false);
});

test('Auto-Deposit ceiling parses to integer cents; blank is no ceiling; junk is refused', () => {
  assert.equal(parseAutoDepositCeilingCents(''), null);
  assert.equal(parseAutoDepositCeilingCents('   '), null);
  assert.equal(parseAutoDepositCeilingCents('2000'), 200000);
  assert.equal(parseAutoDepositCeilingCents('2000.00'), 200000);
  assert.equal(parseAutoDepositCeilingCents('0.1'), 10);
  assert.equal(parseAutoDepositCeilingCents('19.99'), 1999);
  assert.equal(parseAutoDepositCeilingCents('0'), 0);
  for (const bad of ['-1', '12.345', 'abc', '12abc', '1e5', '$20', '21474836.48']) {
    assert.equal(parseAutoDepositCeilingCents(bad), undefined, bad);
  }
});

test('Auto-Deposit save is checked against the row read back after saving', () => {
  const stored = { tenant_id: FREEDOM, auto_approve_enabled: false, auto_approve_max_cents: 200000, registered: true };
  assert.equal(autoDepositSaveMismatch({ enabled: false, maxCents: 200000 }, stored), null);
  assert.match(autoDepositSaveMismatch({ enabled: true, maxCents: 200000 }, stored), /not saved/);
  assert.match(autoDepositSaveMismatch({ enabled: false, maxCents: null }, stored), /not saved/);
  assert.match(autoDepositSaveMismatch({ enabled: false, maxCents: 200000 }, null), /could not be read back/);
  assert.equal(autoDepositSaveMismatch(
    { enabled: true, maxCents: null },
    { ...stored, auto_approve_enabled: true, auto_approve_max_cents: null },
  ), null);
});

test('TenantAutoApproveCard fails loudly when nothing is saved and shows the stored values', () => {
  const card = sourceOf('src/components/billing/TenantAutoApproveCard.tsx');
  assert.match(card, /\.eq\("tenant_id", tenantId\)\s*\.select\("tenant_id, auto_approve_enabled, auto_approve_max_cents"\)/);
  assert.match(card, /if \(!saved\) \{\s*throw new Error/);
  assert.match(card, /qc\.fetchQuery\(\{ queryKey, queryFn: readAccount, staleTime: 0 \}\)/);
  assert.match(card, /showStored\(stored\)/);
  assert.match(card, /autoDepositSaveMismatch\(/);
  assert.match(card, /parseAutoDepositCeilingCents\(maxDollars\)/);
  assert.equal(/parseFloat/.test(card), false);
  // A failed read-back after a confirmed save is not a failure: show the saved row and refresh.
  const refreshCatch = card.slice(card.indexOf('} catch {'), card.indexOf('showStored(stored);'));
  assert.match(refreshCatch, /showStored\(saved as AutoDepositPublicRow\)/);
  assert.match(refreshCatch, /qc\.invalidateQueries\(\{ queryKey \}\)/);
  assert.match(refreshCatch, /return \{ refreshed: false \}/);
  assert.equal(/throw/.test(refreshCatch), false);
  assert.match(card, /couldn't refresh/);
  assert.match(card, /autoDepositSaveMismatch\(wanted, saved as AutoDepositPublicRow\)/);
  const successAt = card.indexOf('toast.success("Auto-approve settings saved")');
  assert.ok(successAt > card.indexOf('if (mismatch) throw new Error(mismatch);'));
});
