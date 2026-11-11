/**
 * SQL 154 (SQL 151 plus EXECUTE on aws_starter_package_checks_used(uuid) for checksops, which the API's
 * billing snapshot calls) against PostgreSQL 16: the optional Starter Package. SQL 151 leaves checksops
 * without that EXECUTE (why it is never applied); SQL 154 grants it. Objects are owned by a non-superuser
 * checksops_admin LOGIN (production's admin login, which applies the file); the API login checksops
 * writes checkalt_deposits and moov_invoices and calls the platform owner's setter as the signed-in
 * user (request.app_user_id). SQL 120 and SQL 152 (SQL 149's replacement) are applied first, as on staging and production;
 * SQL 102's column guard helpers are stand-ins with SQL 102's names.
 *
 * Owner decisions (2026-11-10): 250 included Checks that roll over (no expiry); a failed deposit uses
 * one; other fees are still charged; a toggle with start and end dates.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const SQL_120 = path.join(AWS_ROOT, 'workflows/sql/120_usage_events_at_approval_and_send.sql');
const SQL_152 = path.join(AWS_ROOT, 'workflows/sql/152_invoice_and_failed_deposit_fees.sql');
const SQL_151 = path.join(AWS_ROOT, 'workflows/sql/' + '151_tenant_starter_package.sql');
const SQL_154 = path.join(AWS_ROOT, 'workflows/sql/154_tenant_starter_package.sql');

const T = '11111111-1111-4111-8111-111111111111'; // on the package
const T_OFF = '22222222-2222-4222-8222-222222222222'; // not on it
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // the platform owner
const MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // a member of T
const CLAIM = '66666666-6666-4666-8666-666666666666';
const check = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const SCHEMA = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin;
GRANT USAGE ON SCHEMA public TO checksops;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO checksops, checksops_admin;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.app_user_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.uid() TO checksops, checksops_admin;
SET ROLE checksops_admin;
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY, name text, per_check_billing_enabled boolean, per_check_rate_cents integer,
  next_day_rate_cents integer, same_day_rate_cents integer, monthly_rate_cents integer);
CREATE TABLE public.tenant_users (tenant_id uuid, user_id uuid);
CREATE TABLE public.tenant_pricing_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, actor_id uuid, field text NOT NULL,
  old_value jsonb, new_value jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, status text, claim_id uuid, check_number text);
CREATE TABLE public.check_billing_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price_per_check_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd', active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid,
  payment_transfer_id uuid, event_type text DEFAULT 'check_processing',
  unit_price_cents integer NOT NULL, currency text NOT NULL DEFAULT 'usd', status text NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded','reported','invoiced','failed','voided')),
  billed_at timestamptz NOT NULL DEFAULT now(), billing_period text, invoice_id uuid, source_kind text,
  source_id uuid, claim_id uuid, mortgage_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_billing_events_check_event_unique UNIQUE (check_intake_item_id, event_type));
ALTER TABLE public.check_billing_events ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, tenant_id uuid,
  status text NOT NULL DEFAULT 'pending', submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, provider text NOT NULL DEFAULT 'moov',
  status text NOT NULL DEFAULT 'draft', speed text NOT NULL DEFAULT 'standard', requested_speed text, leg_role text,
  check_id uuid, claim_id uuid, provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.moov_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft',
  sent_at timestamptz, claim_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.tenant_maintenance_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, amount_cents integer);
GRANT SELECT, INSERT, UPDATE ON public.checkalt_deposits, public.payment_transfers, public.moov_invoices TO checksops;
GRANT SELECT ON public.check_billing_events, public.tenant_pricing_audit TO checksops;
GRANT SELECT, UPDATE ON public.tenants TO checksops;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY t_read ON public.tenants FOR SELECT TO checksops USING (true);
CREATE POLICY t_write ON public.tenants FOR UPDATE TO checksops USING (true) WITH CHECK (true);
-- SQL 98's price functions, as that file defines them.
CREATE FUNCTION public.aws_check_billing_default_price_cents() RETURNS integer LANGUAGE sql STABLE
  SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT c.price_per_check_cents FROM public.check_billing_config c WHERE c.active = true ORDER BY c.created_at DESC LIMIT 1 $$;
CREATE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path = public AS $$ SELECT true $$;
-- SQL 96 / SQL 102 helpers the column guard calls (stand-ins with their names).
CREATE FUNCTION public.aws_is_authenticated() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid() IS NOT NULL $$;
CREATE FUNCTION public.is_platform_owner() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid() = '${OWNER}'::uuid $$;
CREATE FUNCTION public.aws_is_tenant_member(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_users u WHERE u.tenant_id = t AND u.user_id = auth.uid()) $$;
CREATE FUNCTION public.aws_tenant_pricing_columns() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['monthly_rate_cents', 'per_check_billing_enabled', 'per_check_rate_cents', 'next_day_rate_cents', 'same_day_rate_cents'] $$;
CREATE FUNCTION public.aws_tenant_profile_columns() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['name'] $$;
CREATE FUNCTION public.aws_tenant_has_moov_account(t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.aws_tenants_member_column_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER aws_tenants_member_column_guard BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.aws_tenants_member_column_guard();
INSERT INTO public.check_billing_config (price_per_check_cents) VALUES (400);
INSERT INTO public.tenants (id, name, per_check_billing_enabled, monthly_rate_cents) VALUES
  ('${T}', 'On package', false, 10000), ('${T_OFF}', 'Off package', false, 10000);
INSERT INTO public.tenant_users VALUES ('${T}', '${MEMBER}');
INSERT INTO public.check_intake_items (id, tenant_id, status, claim_id, check_number)
  SELECT ('c0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, CASE WHEN n > 90 THEN '${T_OFF}'::uuid ELSE '${T}'::uuid END,
         'needs_review', '${CLAIM}', n::text
    FROM generate_series(1, 99) n;
RESET ROLE;
`;

test('SQL 154: the Starter Package includes Checks, a failed deposit uses one, the setter is the platform owner\'s (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql154-starter-', 56600);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  const owner = new pg.Client({ host: server.host, port: server.port, user: 'checksops_admin', database: 'postgres' });
  const api = new pg.Client({ host: server.host, port: server.port, user: 'checksops', database: 'postgres' });
  const as = async (user, sql, params) => {
    await api.query('SELECT set_config($1, $2, false)', ['request.app_user_id', user || '']);
    return api.query(sql, params);
  };
  const setPkg = (user, ...args) => as(user,
    'SELECT public.aws_platform_owner_set_tenant_starter_package($1::uuid, $2::boolean, $3::date, $4::date, $5::integer) AS r', args);
  const fees = async (tenant) => (await superuser.query(
    `SELECT event_type, unit_price_cents, status, package_included, check_intake_item_id, source_id
       FROM public.check_billing_events WHERE tenant_id = $1 ORDER BY created_at`, [tenant])).rows;
  const deposit = async (n, status, tenant = T) => (await api.query(
    'INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ($1, $2, $3) RETURNING id',
    [check(n), tenant, status])).rows[0].id;
  try {
    await superuser.connect();
    await superuser.query(SCHEMA);
    await owner.connect();
    for (const file of [SQL_120, SQL_152, SQL_154]) await owner.query(fs.readFileSync(file, 'utf8'));
    await owner.query(fs.readFileSync(SQL_154, 'utf8')); // idempotent
    await api.connect();

    // Every tenant starts off the package, with 250 included Checks once it is turned on.
    const cols = (await superuser.query(
      `SELECT starter_package_enabled, starter_package_included_checks FROM public.tenants ORDER BY id`)).rows;
    assert.deepEqual(cols.map((r) => [r.starter_package_enabled, r.starter_package_included_checks]), [[false, 250], [false, 250]]);

    // Only the platform owner can set it; a member and a signed-out caller are refused.
    await assert.rejects(setPkg(MEMBER, T, true, '2026-11-01', null, null), (e) => e.code === '42501');
    await assert.rejects(setPkg(null, T, true, '2026-11-01', null, null), (e) => e.code === '42501');
    await assert.rejects(setPkg(OWNER, T, true, null, null, null), (e) => e.code === '22023' && e.detail === 'starter_package_starts_on');
    await assert.rejects(setPkg(OWNER, T, true, '2026-11-01', '2026-10-01', null), (e) => e.code === '22023');
    await assert.rejects(setPkg(OWNER, T, true, '2026-11-01', null, -1), (e) => e.code === '22023');
    await assert.rejects(setPkg(OWNER, '99999999-9999-4999-8999-999999999999', true, '2026-11-01', null, null), (e) => e.code === 'P0002');
    // On, from Nov 1 2026, 3 included Checks for this test; ends_on defaults to 12 months less a day.
    const saved = (await setPkg(OWNER, T, true, '2026-11-01', null, 3)).rows[0].r;
    assert.deepEqual(
      [saved.starter_package_enabled, saved.starter_package_starts_on, saved.starter_package_maintenance_ends_on, saved.starter_package_included_checks, saved.starter_package_checks_used],
      [true, '2026-11-01', '2027-10-31', 3, 0]);
    const audit = (await superuser.query(`SELECT field, actor_id FROM public.tenant_pricing_audit WHERE tenant_id = $1 ORDER BY field`, [T])).rows;
    assert.deepEqual(audit.map((r) => r.field), ['starter_package_enabled', 'starter_package_included_checks', 'starter_package_maintenance_ends_on', 'starter_package_starts_on']);
    assert.ok(audit.every((r) => r.actor_id === OWNER));
    // A member cannot change the package columns directly (the guard); the platform owner may.
    await assert.rejects(as(MEMBER, `UPDATE public.tenants SET starter_package_included_checks = 999 WHERE id = $1`, [T]), (e) => e.code === '42501');
    await assert.rejects(as(MEMBER, `UPDATE public.tenants SET starter_package_enabled = false WHERE id = $1`, [T]), (e) => /starter_package_enabled/.test(e.message));
    await as(MEMBER, `UPDATE public.tenants SET name = 'Renamed' WHERE id = $1`, [T]);
    await as(null, 'SELECT 1');

    // Approved checks use included Checks at 0 until they run out, then the check fee applies.
    for (const n of [1, 2]) await deposit(n, 'submitted');
    let rows = await fees(T);
    assert.deepEqual(rows.map((r) => [r.event_type, r.unit_price_cents, r.package_included]), [
      ['check_processing', 0, true], ['check_processing', 0, true],
    ]);
    // A failed deposit uses one: check 3 approved (third Check), then rejected: its check fee is voided
    // (frees that Check) and the failed deposit fee takes it, at 0.
    const failed = await deposit(3, 'pending');
    await api.query(`UPDATE public.checkalt_deposits SET status = 'submitted' WHERE id = $1`, [failed]);
    await api.query(`UPDATE public.checkalt_deposits SET status = 'rejected' WHERE id = $1`, [failed]);
    rows = await fees(T);
    assert.deepEqual(rows.map((r) => [r.event_type, r.unit_price_cents, r.status, r.package_included]), [
      ['check_processing', 0, 'recorded', true],
      ['check_processing', 0, 'recorded', true],
      ['check_processing', 0, 'voided', true],
      ['failed_deposit', 0, 'recorded', true],
    ]);
    assert.equal((await superuser.query('SELECT public.aws_starter_package_checks_used($1) AS n', [T])).rows[0].n, 3);
    // All 3 used: the next check and the next failed deposit are charged.
    await deposit(4, 'submitted');
    await deposit(5, 'error');
    rows = (await fees(T)).slice(4);
    assert.deepEqual(rows.map((r) => [r.event_type, r.unit_price_cents, r.package_included]), [
      ['check_processing', 400, false], ['failed_deposit', 200, false],
    ]);
    // Check 3 approved again: its voided included fee is recorded again with no room left -> charged.
    await deposit(3, 'submitted');
    const again = (await fees(T)).find((r) => r.check_intake_item_id === check(3));
    assert.deepEqual([again.status, again.unit_price_cents, again.package_included], ['recorded', 400, false]);

    // Other fees are still charged: an invoice sent is $0.30.
    await api.query(`INSERT INTO public.moov_invoices (tenant_id, status, sent_at) VALUES ($1, 'unpaid', now())`, [T]);
    assert.deepEqual((await fees(T)).filter((r) => r.event_type === 'invoice_sent').map((r) => [r.unit_price_cents, r.package_included]), [[30, false]]);

    // More included Checks (roll over, no expiry): the next check uses one again.
    await setPkg(OWNER, T, true, null, null, 10);
    await deposit(6, 'submitted');
    const six = (await fees(T)).find((r) => r.check_intake_item_id === check(6));
    assert.deepEqual([six.unit_price_cents, six.package_included], [0, true]);
    // Turned off: charged again; dates kept.
    const off = (await setPkg(OWNER, T, false, null, null, null)).rows[0].r;
    assert.deepEqual([off.starter_package_enabled, off.starter_package_starts_on, off.starter_package_maintenance_ends_on], [false, '2026-11-01', '2027-10-31']);
    await deposit(7, 'submitted');
    assert.equal((await fees(T)).find((r) => r.check_intake_item_id === check(7)).unit_price_cents, 400);

    // A tenant not on the package is never touched; nor is a package that has not started.
    await deposit(91, 'submitted', T_OFF);
    assert.deepEqual((await fees(T_OFF)).map((r) => [r.unit_price_cents, r.package_included]), [[400, false]]);
    await setPkg(OWNER, T_OFF, true, '2099-01-01', null, 5);
    await deposit(92, 'submitted', T_OFF);
    assert.deepEqual((await fees(T_OFF)).map((r) => r.package_included), [false, false]);

    // The API (checksops) reads the Checks used in the billing snapshot (tenant-billing-engine.mjs
    // loadTenantBillingContext) as itself: SQL 154's one change from SQL 151.
    assert.equal((await as(null, `SELECT t.starter_package_enabled, public.aws_starter_package_checks_used(t.id) AS used
      FROM public.tenants t WHERE t.id = $1::uuid`, [T])).rows[0].used,
      (await superuser.query('SELECT public.aws_starter_package_checks_used($1) AS n', [T])).rows[0].n);
    // The trigger functions run for their owner only; the setter and the Checks used are the API's (checksops).
    const execs = (await superuser.query(
      `SELECT p.proname, has_function_privilege('checksops', p.oid, 'EXECUTE') AS api_exec
         FROM pg_proc p WHERE p.proname IN ('aws_apply_starter_package_to_event', 'aws_tenant_starter_package_audit_row',
           'aws_starter_package_checks_used', 'aws_platform_owner_set_tenant_starter_package') ORDER BY p.proname`)).rows;
    assert.deepEqual(execs.map((r) => [r.proname, r.api_exec]), [
      ['aws_apply_starter_package_to_event', false],
      ['aws_platform_owner_set_tenant_starter_package', true],
      ['aws_starter_package_checks_used', true],
      ['aws_tenant_starter_package_audit_row', false],
    ]);
    // No other grant: only checksops and the owner on the setter and the Checks used, only the owner on the triggers'.
    const acls = (await superuser.query(
      `SELECT p.proname, (SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type ORDER BY 1)
                            FROM aclexplode(p.proacl) a) AS acl
         FROM pg_proc p WHERE p.proname IN ('aws_apply_starter_package_to_event', 'aws_tenant_starter_package_audit_row',
           'aws_starter_package_checks_used', 'aws_platform_owner_set_tenant_starter_package') ORDER BY p.proname`)).rows;
    assert.deepEqual(acls.map((r) => [r.proname, [...r.acl].sort()]), [
      ['aws_apply_starter_package_to_event', ['checksops_admin:EXECUTE']],
      ['aws_platform_owner_set_tenant_starter_package', ['checksops:EXECUTE', 'checksops_admin:EXECUTE']],
      ['aws_starter_package_checks_used', ['checksops:EXECUTE', 'checksops_admin:EXECUTE']],
      ['aws_tenant_starter_package_audit_row', ['checksops_admin:EXECUTE']],
    ]);
  } finally {
    await api.end().catch(() => {});
    await owner.end().catch(() => {});
    await superuser.end().catch(() => {});
    server.stop();
  }
});

test('SQL 154 refuses to run without SQL 152', { timeout: 120000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql154-prereq-', 56700);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  try {
    await superuser.connect();
    await superuser.query(SCHEMA);
    await superuser.query(fs.readFileSync(SQL_120, 'utf8'));
    await assert.rejects(superuser.query(fs.readFileSync(SQL_154, 'utf8')), (err) => (
      err.code === '55000' && /sql154_prerequisite_missing: .*SQL 152/.test(err.message)));
  } finally {
    await superuser.end().catch(() => {});
    server.stop();
  }
});

test('SQL 151 (never applied) leaves checksops without EXECUTE on aws_starter_package_checks_used, so the API cannot read the package; SQL 154 is SQL 151 plus that grant', { timeout: 120000, skip: pgSkipReason() || false }, async () => {
  const sql151 = fs.readFileSync(SQL_151, 'utf8');
  const sql154 = fs.readFileSync(SQL_154, 'utf8');
  const grant = 'GRANT EXECUTE ON FUNCTION public.aws_starter_package_checks_used(uuid) TO checksops;\n';
  const code = (text) => text.split('\n').filter((line) => !line.startsWith('--')).join('\n');
  const normalize = (text) => code(text).replace(/sql15[14]_/g, 'sqlN_').replace(/'SQL 15[14]( \(replaces SQL 102\))?: /g, "'SQL N$1: ")
    .replace(/'SQL 15[14] \(replaces SQL 102\)/g, "'SQL N (replaces SQL 102)").replace('aws_failed_deposit_fee_cents() (SQL 149)', 'aws_failed_deposit_fee_cents() (SQL 152)');
  assert.equal(code(sql154).split(grant).length, 2);
  assert.equal(normalize(code(sql154).replace(grant, '')), normalize(sql151));
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql151-acl-', 56800);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  const owner = new pg.Client({ host: server.host, port: server.port, user: 'checksops_admin', database: 'postgres' });
  const api = new pg.Client({ host: server.host, port: server.port, user: 'checksops', database: 'postgres' });
  try {
    await superuser.connect();
    await superuser.query(SCHEMA);
    await owner.connect();
    for (const file of [SQL_120, SQL_152, SQL_151]) await owner.query(fs.readFileSync(file, 'utf8'));
    await api.connect();
    await assert.rejects(api.query('SELECT public.aws_starter_package_checks_used($1::uuid) AS n', [T]), (e) => e.code === '42501');
    await owner.query(sql154);
    assert.equal((await api.query('SELECT public.aws_starter_package_checks_used($1::uuid) AS n', [T])).rows[0].n, 0);
  } finally {
    await api.end().catch(() => {});
    await owner.end().catch(() => {});
    await superuser.end().catch(() => {});
    server.stop();
  }
});
