/**
 * SQL 81 against PostgreSQL 16: the real RLS helper files (platform owner =
 * checksopsadmin@gmail.com identity), checkalt_tenant_accounts with its real
 * SELECT and write policies and no table write grant, then the real SQL 81
 * file, driven through the real production register / verify handlers as
 * checksops (RLS on) with Check Alt mocked.
 *
 * The platform owner registers a tenant (insert, then re-register updates the
 * same row and keeps auto_approve_*); tenant admins/operators and platform
 * admins are refused; non-digit account numbers, extra keys and payloads that
 * still carry the full number are refused by the function itself.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  handleProductionCheckAltRegister,
  handleProductionCheckAltVerify,
} from '../functions/api/providers/production/checkalt-register.mjs';
import { AWS_ROOT, applyBaseSchema, pgSkipReason, policyBlock, startPg } from './helpers/stakeholder-policies-pg.mjs';

const SQL_81 = path.join(AWS_ROOT, 'workflows/sql/81_checkalt_production_register.sql');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_MISSING = '99999999-9999-4999-8999-999999999999';
const OWNER = 'a1000000-0000-4000-8000-0000000000f1';
const PLATFORM_ADMIN = 'a1000000-0000-4000-8000-0000000000f2';
const A_ADMIN = 'a1000000-0000-4000-8000-0000000000ad';
const FULL = '123456789';

const SCHEMA = `
CREATE TABLE public.checkalt_tenant_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE UNIQUE,
  sso_user_id text NOT NULL,
  deposit_account_number text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  registered_at timestamptz,
  last_register_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  auto_approve_enabled boolean NOT NULL DEFAULT false,
  auto_approve_max_cents integer);
REVOKE ALL ON TABLE public.checkalt_tenant_accounts FROM checksops, authenticated;
GRANT SELECT ON TABLE public.checkalt_tenant_accounts TO checksops;
ALTER TABLE public.checkalt_tenant_accounts ENABLE ROW LEVEL SECURITY;
-- SQL 65's production config reader (fixture stand-in).
CREATE FUNCTION public.aws_checkalt_production_config()
RETURNS TABLE (merchant text, fi_key text, base_url text, default_enabled boolean, depositor_account_id text, business_unit text)
LANGUAGE sql AS $$ SELECT 'prod-merchant'::text, NULL::text, 'https://api2.checkalt.com'::text, true, NULL::text, NULL::text $$;
GRANT EXECUTE ON FUNCTION public.aws_checkalt_production_config() TO checksops;
`;

const SEED = `
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A');
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${OWNER}', 'checksopsadmin@gmail.com', 'active'),
  ('${PLATFORM_ADMIN}', 'staff@example.com', 'active'),
  ('${A_ADMIN}', 'admin@a.example', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES ('${PLATFORM_ADMIN}', 'admin');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_A}', '${A_ADMIN}', 'admin');
`;

const secrets = async () => ({
  ok: true,
  credentials: { environment: 'production', username: 'api-login', password: 'p', fiKey: 'prod-fi', baseUrl: 'https://api2.checkalt.com' },
});

const checkAltFetch = (calls) => async (url, init = {}) => {
  const href = String(url);
  calls.push(href);
  const reply = (body) => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  if (href.endsWith('/authenticate')) return reply('header.payload.sig');
  if (href.endsWith('/useraccount/register')) return reply({ success: true, echo: JSON.parse(init.body).accountDataList });
  if (href.endsWith('/getUserAccountInformation')) return reply({ accountDataList: [{ accountNumber: JSON.parse(init.body).userId === 'dep-2' ? '5550001234' : FULL, ssoKey: 'sso-live' }] });
  if (href.endsWith('/getDepositAccountInformation')) return reply({ accountNumber: JSON.parse(init.body).accountNumber, status: 'Active' });
  return { ok: false, status: 404, text: async () => 'nf' };
};

test('PostgreSQL 16: SQL 81 lets only the platform owner register a production Check Alt depositor', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql81-checkalt-', 55600);
  const client = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await client.connect();
  try {
    await applyBaseSchema(client);
    await client.query(SCHEMA);
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_checkalt_tenant_accounts'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_checkalt_tenant_accounts'));
    await client.query(SEED);

    const as = async (user, fn) => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE checksops');
        await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    const stored = async () => (await client.query(
      'SELECT * FROM public.checkalt_tenant_accounts WHERE tenant_id = $1', [TENANT_A],
    )).rows[0];
    const register = (user, body, calls = []) => as(user, () => handleProductionCheckAltRegister({
      client,
      body: { tenant_id: TENANT_A, sso_user_id: 'dep-1', first_name: 'A', last_name: 'B', email: 'a@b.example', deposit_account_number: FULL, ...body },
      fetchImpl: checkAltFetch(calls),
      deps: { loadProductionSecrets: secrets },
    }));

    // Before SQL 81 the writer is missing: refused before Check Alt is called.
    const early = [];
    let result = await register(OWNER, {}, early);
    assert.equal(result.error, 'register_writer_missing', JSON.stringify(result));
    assert.deepEqual(early, []);
    assert.equal(await stored(), undefined);

    await client.query(fs.readFileSync(SQL_81, 'utf8'));

    // An unknown tenant is refused before Check Alt is called.
    const none = [];
    result = await register(OWNER, { tenant_id: TENANT_MISSING }, none);
    assert.equal(result.error, 'tenant_not_found', JSON.stringify(result));
    assert.deepEqual(none, []);
    // Without EXECUTE on the writer the API refuses before Check Alt, too.
    await client.query('REVOKE EXECUTE ON FUNCTION public.aws_register_checkalt_tenant_account(uuid, jsonb) FROM checksops, authenticated');
    result = await register(OWNER, {}, none);
    assert.equal(result.error, 'register_writer_missing', JSON.stringify(result));
    assert.deepEqual(none, []);
    await client.query('GRANT EXECUTE ON FUNCTION public.aws_register_checkalt_tenant_account(uuid, jsonb) TO checksops, authenticated');

    // Platform owner registers: one production row, full number stored, payload masked.
    const calls = [];
    result = await register(OWNER, {}, calls);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.account_last4, '6789');
    assert.equal(JSON.stringify(result).includes(FULL), false);
    assert.ok(calls.some((u) => u.endsWith('/useraccount/register')));
    let row = await stored();
    assert.equal(row.deposit_account_number, FULL);
    assert.equal(row.sso_user_id, 'dep-1');
    assert.equal(row.enabled, true);
    assert.ok(row.registered_at);
    assert.equal(row.last_register_payload.sso_key, 'sso-live');
    assert.equal(JSON.stringify(row.last_register_payload).includes(FULL), false);

    // Re-register updates the same row and leaves Auto-Deposit (SQL 80) alone.
    await client.query('UPDATE public.checkalt_tenant_accounts SET auto_approve_enabled = true, auto_approve_max_cents = 50000, enabled = false');
    result = await register(OWNER, { sso_user_id: 'dep-2', deposit_account_number: '5550001234' });
    assert.equal(result.success, true, JSON.stringify(result));
    row = await stored();
    assert.equal(row.sso_user_id, 'dep-2');
    assert.equal(row.deposit_account_number, '5550001234');
    assert.equal(row.enabled, true);
    assert.equal(row.auto_approve_enabled, true);
    assert.equal(row.auto_approve_max_cents, 50000);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public.checkalt_tenant_accounts')).rows[0].n, 1);

    // Verify: status and live lookup through RLS as the owner, masked, nothing written.
    const before = JSON.stringify(await stored());
    const status = await as(OWNER, () => handleProductionCheckAltVerify({
      client, body: { tenant_id: TENANT_A, action: 'status' }, deps: { loadProductionSecrets: secrets },
    }));
    assert.equal(status.status, 'registered', JSON.stringify(status));
    assert.equal(status.account_last4, '1234');
    const live = await as(OWNER, () => handleProductionCheckAltVerify({
      client, body: { tenant_id: TENANT_A, action: 'account' }, fetchImpl: checkAltFetch([]), deps: { loadProductionSecrets: secrets },
    }));
    assert.equal(live.success, true, JSON.stringify(live));
    assert.equal(live.data.accountNumber, '****1234');
    assert.equal(JSON.stringify(live).includes('5550001234'), false);
    assert.equal(JSON.stringify(await stored()), before);

    // Tenant admin and platform admin (not the owner) are refused by the API and by the function.
    for (const user of [A_ADMIN, PLATFORM_ADMIN]) {
      result = await register(user, { sso_user_id: 'stolen' });
      assert.equal(result.error, 'not_authorized', user);
      await assert.rejects(
        as(user, () => client.query('SELECT public.aws_register_checkalt_tenant_account($1::uuid, $2::jsonb)', [TENANT_A, {
          sso_user_id: 'stolen', first_name: 'x', last_name: 'y', email: 'x@y.example', deposit_account_number: '99999999',
        }])),
        (e) => e.code === '42501',
        user,
      );
    }
    assert.equal((await stored()).sso_user_id, 'dep-2');

    // The function itself validates, even without the Node gate.
    const direct = (account, tenant = TENANT_A) => as(OWNER, () => client.query(
      'SELECT public.aws_register_checkalt_tenant_account($1::uuid, $2::jsonb) AS r', [tenant, account],
    ));
    const good = { sso_user_id: 'dep-3', first_name: 'x', last_name: 'y', email: 'x@y.example', deposit_account_number: '44445555' };
    for (const [bad, detail] of [
      [{ ...good, deposit_account_number: '4444-5555' }, 'deposit_account_number'],
      [{ ...good, deposit_account_number: '123' }, 'deposit_account_number'],
      [{ ...good, deposit_account_number: '4321' }, 'deposit_account_number'],
      [{ ...good, deposit_account_number: '1'.repeat(18) }, 'deposit_account_number'],
      [{ ...good, deposit_account_number: 44445555 }, 'deposit_account_number'],
      [{ ...good, email: 'nope' }, 'email'],
      [{ ...good, sso_user_id: 'has space' }, 'sso_user_id'],
      [{ ...good, auto_approve_enabled: true }, 'auto_approve_enabled'],
      [{ ...good, enabled: false }, 'enabled'],
      [{ ...good, last_register_payload: 'x' }, 'last_register_payload'],
    ]) {
      await assert.rejects(direct(bad), (e) => e.code === '22023' && e.detail === detail, JSON.stringify(bad));
    }
    await assert.rejects(
      direct({ ...good, last_register_payload: { echo: 'acct 44445555' } }),
      (e) => e.code === '22023' && /unmasked_account_number/.test(e.message),
    );
    await assert.rejects(direct(good, TENANT_MISSING), (e) => e.code === 'P0002');
    const ok = (await direct(good)).rows[0].r;
    assert.equal(ok.account_last4, '5555');
    assert.equal(JSON.stringify(ok).includes('44445555'), false);

    // Still no table INSERT/UPDATE for anyone but the definer.
    await assert.rejects(
      as(OWNER, () => client.query('UPDATE public.checkalt_tenant_accounts SET deposit_account_number = $1', ['11112222'])),
      /permission denied/,
    );
  } finally {
    await client.end();
    server.stop();
  }
});
