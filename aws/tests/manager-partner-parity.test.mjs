import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  belongsToEmbed,
  handleDataQuery,
  relatedFk,
  resolvePublicTable,
} from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import {
  SAFE_DEPOSIT_ACTIONS,
  SAFE_WRITE_RPC_CLASSIFICATION,
  SAFE_WRITE_RPCS,
  executeSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const spaRoot = path.join(ROOT, '../src');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const ITEM_ID = '44444444-4444-4444-8444-444444444444';
const DEPOSIT_ID = '55555555-5555-4555-8555-555555555555';
const BATCH_ID = '66666666-6666-4666-8666-666666666666';

const jwtEvent = (body) => ({
  rawPath: '/data/query',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/query' },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const identityClient = (handler) => {
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
            cognito_sub: COGNITO_SUB,
            email: 'checksops-tester@freedomadj.com',
            status: 'active',
          }],
        };
      }
      if (sql === USER_ROLES_SQL) return { rows: [{ role: 'admin' }] };
      return handler(sql, params, queries);
    },
  };
};

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

test('1. tenants_public SQL stays public-column and does not open base tenants', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'rls/sql/35_manager_partner_parity.sql'), 'utf8');
  assert.match(sql, /CREATE VIEW public\.tenants_public/);
  assert.match(sql, /security_invoker = false/);
  assert.match(sql, /subscription_status = 'active'/);
  assert.equal(/CREATE POLICY[\s\S]*ON public\.tenants/i.test(sql), false);
  assert.equal(/GRANT SELECT ON public\.tenants\b/.test(sql), false);
  const partnerManager = fs.readFileSync(path.join(spaRoot, 'components/white-label/TenantPartnerManager.tsx'), 'utf8');
  assert.match(partnerManager, /tenants_public/);
  assert.equal(/from\("tenants"\)[\s\S]*select\("id, name"\)/.test(partnerManager), false);
});

test('2. Bank Deposits query attaches check_intake_items via check_intake_item_id', async () => {
  assert.equal(belongsToEmbed('checkalt_deposits', 'check_intake_items'), true);
  assert.equal(relatedFk('checkalt_deposits', 'check_intake_items'), 'check_intake_item_id');
  const client = identityClient((sql) => {
    if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
    if (sql.includes('FROM public.checkalt_deposits')) {
      return {
        rows: [{
          id: DEPOSIT_ID,
          checkalt_reference: 'CA-1',
          amount: 100,
          status: 'cleared',
          cleared_at: '2026-09-16T12:00:00.000Z',
          submitted_at: '2026-09-15T12:00:00.000Z',
          check_intake_item_id: CHECK_ID,
        }],
      };
    }
    if (sql.includes('FROM public.check_intake_items')) {
      return {
        rows: [{
          id: CHECK_ID,
          check_number: '1001',
          carrier_name: 'Carrier',
          payee_line: 'Payee',
          detected_claim_number: 'CL-1',
        }],
      };
    }
    return { rows: [] };
  });
  const result = await handleDataQuery(jwtEvent({
    table: 'checkalt_deposits',
    select: 'id, checkalt_reference, amount, status, cleared_at, submitted_at, check_intake_items(check_number, carrier_name, payee_line, detected_claim_number)',
    filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
  }), depsFor(client));
  assert.equal(result.ok, true);
  const parent = client.queries.find((q) => String(q.sql).includes('FROM public.checkalt_deposits') && !String(q.sql).includes('count(*)'));
  assert.match(String(parent.sql), /check_intake_item_id/);
  assert.equal(String(parent.sql).includes('checkalt_deposit_id'), false);
  const child = client.queries.find((q) => String(q.sql).includes('FROM public.check_intake_items'));
  assert.match(String(child.sql), /WHERE id = ANY/);
  assert.equal(String(child.sql).includes('checkalt_deposit_id'), false);
  assert.equal(result.data[0].check_intake_items.check_number, '1001');
});

test('3. Deposit Ops / Reports tenant filter uses EXISTS on check_id', async () => {
  const client = identityClient((sql, params) => {
    if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
    if (sql.includes('FROM public.deposit_items')) {
      assert.match(sql, /EXISTS \(SELECT 1 FROM public.check_intake_items/);
      assert.match(sql, /check_intake_items\.id = deposit_items\.check_id/);
      assert.equal(params.includes(FREEDOM), true);
      return {
        rows: [{
          id: ITEM_ID,
          check_id: CHECK_ID,
          amount: 50,
          status: 'pending_assignment',
        }],
      };
    }
    if (sql.includes('FROM public.check_intake_items')) {
      return { rows: [{ id: CHECK_ID, tenant_id: FREEDOM }] };
    }
    return { rows: [] };
  });
  const result = await handleDataQuery(jwtEvent({
    table: 'deposit_items',
    select: '*, check_intake_items!inner(tenant_id)',
    filters: [{ column: 'check_intake_items.tenant_id', op: 'eq', value: FREEDOM }],
    order: { column: 'created_at', ascending: false },
  }), depsFor(client));
  assert.equal(result.ok, true, result.message || result.error);
  assert.equal(result.data[0].id, ITEM_ID);
  assert.equal(result.data[0].check_intake_items.tenant_id, FREEDOM);
});

test('allowed-tables includes tenant-safe public config views', () => {
  const tables = JSON.parse(fs.readFileSync(path.join(ROOT, 'functions/api/allowed-tables.json'), 'utf8'));
  assert.equal(tables.includes('checkalt_config_public'), true);
  assert.equal(tables.includes('deposit_provider_config_public'), true);
  assert.equal(tables.includes('tenants_public'), true);
});

test('4. deposit_provider_config reads rewrite to the public display view', async () => {
  assert.equal(resolvePublicTable('deposit_provider_config'), 'deposit_provider_config_public');
  const client = identityClient((sql) => {
    if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
    if (sql.includes('FROM public.deposit_provider_config_public')) {
      return { rows: [{ provider: 'manual_branch', display_name: 'Manual', is_active: true, is_stubbed: true }] };
    }
    if (sql.includes('FROM public.deposit_provider_config ') || sql.includes('FROM public.deposit_provider_config\n')) {
      throw new Error('base deposit_provider_config must not be queried');
    }
    return { rows: [] };
  });
  const result = await handleDataQuery(jwtEvent({
    table: 'deposit_provider_config',
    select: '*',
    order: { column: 'provider', ascending: true },
  }), depsFor(client));
  assert.equal(result.ok, true, result.message || result.error);
  assert.equal(result.data[0].provider, 'manual_branch');
  const sql = fs.readFileSync(path.join(ROOT, 'rls/sql/35_manager_partner_parity.sql'), 'utf8');
  const view = sql.slice(sql.indexOf('CREATE VIEW public.deposit_provider_config_public'));
  assert.match(view, /display_name/);
  assert.equal(/^\s+config,/m.test(view), false);
});

test('5. CheckAlt settings read omits secrets and write is a dedicated RPC', async () => {
  assert.equal(resolvePublicTable('checkalt_config'), 'checkalt_config_public');
  assert.equal(SAFE_WRITE_RPCS.has('save_checkalt_settings'), true);
  const client = identityClient((sql, params) => {
    if (sql.includes('FROM public.checkalt_config_public')) {
      return { rows: [{ singleton: true, merchant: 'm', cached_jwt: undefined }] };
    }
    if (sql.includes('FROM public.checkalt_config ') && sql.includes('SELECT')) {
      throw new Error('base checkalt_config must not be selected');
    }
    if (/UPDATE public.checkalt_config/.test(sql)) {
      assert.equal(String(sql).includes('cached_jwt'), false);
      assert.equal(String(sql).includes('webhook_secret'), false);
      assert.match(sql, /merchant = \$1/);
      assert.equal(params[0], 'new-merchant');
      return { rows: [{ singleton: true, merchant: 'new-merchant' }] };
    }
    return { rows: [] };
  });
  const read = await handleDataQuery(jwtEvent({
    table: 'checkalt_config',
    select: '*',
    filters: [{ column: 'singleton', op: 'eq', value: true }],
    maybeSingle: true,
  }), depsFor(client));
  assert.equal(read.ok, true, read.message || read.error);
  assert.equal(read.data.merchant, 'm');

  const saved = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_settings',
    args: { merchant: 'new-merchant', cached_jwt: 'secret-token' },
  });
  assert.equal(saved.error, 'secret_column_denied');

  const ok = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_settings',
    args: { merchant: 'new-merchant', notes: 'ok' },
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.data.merchant, 'new-merchant');

  const awsClient = fs.readFileSync(path.join(spaRoot, 'integrations/aws/client.ts'), 'utf8');
  assert.match(awsClient, /save_checkalt_settings/);
  assert.equal(awsClient.includes('checkalt_config') && awsClient.includes('save_checkalt_settings'), true);
});

test('6. deposit_action allows only prepare_deposit and assign_provider', async () => {
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.deposit_action, 'safe_now_subset');
  assert.deepEqual([...SAFE_DEPOSIT_ACTIONS].sort(), ['assign_provider', 'prepare_deposit']);
  const client = identityClient((sql, params) => {
    if (/FROM public.check_intake_items/.test(sql) && /FOR UPDATE/.test(sql)) {
      return {
        rows: [{
          id: CHECK_ID,
          tenant_id: FREEDOM,
          status: 'approved_for_deposit',
          amount: 25,
          check_number: '1001',
          carrier_name: 'Carrier',
          claim_id: null,
        }],
      };
    }
    if (/FROM public.tenant_users/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/FROM public.deposit_items WHERE check_id/.test(sql)) return { rows: [] };
    if (/INSERT INTO public.deposit_items/.test(sql)) return { rows: [{ id: ITEM_ID }] };
    if (/INSERT INTO public.deposit_audit_log/.test(sql)) return { rows: [{ id: 'audit' }] };
    if (/JOIN public.check_intake_items/.test(sql)) {
      return {
        rows: [{
          id: ITEM_ID,
          status: 'pending_assignment',
          amount: 25,
          check_id: CHECK_ID,
          tenant_id: FREEDOM,
        }],
      };
    }
    if (/FROM public.deposit_provider_config/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/INSERT INTO public.deposit_batches/.test(sql)) return { rows: [{ id: BATCH_ID }] };
    if (/UPDATE public.deposit_items/.test(sql)) {
      assert.match(sql, /provider_assigned/);
      return { rows: [] };
    }
    return { rows: [] };
  });

  const blocked = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_ID },
  });
  assert.equal(blocked.error, 'rpc_financial_disabled');

  const money = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'record_submission', p_deposit_item_id: ITEM_ID },
  });
  assert.equal(money.error, 'rpc_financial_disabled');

  const prepared = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'prepare_deposit', p_check_id: CHECK_ID },
  });
  assert.equal(prepared.error, undefined);
  assert.equal(prepared.data.success, true);
  assert.equal(prepared.data.deposit_item_id, ITEM_ID);

  const assigned = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'deposit_action',
    args: { p_action: 'assign_provider', p_deposit_item_id: ITEM_ID, p_provider: 'manual_branch' },
  });
  assert.equal(assigned.error, undefined);
  assert.equal(assigned.data.batch_id, BATCH_ID);
});

test('7. resolve_check_return honors p_restore_stage', async () => {
  const returnedCheck = {
    id: CHECK_ID,
    tenant_id: FREEDOM,
    check_stage: 'returned',
    pre_return_stage: 'review',
    status: 'returned',
  };
  const makeClient = () => identityClient((sql) => {
    if (/FROM public.check_intake_items WHERE id/.test(sql)) return { rows: [returnedCheck] };
    if (/FROM public.tenant_users/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/UPDATE public.check_intake_items/.test(sql)) return { rows: [] };
    if (/INSERT INTO public.check_audit_log/.test(sql)) return { rows: [{ id: 'audit' }] };
    return { rows: [] };
  });

  const leave = makeClient();
  const left = await executeSafeWriteRpc({
    client: leave,
    mapping: { application_user_id: APP_ID },
    name: 'resolve_check_return',
    args: { p_check_id: CHECK_ID, p_restore_stage: false, p_resolution: 'Closed' },
  });
  assert.equal(left.error, undefined);
  assert.equal(left.data.restore_stage, false);
  assert.equal(left.data.check_stage, 'returned');
  const leaveUpdate = leave.queries.find((q) => /UPDATE public.check_intake_items/.test(q.sql));
  assert.equal(/check_stage/.test(leaveUpdate.sql), false);
  assert.match(leaveUpdate.sql, /return_resolved_at/);

  const restore = makeClient();
  const restored = await executeSafeWriteRpc({
    client: restore,
    mapping: { application_user_id: APP_ID },
    name: 'resolve_check_return',
    args: { p_check_id: CHECK_ID, p_restore_stage: true, p_resolution: 'Redeposited' },
  });
  assert.equal(restored.error, undefined);
  assert.equal(restored.data.restored_stage, 'review');
  const restoreUpdate = restore.queries.find((q) => /UPDATE public.check_intake_items/.test(q.sql));
  assert.match(restoreUpdate.sql, /check_stage/);
  assert.equal(restoreUpdate.params[1], 'review');
});
