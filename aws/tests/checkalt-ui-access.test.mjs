import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import {
  CHECKALT_AUTO_DEPOSIT_PUBLIC,
  CHECKALT_AUTO_DEPOSIT_READ_COLUMNS,
  handleDataQuery,
  IS_PLATFORM_OWNER_SQL,
} from '../functions/api/data.mjs';
import {
  SAFE_WRITE_RPCS,
  AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL,
  executeSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';
import {
  buildDepositProcessBody,
  buildRegisterPayload,
  LOVABLE_PROCESS_BODY_KEYS,
} from '../functions/api/providers/parity/checkalt-client.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const spaRoot = path.join(ROOT, '../src');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';

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

const identityClient = ({ platformOwner = false, tenantAdminFor = FREEDOM } = {}, handler = () => ({ rows: [] })) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
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
      if (sql === USER_ROLES_SQL) return { rows: [{ role: platformOwner ? 'admin' : 'admin' }] };
      if (sql === IS_PLATFORM_OWNER_SQL) return { rows: [{ is_owner: platformOwner }] };
      if (/FROM public\.tenant_users/.test(sql) && /lower\(role::text\) IN \('admin', 'owner'\)/.test(sql)) {
        const userId = params[0];
        const tenantId = params[1];
        if (userId === APP_ID && tenantId === tenantAdminFor) return { rows: [{ '?column?': 1 }] };
        return { rows: [] };
      }
      if (/SELECT tenant_id FROM public\.tenant_users WHERE user_id/.test(sql)) {
        return { rows: [{ tenant_id: tenantAdminFor }] };
      }
      return handler(sql, params, queries);
    },
  };
};

test('Manager Bank Deposits shows Auto-Deposit only', () => {
  const bank = sourceOf('src/components/deposit-ops/BankDepositReconciliation.tsx');
  const card = sourceOf('src/components/billing/TenantAutoApproveCard.tsx');
  assert.match(bank, /TenantAutoApproveCard/);
  assert.match(card, /Auto-Deposit/);
  assert.equal(/CheckAltSettings/.test(bank), false);
  assert.equal(/from\("checkalt_config"\)/.test(bank), false);
  assert.equal(/Base URL/.test(bank), false);
  assert.equal(/FI Key/.test(bank), false);
  assert.equal(/Business Unit/.test(bank), false);
  assert.equal(/Register account/.test(bank), false);
  assert.equal(/checkalt-test-connection/.test(bank), false);
  assert.equal(/checkalt-register-account/.test(bank), false);
  assert.equal(/depositor_account_id/.test(card), false);
  assert.equal(/sso_user_id/.test(card), false);
  assert.equal(/last_register_payload/.test(card), false);
  assert.equal(/deposit_account_number/.test(card), false);
});

test('Tenant admin cannot access or save global CheckAlt settings', async () => {
  const settings = sourceOf('src/components/settings/CheckAltSettings.tsx');
  const admin = sourceOf('src/pages/admin/AdminTenants.tsx');
  assert.match(settings, /isPlatformOwner/);
  assert.match(settings, /restricted to the platform owner/);
  assert.match(admin, /isPlatformOwner/);
  assert.match(admin, /CheckAltSettings/);
  assert.equal(SAFE_WRITE_RPCS.has('save_checkalt_settings'), true);

  const client = identityClient({ platformOwner: false }, (sql) => {
    if (/UPDATE public.checkalt_config/.test(sql)) {
      throw new Error('tenant admin must not update checkalt_config');
    }
    return { rows: [] };
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_settings',
    args: { merchant: 'stolen', business_unit: 'NOPE', fi_key: 'x' },
  });
  assert.equal(result.error, 'not_authorized');
  assert.equal(client.queries.some((q) => /UPDATE public.checkalt_config/.test(q.sql)), false);
});

test('Platform owner can still access global CheckAlt settings', async () => {
  const settings = sourceOf('src/components/settings/CheckAltSettings.tsx');
  const admin = sourceOf('src/pages/admin/AdminTenants.tsx');
  assert.match(settings, /id="base_url"/);
  assert.match(settings, /id="merchant"/);
  assert.match(settings, /id="fi_key"/);
  assert.match(settings, /id="business_unit"/);
  assert.match(settings, /id="depositor_account_id"/);
  assert.match(settings, /id="default_enabled"/);
  assert.match(settings, /checkalt-test-connection/);
  assert.match(settings, /checkalt-poll-status/);
  assert.match(settings, /CHECKALT_USERNAME/);
  assert.match(admin, /<TabsTrigger value="checkalt"/);
  assert.match(admin, /<CheckAltSettings \/>/);
  assert.equal(/<CheckAltTenantAccountCard/.test(settings), false);

  const client = identityClient({ platformOwner: true }, (sql, params) => {
    if (/UPDATE public.checkalt_config/.test(sql)) {
      assert.match(sql, /merchant = \$1/);
      assert.equal(params[0], 'lockbox5');
      return { rows: [{ singleton: true, merchant: 'lockbox5' }] };
    }
    return { rows: [] };
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_settings',
    args: { merchant: 'lockbox5', notes: 'platform' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.data.merchant, 'lockbox5');
});

test('Tenant Management selected-tenant register UI remains tenant-scoped', () => {
  const admin = sourceOf('src/pages/admin/AdminTenants.tsx');
  const card = sourceOf('src/components/settings/CheckAltTenantAccountCard.tsx');
  const integrations = admin.slice(admin.indexOf('value="integrations"'));
  assert.match(integrations, /CheckAltTenantAccountCard/);
  assert.equal(/<CheckAltSettings \/>/.test(integrations.slice(0, 800)), false);
  assert.match(card, /eq\("tenant_id", tenant!\.id\)/);
  assert.match(card, /sso_user_id/);
  assert.match(card, /first_name/);
  assert.match(card, /last_name/);
  assert.match(card, /deposit_account_number/);
  assert.match(card, /registered_at/);
  assert.match(card, /last_register_payload/);
  assert.equal(/from\("checkalt_config"\)/.test(card), false);
  assert.equal(/id="base_url"/.test(card), false);
  assert.equal(/id="fi_key"/.test(card), false);
  assert.equal(/id="business_unit"/.test(card), false);
  assert.equal(/checkalt-test-connection/.test(card), false);
  assert.doesNotMatch(card, /functions\.invoke\(/);
});

test('tenant Manager Auto-Deposit read returns only Auto-Deposit fields + tenant ID + registered', async () => {
  const card = sourceOf('src/components/billing/TenantAutoApproveCard.tsx');
  assert.match(card, /from\("checkalt_tenant_auto_deposit_public"/);
  assert.match(card, /select\("tenant_id, auto_approve_enabled, auto_approve_max_cents, registered"\)/);
  assert.deepEqual([...CHECKALT_AUTO_DEPOSIT_READ_COLUMNS], [
    'tenant_id',
    'auto_approve_enabled',
    'auto_approve_max_cents',
    'registered',
  ]);
  const selects = [];
  const client = identityClient({ platformOwner: false }, (sql) => {
    if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
    if (sql.includes('FROM public.checkalt_tenant_accounts')) {
      selects.push(sql);
      assert.match(sql, /tenant_id/);
      assert.match(sql, /auto_approve_enabled/);
      assert.match(sql, /auto_approve_max_cents/);
      assert.match(sql, /\(registered_at IS NOT NULL\) AS registered/);
      assert.equal(/sso_user_id/.test(sql), false);
      assert.equal(/deposit_account_number/.test(sql), false);
      assert.equal(/last_register_payload/.test(sql), false);
      assert.equal(/first_name/.test(sql), false);
      assert.equal(/SELECT \*/.test(sql), false);
      return {
        rows: [{
          tenant_id: FREEDOM,
          auto_approve_enabled: true,
          auto_approve_max_cents: 25000,
          registered: true,
        }],
      };
    }
    return { rows: [] };
  });
  const result = await handleDataQuery(jwtEvent({
    table: CHECKALT_AUTO_DEPOSIT_PUBLIC,
    select: 'tenant_id, auto_approve_enabled, auto_approve_max_cents, sso_user_id, deposit_account_number, registered_at',
    filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
    maybeSingle: true,
  }), depsFor(client));
  assert.equal(result.ok, true, result.message || result.error);
  assert.deepEqual(Object.keys(result.data).sort(), [...CHECKALT_AUTO_DEPOSIT_READ_COLUMNS].sort());
  assert.equal(result.data.sso_user_id, undefined);
  assert.equal(result.data.deposit_account_number, undefined);
  assert.equal(result.data.registered_at, undefined);
  assert.equal(result.data.registered, true);
  assert.equal(selects.length, 1);
});

test('tenant users cannot read global CheckAlt configuration', async () => {
  const client = identityClient({ platformOwner: false }, (sql) => {
    if (sql.includes('FROM public.checkalt_config')) {
      throw new Error('tenant user must not read checkalt_config');
    }
    return { rows: [] };
  });
  for (const table of ['checkalt_config', 'checkalt_config_public']) {
    const result = await handleDataQuery(jwtEvent({
      table,
      select: '*',
      filters: [{ column: 'singleton', op: 'eq', value: true }],
      maybeSingle: true,
    }), depsFor(client));
    assert.equal(result.ok, false, table);
    assert.equal(result.error, 'not_authorized', table);
  }
});

test('tenant users cannot read full checkalt_tenant_accounts', async () => {
  const client = identityClient({ platformOwner: false }, (sql) => {
    if (sql.includes('FROM public.checkalt_tenant_accounts') && !sql.includes('auto_approve_enabled')) {
      throw new Error('tenant user must not read full checkalt_tenant_accounts');
    }
    return { rows: [] };
  });
  const result = await handleDataQuery(jwtEvent({
    table: 'checkalt_tenant_accounts',
    select: 'sso_user_id, deposit_account_number, last_register_payload',
    filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
    maybeSingle: true,
  }), depsFor(client));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_authorized');
});

test('Platform Owner/Tenant Management can still access administrative account information', async () => {
  const card = sourceOf('src/components/settings/CheckAltTenantAccountCard.tsx');
  assert.match(card, /from\("checkalt_tenant_accounts"\)/);
  assert.match(card, /sso_user_id, deposit_account_number, first_name, last_name, email, enabled, registered_at, last_register_payload/);
  const client = identityClient({ platformOwner: true }, (sql) => {
    if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
    if (sql.includes('FROM public.checkalt_tenant_accounts')) {
      return {
        rows: [{
          tenant_id: FREEDOM,
          sso_user_id: 'mcarletta',
          deposit_account_number: '90001111',
          first_name: 'Mike',
          last_name: 'Carletta',
          email: 'mcarletta@freedomadj.com',
          enabled: true,
          registered_at: '2026-01-01T00:00:00.000Z',
          last_register_payload: { status: 'ok' },
        }],
      };
    }
    if (sql.includes('FROM public.checkalt_config_public')) {
      return { rows: [{ singleton: true, merchant: 'lockbox5', fi_key: 'fi' }] };
    }
    return { rows: [] };
  });
  const account = await handleDataQuery(jwtEvent({
    table: 'checkalt_tenant_accounts',
    select: 'sso_user_id, deposit_account_number, first_name, last_name, email, enabled, registered_at, last_register_payload',
    filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
    maybeSingle: true,
  }), depsFor(client));
  assert.equal(account.ok, true, account.message || account.error);
  assert.equal(account.data.sso_user_id, 'mcarletta');
  assert.equal(account.data.deposit_account_number, '90001111');
  assert.equal(account.data.last_register_payload.status, 'ok');

  const cfg = await handleDataQuery(jwtEvent({
    table: 'checkalt_config',
    select: '*',
    filters: [{ column: 'singleton', op: 'eq', value: true }],
    maybeSingle: true,
  }), depsFor(client));
  assert.equal(cfg.ok, true, cfg.message || cfg.error);
  assert.equal(cfg.data.merchant, 'lockbox5');
});

test('Auto-Deposit still reads/writes the existing tenant columns only', async () => {
  const card = sourceOf('src/components/billing/TenantAutoApproveCard.tsx');
  const clientSrc = sourceOf('src/integrations/aws/client.ts');
  assert.match(card, /from\("checkalt_tenant_auto_deposit_public"/);
  assert.match(card, /select\("tenant_id, auto_approve_enabled, auto_approve_max_cents, registered"\)/);
  assert.match(card, /auto_approve_enabled: enabled/);
  assert.match(card, /auto_approve_max_cents: cents/);
  assert.equal(/sso_user_id/.test(card), false);
  assert.equal(/deposit_account_number/.test(card), false);
  assert.equal(/last_register_payload/.test(card), false);
  assert.equal(/business_unit/.test(card), false);
  assert.match(clientSrc, /save_checkalt_tenant_auto_deposit/);
  assert.match(clientSrc, /Only auto_approve_enabled and auto_approve_max_cents may be updated/);
  assert.equal(SAFE_WRITE_RPCS.has('save_checkalt_tenant_auto_deposit'), true);

  const persistCalls = [];
  const client = identityClient({ platformOwner: false }, (sql, params) => {
    if (sql === AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL) {
      persistCalls.push({ sql, params });
      assert.equal(params[0], FREEDOM);
      assert.deepEqual(params[1], { auto_approve_enabled: true, auto_approve_max_cents: 10000 });
      return {
        rows: [{
          result: {
            tenant_id: FREEDOM,
            auto_approve_enabled: true,
            auto_approve_max_cents: 10000,
          },
        }],
      };
    }
    if (/UPDATE public.checkalt_tenant_accounts/.test(sql)) {
      throw new Error('generic UPDATE checkalt_tenant_accounts must not be used');
    }
    return { rows: [] };
  });
  const ok = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_auto_deposit',
    args: { tenant_id: FREEDOM, auto_approve_enabled: true, auto_approve_max_cents: 10000 },
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.data.auto_approve_enabled, true);
  assert.equal(ok.data.auto_approve_max_cents, 10000);
  assert.equal(persistCalls.length, 1);

  const deniedOtherTenant = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_auto_deposit',
    args: { tenant_id: OTHER_TENANT, auto_approve_enabled: true },
  });
  assert.equal(deniedOtherTenant.error, 'not_authorized');

  const deniedGeneric = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_auto_deposit',
    args: {
      tenant_id: FREEDOM,
      auto_approve_enabled: true,
      sso_user_id: 'stolen',
      deposit_account_number: '999999',
    },
  });
  assert.equal(deniedGeneric.error, 'invalid_field');
  assert.equal(deniedGeneric.field, 'sso_user_id');
});

test('Existing CheckAlt provider request builders are unchanged', () => {
  const client = sourceOf('aws/functions/api/providers/parity/checkalt-client.mjs');
  const body = buildDepositProcessBody({
    fiKey: 'fi',
    ssoKey: 'sso',
    depositAccountNumber: '90001111',
    captureDateTime: '2026-01-01T00:00:00.000Z',
    userAmount: 12345,
    frontImage: 'Zm9v',
    rearImage: 'YmFy',
  });
  assert.deepEqual(Object.keys(body), LOVABLE_PROCESS_BODY_KEYS);
  assert.equal(body.businessUnit, undefined);
  assert.equal(body.testDeposit, undefined);
  const register = buildRegisterPayload({
    fiKey: 'fi',
    ssoUserId: 'user-1',
    firstName: 'A',
    lastName: 'B',
    email: 'a@b.com',
    depositAccountNumber: '90001111',
  });
  assert.equal(register.businessUnit, undefined);
  assert.equal(register.userId, 'user-1');
  assert.match(client, /export function buildDepositProcessBody/);
  assert.match(client, /export function buildRegisterPayload/);
  assert.equal(/36_checkalt/.test(client), false);
});

test('this change does not add SQL 36 or tenant business_unit', () => {
  const sql36 = path.join(ROOT, 'rls/sql/36_checkalt_tenant_split.sql');
  assert.equal(fs.existsSync(sql36), false);
  const sql37 = fs.readFileSync(path.join(ROOT, 'rls/sql/37_checkalt_ui_access_reads.sql'), 'utf8');
  assert.match(sql37, /CREATE VIEW public\.checkalt_config_public/);
  assert.match(sql37, /WHERE public\.is_platform_owner\(\)/);
  assert.match(sql37, /CREATE VIEW public\.checkalt_tenant_auto_deposit_public/);
  const autoSelect = sql37.slice(
    sql37.indexOf('CREATE VIEW public.checkalt_tenant_auto_deposit_public'),
    sql37.indexOf('COMMENT ON VIEW public.checkalt_tenant_auto_deposit_public'),
  );
  assert.match(autoSelect, /auto_approve_enabled/);
  assert.match(autoSelect, /auto_approve_max_cents/);
  assert.match(autoSelect, /\(registered_at IS NOT NULL\) AS registered/);
  assert.equal(/sso_user_id/.test(autoSelect), false);
  assert.equal(/deposit_account_number/.test(autoSelect), false);
  assert.equal(/last_register_payload/.test(autoSelect), false);
  assert.equal(/ALTER TABLE public\.checkalt_tenant_accounts/.test(sql37), false);
  assert.equal(/ADD COLUMN/.test(sql37), false);
  const changed = [
    'src/components/settings/CheckAltSettings.tsx',
    'src/components/settings/CheckAltTenantAccountCard.tsx',
    'src/components/billing/TenantAutoApproveCard.tsx',
    'src/pages/admin/AdminTenants.tsx',
    'aws/functions/api/workflow-rpc.mjs',
  ];
  for (const rel of changed) {
    const src = sourceOf(rel);
    assert.equal(/ALTER TABLE public\.checkalt_tenant_accounts/.test(src), false);
    if (rel !== 'src/components/settings/CheckAltSettings.tsx') {
      assert.equal(/id="business_unit"/.test(src), false);
    }
  }
});
