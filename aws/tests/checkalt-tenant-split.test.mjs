import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleDataQuery, resolvePublicTable } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { providerEnabled, providerExecutionEnabled } from '../functions/api/provider-flags.mjs';
import { FINANCIAL_OR_PROVIDER_TABLES, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import {
  SAFE_WRITE_RPCS,
  executeSafeWriteRpc,
  handleSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const spaRoot = path.join(ROOT, '../src');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '4f172140-f57a-4744-8050-95f4f07b13b4';

const jwtEvent = (body, pathName = '/data/rpc') => ({
  rawPath: pathName,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: pathName },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const identityClient = ({ platform = false, tenantAdminOf = null, handler } = {}) => {
  const queries = [];
  const store = new Map();
  const client = {
    queries,
    store,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: [{
            application_user_id: APP_ID,
            cognito_sub: COGNITO_SUB,
            email: 'checksops-tester@freedomadj.com',
            status: 'active',
          }],
        };
      }
      if (sql === USER_ROLES_SQL) return { rows: [{ role: 'admin' }] };
      if (sql.includes('aws_is_cross_tenant_reader()')) return { rows: [{ ok: platform }] };
      if (/FROM public.tenant_users/.test(sql) && /admin',\s*'owner'/.test(sql)) {
        return tenantAdminOf && params[1] === tenantAdminOf ? { rows: [{ '?column?': 1 }] } : { rows: [] };
      }
      if (handler) return handler(sql, params, store, queries);
      return { rows: [] };
    },
  };
  return client;
};

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
  forceEnabled: true,
});

const accountRow = (tenantId, extra = {}) => ({
  id: `id-${tenantId}`,
  tenant_id: tenantId,
  sso_user_id: extra.sso_user_id || `user-${tenantId.slice(0, 8)}`,
  deposit_account_number: extra.deposit_account_number || `acct-${tenantId.slice(0, 8)}`,
  first_name: extra.first_name || 'A',
  last_name: extra.last_name || 'Tenant',
  email: extra.email || `${tenantId.slice(0, 8)}@example.test`,
  business_unit: extra.business_unit || `BU-${tenantId.slice(0, 8)}`,
  enabled: extra.enabled !== false,
  registered_at: extra.registered_at || null,
  last_register_payload: extra.last_register_payload || null,
  auto_approve_enabled: Boolean(extra.auto_approve_enabled),
  auto_approve_max_cents: extra.auto_approve_max_cents ?? null,
});

test('SQL 36 isolates tenant CheckAlt fields and closes ordinary SELECT', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'rls/sql/36_checkalt_tenant_split.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS business_unit/);
  assert.match(sql, /CREATE VIEW public\.checkalt_tenant_accounts_admin/);
  assert.match(sql, /CREATE VIEW public\.checkalt_tenant_auto_deposit_public/);
  assert.match(sql, /aws_is_platform_checkalt_admin/);
  assert.match(sql, /USING \(public\.aws_is_cross_tenant_reader\(\)\)/);
  assert.equal(/last_register_payload/.test(sql.slice(sql.indexOf('checkalt_tenant_auto_deposit_public'))), false);
  const publicView = sql.slice(sql.indexOf('CREATE VIEW public.checkalt_config_public'));
  assert.match(publicView, /fi_key_configured/);
  assert.equal(/^\s+fi_key,/m.test(publicView), false);
  assert.equal(/^\s+depositor_account_id,/m.test(publicView), false);
  assert.equal(/^\s+business_unit,/m.test(publicView), false);
  assert.equal(/cached_jwt/.test(sql), false);
  assert.equal(/webhook_secret/.test(sql), false);
  assert.equal(/UPDATE public.checkalt_deposits/.test(sql), false);
  assert.equal(/cleared_at/.test(sql), false);
});

test('tenant A/B CheckAlt configuration stays isolated and does not write the singleton', async () => {
  const client = identityClient({
    platform: true,
    handler: (sql, params, shared) => {
      if (/FROM public.checkalt_tenant_accounts/.test(sql) && /SELECT/.test(sql)) {
        return { rows: shared.has(params[0]) ? [shared.get(params[0])] : [] };
      }
      if (/INSERT INTO public.checkalt_tenant_accounts/.test(sql)) {
        const row = accountRow(params[0], {
          sso_user_id: params[1],
          deposit_account_number: params[2],
          first_name: params[3],
          last_name: params[4],
          email: params[5],
          business_unit: params[6],
        });
        shared.set(params[0], row);
        return { rows: [row] };
      }
      if (/UPDATE public.checkalt_config/.test(sql)) {
        throw new Error('tenant save must not write checkalt_config');
      }
      return { rows: [] };
    },
  });

  const savedA = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_account',
    args: {
      tenant_id: TENANT_A,
      sso_user_id: 'user-a',
      deposit_account_number: '1111111111',
      first_name: 'Freedom',
      last_name: 'One',
      email: 'a@example.test',
      business_unit: 'BU-A',
    },
  });
  const savedB = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_account',
    args: {
      tenant_id: TENANT_B,
      sso_user_id: 'user-b',
      deposit_account_number: '2222222222',
      first_name: 'C1C',
      last_name: 'Two',
      email: 'b@example.test',
      business_unit: 'BU-B',
    },
  });
  assert.equal(savedA.error, undefined, savedA.message);
  assert.equal(savedB.error, undefined, savedB.message);
  assert.equal(savedA.data.business_unit, 'BU-A');
  assert.equal(savedB.data.business_unit, 'BU-B');
  assert.equal(savedA.data.deposit_account_number, '1111111111');
  assert.equal(savedB.data.deposit_account_number, '2222222222');
  assert.equal(savedA.data.tenant_id, TENANT_A);
  assert.equal(savedB.data.tenant_id, TENANT_B);
  assert.equal(client.queries.some((q) => /UPDATE public.checkalt_config/.test(q.sql)), false);
});

test('tenant admin cannot mutate the global CheckAlt singleton', async () => {
  const client = identityClient({ platform: false, tenantAdminOf: TENANT_A });
  const denied = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_settings',
    args: { merchant: 'hacked', business_unit: 'NOPE' },
  });
  assert.equal(denied.error, 'not_authorized');
  const tenantField = await executeSafeWriteRpc({
    client: identityClient({ platform: true }),
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_settings',
    args: { business_unit: 'NOPE' },
  });
  assert.equal(tenantField.error, 'tenant_field_denied');
});

test('Auto-Deposit write cannot change other CheckAlt fields', async () => {
  const client = identityClient({
    platform: false,
    tenantAdminOf: TENANT_A,
    handler: (sql, params) => {
      if (/UPDATE public.checkalt_tenant_accounts/.test(sql)) {
        assert.match(sql, /auto_approve_enabled/);
        assert.equal(/sso_user_id/.test(sql), false);
        assert.equal(/deposit_account_number/.test(sql), false);
        assert.equal(/business_unit/.test(sql), false);
        return {
          rows: [{
            tenant_id: params.at(-1),
            auto_approve_enabled: true,
            auto_approve_max_cents: 50000,
            enabled: true,
            registered: true,
          }],
        };
      }
      return { rows: [] };
    },
  });
  const rejected = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_auto_deposit',
    args: {
      tenant_id: TENANT_A,
      auto_approve_enabled: true,
      deposit_account_number: '9999999999',
    },
  });
  assert.equal(rejected.error, 'tenant_field_denied');
  const otherTenant = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_auto_deposit',
    args: { tenant_id: TENANT_B, auto_approve_enabled: true },
  });
  assert.equal(otherTenant.error, 'not_authorized');
  const ok = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_auto_deposit',
    args: { tenant_id: TENANT_A, auto_approve_enabled: true, auto_approve_max_cents: 50000 },
  });
  assert.equal(ok.error, undefined, ok.message);
  assert.equal(ok.data.auto_approve_enabled, true);
});

test('ordinary tenant reads are remapped away from full account rows', async () => {
  assert.equal(resolvePublicTable('checkalt_tenant_accounts'), 'checkalt_tenant_auto_deposit_public');
  assert.equal(resolvePublicTable('checkalt_config'), 'checkalt_config_public');
  const tables = JSON.parse(fs.readFileSync(path.join(ROOT, 'functions/api/allowed-tables.json'), 'utf8'));
  assert.equal(tables.includes('checkalt_tenant_auto_deposit_public'), true);
  assert.equal(tables.includes('checkalt_tenant_accounts_admin'), true);
  const client = identityClient({
    handler: (sql) => {
      if (sql.includes('FROM public.checkalt_tenant_auto_deposit_public')) {
        return { rows: [{ tenant_id: TENANT_A, auto_approve_enabled: false, registered: true }] };
      }
      if (sql.includes('FROM public.checkalt_tenant_accounts ') || sql.includes('FROM public.checkalt_tenant_accounts\n')) {
        throw new Error('base checkalt_tenant_accounts must not be selected');
      }
      return { rows: [] };
    },
  });
  const result = await handleDataQuery(jwtEvent({
    table: 'checkalt_tenant_accounts',
    select: '*',
    filters: [{ column: 'tenant_id', op: 'eq', value: TENANT_A }],
    maybeSingle: true,
  }, '/data/query'), depsFor(client));
  assert.equal(result.ok, true, result.message || result.error);
  assert.equal(result.data.tenant_id, TENANT_A);
  assert.equal(result.data.deposit_account_number, undefined);
});

test('platform admin tenant RPC does not enable provider execution', async () => {
  delete process.env.AWS_CHECKALT_ENABLED;
  delete process.env.AWS_PROVIDER_EXECUTION_ENABLED;
  assert.equal(providerEnabled('checkalt'), false);
  assert.equal(providerExecutionEnabled(), false);
  const client = identityClient({
    platform: true,
    handler: (sql, params) => {
      if (/INSERT INTO public.checkalt_tenant_accounts/.test(sql)) {
        return { rows: [accountRow(params[0], { sso_user_id: params[1], deposit_account_number: params[2] })] };
      }
      return { rows: [] };
    },
  });
  const result = await handleSafeWriteRpc(
    jwtEvent({
      name: 'save_checkalt_tenant_account',
      args: {
        tenant_id: TENANT_A,
        sso_user_id: 'user-a',
        deposit_account_number: '1111111111',
        first_name: 'A',
        last_name: 'B',
        email: 'a@example.test',
        business_unit: 'BU-A',
      },
    }),
    depsFor(client),
  );
  assert.equal(result.ok, true, result.message || result.error);
  assert.equal(result.providerExecution, false);
  assert.equal(WRITE_ALLOWLIST.checkalt_tenant_accounts, undefined);
  assert.equal(FINANCIAL_OR_PROVIDER_TABLES.has('checkalt_tenant_accounts'), true);
  assert.equal(SAFE_WRITE_RPCS.has('save_checkalt_tenant_account'), true);
});

test('Manager Bank Deposits Settings is Auto-Deposit only', () => {
  const bank = fs.readFileSync(path.join(spaRoot, 'components/deposit-ops/BankDepositReconciliation.tsx'), 'utf8');
  assert.match(bank, /CheckAltTenantAutoDepositCard/);
  assert.match(bank, /CheckAlt Settings/);
  assert.equal(bank.includes('CheckAltSettings'), false);
  assert.doesNotMatch(bank, /business_unit|deposit_account_number|fi_key|base_url|sso_user_id|Register account/);
  const auto = fs.readFileSync(path.join(spaRoot, 'components/settings/CheckAltTenantAutoDepositCard.tsx'), 'utf8');
  assert.match(auto, /checkalt_tenant_auto_deposit_public/);
  assert.doesNotMatch(auto, /deposit_account_number|sso_user_id|business_unit|checkalt-register-account|fi_key/);
  const admin = fs.readFileSync(path.join(spaRoot, 'components/settings/CheckAltTenantAdminCard.tsx'), 'utf8');
  assert.match(admin, /checkalt_tenant_accounts_admin/);
  assert.match(admin, /business_unit/);
  assert.match(admin, /deposit_account_number/);
  assert.doesNotMatch(admin, /checkalt-register-account|checkalt-poll-status/);
  const platform = fs.readFileSync(path.join(spaRoot, 'components/settings/CheckAltSettings.tsx'), 'utf8');
  assert.match(platform, /isPlatformOwner/);
  assert.doesNotMatch(platform, /business_unit|depositor_account_id|auto_approve_enabled/);
  const tenants = fs.readFileSync(path.join(spaRoot, 'pages/admin/AdminTenants.tsx'), 'utf8');
  assert.match(tenants, /CheckAltTenantAdminCard/);
  assert.match(tenants, /<CheckAltSettings \/>/);
});
