import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import {
  classifyCheckAltHost,
  classifySql65Compatibility,
  hostnameOf,
  last4,
  PHASE3A_SECRET_CONTRACT,
  PLANNED_WEBHOOK_CALLBACK,
  presence,
  runPhase3aInventory,
} from '../functions/api/checkalt-phase3a-inventory.mjs';

test('Phase 3A secret contract names only and is not created here', () => {
  assert.deepEqual(PHASE3A_SECRET_CONTRACT.names, [
    'CHECKALT_USERNAME',
    'CHECKALT_PASSWORD',
    'CHECKALT_FI_KEY',
    'CHECKALT_BASE_URL',
    'CHECKALT_WEBHOOK_SECRET',
  ]);
  assert.equal(PHASE3A_SECRET_CONTRACT.secretId, 'checksops/production/providers');
  assert.equal(PHASE3A_SECRET_CONTRACT.consumedOnlyThrough, 'PROVIDER_SECRETS_ARN');
  assert.equal(PHASE3A_SECRET_CONTRACT.createNow, false);
  assert.equal(PLANNED_WEBHOOK_CALLBACK, 'https://checksops.com/prep/webhooks/checkalt');
});

test('hostname classification never assumes api.checkalt.com and blocks UAT/relay', () => {
  assert.equal(hostnameOf('https://api2.checkalt.com/'), 'api2.checkalt.com');
  assert.equal(classifyCheckAltHost('api2.checkalt.com').status, 'VERIFIED');
  assert.equal(classifyCheckAltHost('api.checkalt.com').status, 'VERIFIED');
  assert.equal(classifyCheckAltHost('uatapi.checkalt.com').status, 'BLOCKED');
  assert.equal(classifyCheckAltHost('checkalt-relay.checksops.com').status, 'BLOCKED');
  assert.equal(classifyCheckAltHost(null, { liveReadable: false }).status, 'BLOCKED');
  assert.equal(classifyCheckAltHost(null).vendorBlocker, true);
  assert.equal(classifyCheckAltHost('unknown.example.com').status, 'BLOCKED');
});

test('SQL 65 compatibility is safe only when dark and 58 legacy rows remain', () => {
  const safe = classifySql65Compatibility({
    columns: ['id', 'check_intake_item_id', 'tenant_id', 'checkalt_reference', 'status', 'amount'],
    indexes: ['idx_checkalt_deposits_check_intake'],
    functions: [],
    policies: ['Tenant members can view their checkalt deposits'],
    grants: {
      canSelect: true,
      canInsert: false,
      canUpdate: false,
      canDelete: false,
      rlsEnabled: true,
    },
    rowCount: 58,
  });
  assert.equal(safe.status, 'SAFE_NOT_APPLIED');
  assert.equal(safe.safeToApplyLater, true);
  assert.equal(safe.schemaSafeToApplyLater, true);
  assert.equal(safe.doNotApplyNow, true);
  const countDrift = classifySql65Compatibility({
    columns: ['id', 'check_intake_item_id', 'tenant_id', 'checkalt_reference', 'status', 'amount'],
    indexes: ['idx_checkalt_deposits_check_intake'],
    functions: [],
    policies: ['Tenant members can view their checkalt deposits'],
    grants: {
      canSelect: true,
      canInsert: false,
      canUpdate: false,
      canDelete: false,
      rlsEnabled: true,
    },
    rowCount: 69,
  });
  assert.equal(countDrift.status, 'SCHEMA_SAFE_COUNT_DRIFT');
  assert.equal(countDrift.schemaSafeToApplyLater, true);
  assert.equal(countDrift.safeToApplyLater, false);

  const drifted = classifySql65Compatibility({
    columns: ['id', 'idempotency_key'],
    indexes: ['checkalt_deposits_tenant_idempotency_key_uq'],
    functions: ['aws_financial_execution_active'],
    policies: ['aws_financial_insert_checkalt_deposits'],
    grants: {
      canSelect: true,
      canInsert: true,
      canUpdate: true,
      canDelete: false,
      rlsEnabled: true,
    },
    rowCount: 58,
  });
  assert.equal(drifted.status, 'DRIFT_OR_UNSAFE');
  assert.equal(drifted.safeToApplyLater, false);
});

test('sanitizers never echo secrets or full account numbers', () => {
  assert.equal(presence('super-secret-value').present, true);
  assert.equal(presence('super-secret-value').length, 'super-secret-value'.length);
  assert.deepEqual(last4('123456789012'), { present: true, last4: '9012', length: 12 });
  assert.equal(JSON.stringify(presence('hunter2')).includes('hunter2'), false);
});

test('HTTP API events do not run the Phase 3A inventory', async () => {
  const response = await handler({
    rawPath: '/ops/checkalt-phase3a-inventory',
    requestContext: { http: { method: 'GET', path: '/ops/checkalt-phase3a-inventory' } },
  });
  assert.equal(response.statusCode, 404);
  const body = JSON.parse(response.body);
  assert.equal(body.error, 'not_found');
  assert.equal(body.phase, undefined);
});

test('inventory invoke uses READ ONLY and never returns secret column values', async () => {
  const queries = [];
  const client = {
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (/transaction_read_only/.test(sql)) {
        return { rows: [{ current_database: 'checksops', current_user: 'checksops', transaction_read_only: 'on' }] };
      }
      if (/auth\.uid/.test(sql)) return { rows: [{ auth_uid: '7dbb3009-f059-4767-b5dc-1c5c72379330' }] };
      if (/information_schema\.columns/.test(sql)) {
        const table = params?.[0];
        const cols = {
          checkalt_config: ['singleton', 'base_url', 'merchant', 'fi_key', 'webhook_secret', 'default_enabled', 'depositor_account_id'],
          checkalt_tenant_accounts: ['tenant_id', 'sso_user_id', 'deposit_account_number', 'enabled'],
          checkalt_deposits: ['id', 'tenant_id', 'check_intake_item_id', 'checkalt_reference', 'status', 'amount'],
          check_intake_items: ['id', 'tenant_id', 'amount', 'status', 'check_stage', 'deposit_recommendation', 'reviewed_at', 'front_image_path', 'back_image_deposit_path', 'created_at'],
        }[table] || [];
        return { rows: cols.map((name) => ({ column_name: name, data_type: 'text', is_nullable: 'YES' })) };
      }
      if (/FROM public\.checkalt_config/.test(sql)) {
        return {
          rows: [{
            singleton: true,
            base_url: 'https://api2.checkalt.com',
            merchant: 'prod-merchant',
            fi_key: 'SHOULD-NOT-LEAK',
            webhook_secret: 'SHOULD-NOT-LEAK',
            default_enabled: true,
            depositor_account_id: 'dep-1',
          }],
        };
      }
      if (/FROM public\.tenants/.test(sql)) {
        return { rows: [{ id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', name: 'Freedom', slug: 'freedom' }] };
      }
      if (/FROM public\.checkalt_tenant_accounts/.test(sql) && /count\(\*\)/.test(sql)) {
        return { rows: [{ n: 1 }] };
      }
      if (/FROM public\.checkalt_tenant_accounts/.test(sql)) {
        return {
          rows: [{
            tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
            enabled: true,
            registered_at: '2026-01-01',
            sso_user_id: 'sso-secret-user',
            deposit_account_number: '000111222333',
            first_name: 'Pat',
            last_name: 'Lee',
            email: 'ops@freedomadj.com',
            auto_approve_enabled: false,
            last_register_payload: { sso_key: 'payload-secret' },
          }],
        };
      }
      if (/pg_indexes/.test(sql)) return { rows: [{ indexname: 'idx_checkalt_deposits_check_intake' }] };
      if (/pg_proc/.test(sql)) return { rows: [] };
      if (/pg_policies/.test(sql)) return { rows: [{ policyname: 'Tenant members can view their checkalt deposits', cmd: 'SELECT' }] };
      if (/has_table_privilege/.test(sql)) {
        return {
          rows: [{
            can_select: true,
            can_insert: false,
            can_update: false,
            can_delete: false,
            rls_enabled: true,
            rls_forced: false,
            owner: 'checksops_admin',
          }],
        };
      }
      if (/count\(\*\)::bigint AS n FROM public\.checkalt_deposits/.test(sql)) return { rows: [{ n: 58 }] };
      if (/FROM public\.tenant_users/.test(sql)) {
        return {
          rows: [{
            id: '7dbb3009-f059-4767-b5dc-1c5c72379330',
            email: 'mcarletta@freedomadj.com',
            tenant_role: 'admin',
            platform_roles: ['admin'],
          }],
        };
      }
      if (/FROM public\.check_intake_items/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };

  const result = await runPhase3aInventory({
    loadCredentials: async () => ({ host: '127.0.0.1', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
    inspectImages: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.writesAttempted, false);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(queries.some((row) => /^BEGIN READ ONLY/i.test(row.sql)), true);
  assert.equal(JSON.stringify(result).includes('SHOULD-NOT-LEAK'), false);
  assert.equal(JSON.stringify(result).includes('sso-secret-user'), false);
  assert.equal(JSON.stringify(result).includes('000111222333'), false);
  assert.equal(result.checkaltConfig.baseHost, 'api2.checkalt.com');
  assert.equal(result.checkaltConfig.hostClass.status, 'VERIFIED');
  assert.equal(result.checkaltConfig.fiKey.present, true);
  assert.equal(result.freedomTenantAccount?.error || null, null, JSON.stringify(result.freedomTenantAccount));
  assert.equal(result.freedomTenantAccount.present, true, JSON.stringify(result.freedomTenantAccount));
  assert.equal(result.freedomTenantAccount.depositAccountLast4, '2333');
  assert.equal(result.sql65.compatibility.status, 'SAFE_NOT_APPLIED');
  assert.equal(result.authorization.dualControlImmediatelyUsable, false);
});
