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
  CHECKALT_TENANT_MEMBER_SQL,
  SAFE_WRITE_RPCS,
  executeSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';
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

const sql80 = fs.readFileSync(path.join(ROOT, 'workflows/sql/80_checkalt_member_auto_deposit.sql'), 'utf8');

/** Plain member of FREEDOM: tenant_users row with a non-admin role, no user_roles. */
const memberClient = ({ memberOf = FREEDOM, tenantRole = 'operator', result } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === IS_PLATFORM_OWNER_SQL) return { rows: [{ is_owner: false }] };
      if (sql === USER_ROLES_SQL) return { rows: [] };
      if (/FROM public\.tenant_users\s+WHERE user_id = \$1::uuid AND tenant_id = \$2::uuid/.test(sql)) {
        // Honor the role allowlist exactly as the gate's SQL spells it.
        const allowed = [...(sql.match(/lower\(role::text\) IN \(([^)]*)\)/)?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
        if (!allowed.length) throw new Error('the Auto-Deposit gate must filter on tenant role');
        const ok = params[0] === APP_ID && params[1] === memberOf && allowed.includes(tenantRole);
        return { rows: ok ? [{ role: tenantRole }] : [] };
      }
      if (sql === AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL) {
        if (result !== undefined) return { rows: result === null ? [] : [{ result }] };
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
    },
  };
};

const save = (client, args) => executeSafeWriteRpc({
  client,
  mapping: { application_user_id: APP_ID },
  name: 'save_checkalt_tenant_auto_deposit',
  args,
});

test('tenant operators and admins can toggle Auto-Deposit and set or clear the ceiling', async () => {
  for (const tenantRole of ['operator', 'admin', 'owner', 'manager']) {
    const client = memberClient({ tenantRole });
    const off = await save(client, { tenant_id: FREEDOM, auto_approve_enabled: false, auto_approve_max_cents: 200000 });
    assert.equal(off.error, undefined, tenantRole);
    assert.equal(off.data.auto_approve_enabled, false);
    assert.equal(off.data.auto_approve_max_cents, 200000);
    const blank = await save(client, { tenant_id: FREEDOM, auto_approve_enabled: true, auto_approve_max_cents: null });
    assert.equal(blank.error, undefined, tenantRole);
    assert.equal(blank.data.auto_approve_max_cents, null);
    const persists = client.queries.filter((q) => q.sql === AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL);
    assert.deepEqual(persists.map((q) => q.params[1]), [
      { auto_approve_enabled: false, auto_approve_max_cents: 200000 },
      { auto_approve_enabled: true, auto_approve_max_cents: null },
    ]);
  }
});

test('viewers (and unknown roles) cannot change Auto-Deposit, and nothing is written', async () => {
  assert.match(CHECKALT_TENANT_MEMBER_SQL, /lower\(role::text\) IN \('owner', 'admin', 'manager', 'operator'\)/);
  for (const tenantRole of ['viewer', 'Viewer', 'member', 'partner', '']) {
    const client = memberClient({ tenantRole });
    const denied = await save(client, { tenant_id: FREEDOM, auto_approve_enabled: false });
    assert.equal(denied.error, 'not_authorized', tenantRole);
    assert.equal(client.queries.some((q) => q.sql === AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL), false, tenantRole);
  }
});

test('a member of another tenant cannot change this tenant, and nothing is written', async () => {
  const client = memberClient({ memberOf: C1C });
  const denied = await save(client, { tenant_id: FREEDOM, auto_approve_enabled: false });
  assert.equal(denied.error, 'not_authorized');
  assert.equal(client.queries.some((q) => q.sql === AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL), false);
});

test('ceiling must be null or a non-negative whole number of cents', async () => {
  for (const bad of [-1, 12.5, '12.5', 'abc', true, {}, [], 2147483648, Number.NaN]) {
    const client = memberClient();
    const denied = await save(client, { tenant_id: FREEDOM, auto_approve_enabled: true, auto_approve_max_cents: bad });
    assert.equal(denied.error, 'invalid_field', String(bad));
    assert.equal(denied.field, 'auto_approve_max_cents');
    assert.equal(client.queries.some((q) => q.sql === AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL), false);
  }
  for (const [good, cents] of [[0, 0], [250000, 250000], ['1500', 1500], ['', null]]) {
    const ok = await save(memberClient(), { tenant_id: FREEDOM, auto_approve_enabled: true, auto_approve_max_cents: good });
    assert.equal(ok.error, undefined, String(good));
    assert.equal(ok.data.auto_approve_max_cents, cents);
  }
  const badToggle = await save(memberClient(), { tenant_id: FREEDOM, auto_approve_enabled: 'yes' });
  assert.equal(badToggle.error, 'invalid_field');
  assert.equal(badToggle.field, 'auto_approve_enabled');
});

test('a save that returns no stored row is an error, never a silent success', async () => {
  const empty = await save(memberClient({ result: null }), { tenant_id: FREEDOM, auto_approve_enabled: false });
  assert.equal(empty.error, 'rls_denied');
  const otherRow = await save(
    memberClient({ result: { tenant_id: C1C, auto_approve_enabled: false, auto_approve_max_cents: null } }),
    { tenant_id: FREEDOM, auto_approve_enabled: false },
  );
  assert.equal(otherRow.error, 'rls_denied');
});

test('SQL 80 replaces the persist RPC with an owner/admin/manager/operator gate and keeps the column whitelist', () => {
  assert.match(sql80, /CREATE OR REPLACE FUNCTION public\.aws_save_checkalt_tenant_auto_deposit\(\s*_tenant_id uuid,\s*_settings jsonb\s*\)/);
  assert.match(sql80, /SECURITY DEFINER/);
  assert.match(sql80, /SET row_security = off/);
  const gate = sql80.slice(sql80.indexOf('IF NOT ('), sql80.indexOf("RAISE EXCEPTION 'not_authorized'"));
  assert.match(gate, /is_platform_owner\(\)/);
  assert.match(gate, /tu\.user_id = auth\.uid\(\)/);
  assert.match(gate, /tu\.tenant_id = _tenant_id/);
  assert.match(gate, /AND lower\(tu\.role::text\) IN \('owner', 'admin', 'manager', 'operator'\)/);
  assert.equal(/viewer/.test(gate), false);
  const keyGuard = sql80.slice(sql80.indexOf('FOR _key IN'), sql80.indexOf('IF NOT ('));
  assert.match(keyGuard, /_key NOT IN \('auto_approve_enabled', 'auto_approve_max_cents'\)/);
  const updateSlice = sql80.slice(sql80.indexOf('UPDATE public.checkalt_tenant_accounts'), sql80.indexOf('RETURNING'));
  const setColumns = [...updateSlice.matchAll(/^\s{4}(\w+) =/gm)].map((m) => m[1]);
  assert.deepEqual(setColumns, ['auto_approve_enabled', 'auto_approve_max_cents', 'updated_at']);
  assert.match(updateSlice, /WHERE tenant_id = _tenant_id/);
  assert.match(sql80, /RAISE EXCEPTION 'not_found'/);
  assert.equal(/GRANT (UPDATE|INSERT|DELETE)/.test(sql80), false);
  assert.equal(/ALTER TABLE|CREATE POLICY|DROP/.test(sql80), false);
  assert.match(sql80, /REVOKE ALL ON FUNCTION public\.aws_save_checkalt_tenant_auto_deposit\(uuid, jsonb\) FROM PUBLIC/);
  assert.match(sql80, /GRANT EXECUTE ON FUNCTION public\.aws_save_checkalt_tenant_auto_deposit\(uuid, jsonb\) TO checksops, authenticated/);
});
