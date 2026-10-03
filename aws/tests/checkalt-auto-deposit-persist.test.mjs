import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { IS_PLATFORM_OWNER_SQL } from '../functions/api/data.mjs';
import { denyTableReason, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { executeAllowlistedWrite } from '../functions/api/write.mjs';
import {
  AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL,
  CHECKALT_SETTINGS_RPCS,
  SAFE_WRITE_RPCS,
  executeSafeWriteRpc,
  handleSafeWriteRpc,
  safeWriteRpcGate,
} from '../functions/api/workflow-rpc.mjs';
import { dollarsToAutoApproveCents, echoAutoDepositSave } from '../../src/lib/autoDepositUiState.ts';
import {
  buildDepositProcessBody,
  buildRegisterPayload,
} from '../functions/api/providers/parity/checkalt-client.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const sql38 = fs.readFileSync(path.join(ROOT, 'rls/sql/38_checkalt_auto_deposit_persist.sql'), 'utf8');

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
    if (/FROM public\.tenant_users/.test(sql) && /lower\(role::text\) IN \('admin', 'owner'\)/.test(sql)) {
      if (params[0] === APP_ID && params[1] === tenantAdminFor) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    }
    if (/SELECT tenant_id FROM public\.tenant_users WHERE user_id/.test(sql)) {
      return { rows: [{ tenant_id: tenantAdminFor }] };
    }
    return handler(sql, params);
  },
});

test('SQL 38 is a DEFINER persist RPC and does not grant table UPDATE', () => {
  assert.match(sql38, /CREATE OR REPLACE FUNCTION public\.aws_save_checkalt_tenant_auto_deposit/);
  assert.match(sql38, /SECURITY DEFINER/);
  assert.match(sql38, /SET row_security = off/);
  assert.match(sql38, /auto_approve_enabled/);
  assert.match(sql38, /auto_approve_max_cents/);
  assert.match(sql38, /GRANT EXECUTE ON FUNCTION public\.aws_save_checkalt_tenant_auto_deposit/);
  assert.match(sql38, /REVOKE ALL ON FUNCTION public\.aws_save_checkalt_tenant_auto_deposit/);
  assert.equal(/GRANT UPDATE/.test(sql38), false);
  assert.equal(/GRANT INSERT/.test(sql38), false);
  assert.equal(/GRANT DELETE/.test(sql38), false);
  assert.equal(/ALTER TABLE public\.checkalt_tenant_accounts/.test(sql38), false);
  assert.equal(/ADD COLUMN/.test(sql38), false);
  assert.equal(/sso_user_id\s*=/.test(sql38), false);
  assert.equal(/deposit_account_number\s*=/.test(sql38), false);
  assert.equal(/last_register_payload\s*=/.test(sql38), false);
  assert.equal(/registered_at\s*=/.test(sql38), false);
  assert.equal(/\benabled\s*=/.test(sql38), false);
  const updateSlice = sql38.slice(sql38.indexOf('UPDATE public.checkalt_tenant_accounts'), sql38.indexOf('RETURNING'));
  assert.match(updateSlice, /auto_approve_enabled =/);
  assert.match(updateSlice, /auto_approve_max_cents =/);
  assert.match(updateSlice, /updated_at = now\(\)/);
  assert.equal(/sso_user_id/.test(updateSlice), false);
  assert.equal(/deposit_account_number/.test(updateSlice), false);
  assert.equal(/last_register_payload/.test(updateSlice), false);
  assert.equal(/36_checkalt/.test(sql38), false);
});

test('generic table UPDATE of checkalt_tenant_accounts stays blocked', async () => {
  assert.equal(WRITE_ALLOWLIST.checkalt_tenant_accounts, undefined);
  assert.equal(denyTableReason('checkalt_tenant_accounts'), 'financial_or_provider');
  const denied = await executeAllowlistedWrite({
    client: { query: async () => { throw new Error('generic write must not reach the table'); } },
    mapping: { application_user_id: APP_ID },
    body: {
      table: 'checkalt_tenant_accounts',
      op: 'update',
      values: { auto_approve_enabled: true, auto_approve_max_cents: 100 },
      filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
    },
  });
  assert.equal(denied.error, 'table_not_allowlisted');
  assert.equal(denied.reason, 'financial_or_provider');
});

test('Auto-Deposit ON/OFF and threshold persist through the DEFINER RPC only', async () => {
  const calls = [];
  const client = identityClient({ platformOwner: false }, (sql, params) => {
    if (sql === AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL) {
      calls.push(params);
      return {
        rows: [{
          result: {
            tenant_id: params[0],
            auto_approve_enabled: params[1].auto_approve_enabled,
            auto_approve_max_cents: params[1].auto_approve_max_cents ?? null,
          },
        }],
      };
    }
    if (/UPDATE public\.checkalt_tenant_accounts/.test(sql)) {
      throw new Error('raw table UPDATE is not the persist path');
    }
    return { rows: [] };
  });

  const on = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_auto_deposit',
    args: { tenant_id: FREEDOM, auto_approve_enabled: true, auto_approve_max_cents: 25000 },
  });
  assert.equal(SAFE_WRITE_RPCS.has('save_checkalt_tenant_auto_deposit'), true);
  assert.equal(on.error, undefined);
  assert.equal(on.data.auto_approve_enabled, true);
  assert.equal(on.data.auto_approve_max_cents, 25000);
  assert.deepEqual(calls[0][1], { auto_approve_enabled: true, auto_approve_max_cents: 25000 });

  const off = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_auto_deposit',
    args: { tenant_id: FREEDOM, auto_approve_enabled: false, auto_approve_max_cents: null },
  });
  assert.equal(off.data.auto_approve_enabled, false);
  assert.equal(off.data.auto_approve_max_cents, null);
  assert.deepEqual(calls[1][1], { auto_approve_enabled: false, auto_approve_max_cents: null });
  assert.equal(calls.length, 2);
});

test('only the caller tenant can be changed and extra CheckAlt fields stay unmodifiable', async () => {
  const calls = [];
  const client = identityClient({ platformOwner: false }, (sql, params) => {
    if (sql === AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL) {
      calls.push(params);
      return { rows: [{ result: { tenant_id: params[0], auto_approve_enabled: true, auto_approve_max_cents: 1 } }] };
    }
    return { rows: [] };
  });

  const otherTenant = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_checkalt_tenant_auto_deposit',
    args: { tenant_id: C1C, auto_approve_enabled: true, auto_approve_max_cents: 1 },
  });
  assert.equal(otherTenant.error, 'not_authorized');
  assert.equal(calls.length, 0);

  for (const field of [
    'sso_user_id',
    'deposit_account_number',
    'first_name',
    'last_name',
    'email',
    'enabled',
    'registered_at',
    'last_register_payload',
  ]) {
    const denied = await executeSafeWriteRpc({
      client,
      mapping: { application_user_id: APP_ID },
      name: 'save_checkalt_tenant_auto_deposit',
      args: { tenant_id: FREEDOM, auto_approve_enabled: true, [field]: 'nope' },
    });
    assert.equal(denied.error, 'invalid_field');
    assert.equal(denied.field, field);
  }
  assert.equal(calls.length, 0);
});

test('DEFINER SQL rejects extra keys even if the Node gate is bypassed', () => {
  const extraGuard = sql38.slice(
    sql38.indexOf('FOR _key IN SELECT jsonb_object_keys(_settings)'),
    sql38.indexOf('IF NOT ('),
  );
  assert.match(extraGuard, /auto_approve_enabled/);
  assert.match(extraGuard, /auto_approve_max_cents/);
  assert.match(extraGuard, /invalid_field/);
  assert.match(sql38, /is_platform_owner\(\)/);
  assert.match(sql38, /tenant_users tu/);
  assert.match(sql38, /auth\.uid\(\)/);
  assert.match(sql38, /tenant_id = _tenant_id/);
});

test('CheckAlt provider request builders remain unchanged', () => {
  const body = buildDepositProcessBody({
    fiKey: 'fi',
    ssoKey: 'sso',
    depositAccountNumber: '90001111',
    captureDateTime: '2026-01-01T00:00:00.000Z',
    userAmount: 12345,
    frontImage: 'Zm9v',
    rearImage: 'YmFy',
  });
  assert.equal(body.businessUnit, undefined);
  assert.equal(body.ssoKey, 'sso');
  const register = buildRegisterPayload({
    fiKey: 'fi',
    ssoUserId: 'user-1',
    firstName: 'A',
    lastName: 'B',
    email: 'a@b.com',
    depositAccountNumber: '90001111',
  });
  assert.equal(register.businessUnit, undefined);
  const rpc = fs.readFileSync(path.join(ROOT, 'functions/api/workflow-rpc.mjs'), 'utf8');
  assert.match(rpc, /aws_save_checkalt_tenant_auto_deposit/);
  assert.equal(/UPDATE public\.checkalt_tenant_accounts/.test(rpc), false);
});

const jwtPersistEvent = (body) => ({
  rawPath: '/data/rpc',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/rpc' },
    authorizer: {
      jwt: {
        claims: {
          sub: 'c4386408-60e1-70e2-abb6-e6194e8e635f',
          email: 'mcarletta@freedomadj.com',
          token_use: 'id',
        },
      },
    },
  },
});

test('Settings $2,000 save persists 200000 cents when writes are on and T5 workflow writes stay off', async () => {
  assert.equal(CHECKALT_SETTINGS_RPCS.has('save_checkalt_tenant_auto_deposit'), true);
  assert.equal(CHECKALT_SETTINGS_RPCS.has('save_checkalt_settings'), true);
  assert.equal(dollarsToAutoApproveCents('2000'), 200000);

  const previousWrites = process.env.AWS_WRITES_ENABLED;
  const previousWorkflow = process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
  const previousEnv = process.env.CHECKSOPS_ENV;
  const persisted = [];
  const client = identityClient({ platformOwner: false }, (sql, params) => {
    if (sql === AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL) {
      persisted.push(params);
      return {
        rows: [{
          result: {
            tenant_id: params[0],
            auto_approve_enabled: params[1].auto_approve_enabled,
            auto_approve_max_cents: params[1].auto_approve_max_cents ?? null,
          },
        }],
      };
    }
    return { rows: [] };
  });
  try {
    process.env.AWS_WRITES_ENABLED = 'true';
    process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'false';
    process.env.CHECKSOPS_ENV = 'staging';
    assert.equal(safeWriteRpcGate('save_checkalt_tenant_auto_deposit').allowed, true);
    assert.equal(safeWriteRpcGate('save_checkalt_settings').allowed, true);
    assert.equal(safeWriteRpcGate('deposit_action').allowed, false);
    assert.equal(safeWriteRpcGate('deposit_action').error, 'application_workflow_writes_disabled');
    const cents = dollarsToAutoApproveCents('2000.00');
    const saved = await handleSafeWriteRpc(
      jwtPersistEvent({
        name: 'save_checkalt_tenant_auto_deposit',
        args: { tenant_id: FREEDOM, auto_approve_enabled: true, auto_approve_max_cents: cents },
      }),
      {
        loadDatabaseCredentials: async () => ({
          host: 'x', username: 'checksops', password: 'x', database: 'checksops',
        }),
        createClient: () => client,
      },
    );
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.data.auto_approve_enabled, true);
    assert.equal(saved.data.auto_approve_max_cents, 200000);
    assert.deepEqual(persisted[0][1], { auto_approve_enabled: true, auto_approve_max_cents: 200000 });
    const echo = echoAutoDepositSave(saved.data, { enabled: true, cents: 200000 });
    assert.equal(echo.ok, true);

    const blockedWorkflow = await handleSafeWriteRpc(
      jwtPersistEvent({
        name: 'deposit_action',
        args: { p_action: 'prepare_deposit', p_check_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      }),
      {
        loadDatabaseCredentials: async () => ({
          host: 'x', username: 'checksops', password: 'x', database: 'checksops',
        }),
        createClient: () => client,
      },
    );
    assert.equal(blockedWorkflow.error, 'application_workflow_writes_disabled');
  } finally {
    if (previousWrites === undefined) delete process.env.AWS_WRITES_ENABLED;
    else process.env.AWS_WRITES_ENABLED = previousWrites;
    if (previousWorkflow === undefined) delete process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
    else process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = previousWorkflow;
    if (previousEnv === undefined) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = previousEnv;
  }
});

test('Auto-Deposit Settings stay disabled when AWS_WRITES_ENABLED is not true', async () => {
  const previousWrites = process.env.AWS_WRITES_ENABLED;
  const previousWorkflow = process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
  try {
    process.env.AWS_WRITES_ENABLED = 'false';
    process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
    const denied = await handleSafeWriteRpc(
      jwtPersistEvent({
        name: 'save_checkalt_tenant_auto_deposit',
        args: { tenant_id: FREEDOM, auto_approve_enabled: true, auto_approve_max_cents: 200000 },
      }),
      {
        loadDatabaseCredentials: async () => ({
          host: 'x', username: 'checksops', password: 'x', database: 'checksops',
        }),
        createClient: () => identityClient(),
      },
    );
    assert.equal(denied.error, 'writes_disabled');
  } finally {
    if (previousWrites === undefined) delete process.env.AWS_WRITES_ENABLED;
    else process.env.AWS_WRITES_ENABLED = previousWrites;
    if (previousWorkflow === undefined) delete process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
    else process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = previousWorkflow;
  }
});
