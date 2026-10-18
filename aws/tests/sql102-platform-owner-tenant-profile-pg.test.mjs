/**
 * SQL 102 (aws/workflows/sql/102_platform_owner_tenant_profile.sql) on PostgreSQL 16, with the
 * real SQL 29 / 30 and SQL 90-101 files applied first on the release fixture
 * (helpers/release-sql-pg.mjs: every object owned by the non-superuser checksops_admin;
 * checksops is the API login in role authenticated; the caller is request.app_user_id):
 *
 *   - the platform owner's aws_platform_owner_set_tenant_profile changes each profile field
 *     (normalised where the file says so) and every change is audited in tenant_pricing_audit
 *     by the trigger (one row per changed field, actor, old -> new);
 *   - slug / partner_code: 22023 field_not_editable; any other key (moov_environment too):
 *     22023 invalid_field; bad values: 22023 invalid_value; no tenant: P0002;
 *   - is_test_account moves moov_environment (sandbox / production); once the tenant has a
 *     moov payment_provider_accounts row a change is refused (55000 moov_environment_locked),
 *     but sending the unchanged value is not; without payment_provider_accounts the lock is
 *     skipped (the nested IF never names the missing table);
 *   - a non-owner member gets 42501 from both functions, and still cannot change pricing or
 *     owner-only profile columns through a direct UPDATE (the column guard), while branding
 *     still works;
 *   - aws_platform_owner_remove_tenant_member deletes only that membership (the account and the
 *     user's other memberships stay), audits it (member_removed) and answers P0002
 *     membership_not_found the second time.
 *
 * Run: sudo -n -u ubuntu /opt/node22/bin/node --test aws/tests/sql102-platform-owner-tenant-profile-pg.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  MEMBER_A, MEMBER_B, PLATFORM_OWNER, REPO_ROOT, TENANT_A, TENANT_B, pgSkipReason, releaseFixture, sql98To100Schema,
} from './helpers/release-sql-pg.mjs';

const sql = (name) => fs.readFileSync(path.join(REPO_ROOT, 'aws/workflows/sql', name), 'utf8');
const BEFORE = Object.freeze([
  '90_users_only_tenant_roles.sql', '91_moov_onboarding.sql', '92_signature_request_check_files_link_grant.sql',
  '93_tenant_company_info.sql', '94_document_library_restore.sql', '96_platform_owner_tenant_pricing.sql',
  '97_financial_stepup_log_server_writer.sql', '95_remove_freedom_claims_bridge.sql', '98_tenant_fee_collection.sql',
  '99_mortgage_desk_completion_messages.sql', '100_mortgage_desk_live_access.sql', '101_invite_identity_insert_order.sql',
]);
const SQL_102 = sql('102_platform_owner_tenant_profile.sql');
const TEAMMATE = 'a1000000-0000-4000-8000-00000000000a';
const NO_TENANT = '99999999-9999-4999-8999-999999999999';

/** The tenants profile columns as the Supabase-era migrations left them, and the real provider column. */
const PROFILE_SCHEMA = `
ALTER TABLE public.tenants ADD COLUMN slug text UNIQUE, ADD COLUMN custom_domain text UNIQUE,
  ADD COLUMN max_checks_per_month integer DEFAULT 100, ADD COLUMN is_test_account boolean NOT NULL DEFAULT false,
  ADD COLUMN moov_environment text NOT NULL DEFAULT 'sandbox', ADD COLUMN kyc_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN kyc_notes text, ADD COLUMN internal_notes text;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_kyc_status_check CHECK (kyc_status IN ('pending','approved','rejected'));
ALTER TABLE public.payment_provider_accounts ADD COLUMN provider text NOT NULL DEFAULT 'moov';
UPDATE public.tenants SET slug = 'tenant-a', partner_code = 'PA', moov_environment = 'production' WHERE id = '${TENANT_A}';
UPDATE public.tenants SET slug = 'tenant-b', partner_code = 'PB' WHERE id = '${TENANT_B}';
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES ('${TEAMMATE}', 'teammate@example.invalid', 'active');
INSERT INTO public.profiles (id, email) VALUES ('${TEAMMATE}', 'teammate@example.invalid');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_A}', '${TEAMMATE}', 'viewer'), ('${TENANT_B}', '${TEAMMATE}', 'viewer');
`;

const SET = 'SELECT public.aws_platform_owner_set_tenant_profile($1, $2::jsonb) AS r';
const REMOVE = 'SELECT public.aws_platform_owner_remove_tenant_member($1, $2) AS r';

test('PostgreSQL 16: SQL 102 profile setter and member removal are platform-owner only, validated, audited; the guard still limits members', {
  timeout: 300000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const fx = await releaseFixture(pg, 'pg-sql102-profile-', 64100, { extra: [...sql98To100Schema(), PROFILE_SCHEMA] });
  let api = null;
  try {
    const { admin, connectAs, applyPredecessors } = fx;
    await applyPredecessors();
    const owner = await connectAs('checksops_admin');
    try {
      for (const file of BEFORE) await owner.query(sql(file));
      await owner.query(SQL_102);
      await owner.query(SQL_102); // idempotent
    } finally {
      await owner.end();
    }

    api = await connectAs('checksops');
    const as = async (user, text, params) => {
      await api.query('BEGIN');
      try {
        await api.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const out = await api.query(text, params);
        await api.query('COMMIT');
        return out;
      } catch (error) {
        await api.query('ROLLBACK');
        throw error;
      }
    };
    const setProfile = (user, body, tenant = TENANT_A) => as(user, SET, [tenant, JSON.stringify(body)]);
    const refuses = (promise, code, message, detail) => assert.rejects(promise, (e) => {
      assert.equal(e.code, code, `${e.code} ${e.message}`);
      assert.match(e.message, message);
      if (detail !== undefined) assert.equal(e.detail, detail);
      return true;
    });
    const tenantA = async () => (await admin.query(`SELECT name, slug, partner_code, custom_domain, subscription_status,
      max_checks_per_month, is_test_account, moov_environment, kyc_status, kyc_notes, internal_notes FROM public.tenants WHERE id = $1`, [TENANT_A])).rows[0];
    const audit = async (since) => (await admin.query(`SELECT field, actor_id, old_value, new_value FROM public.tenant_pricing_audit
      WHERE tenant_id = $1 AND created_at >= $2 ORDER BY field`, [TENANT_A, since])).rows;
    const now = async () => (await admin.query('SELECT clock_timestamp() AS t')).rows[0].t;

    // 1) The platform owner changes each field; one audit row per changed field (moov_environment follows).
    let since = await now();
    const saved = (await setProfile(PLATFORM_OWNER, {
      name: '  Acme Roofing  ', custom_domain: 'Checks.Acme-Roofing.COM', subscription_status: 'past_due',
      max_checks_per_month: 250, is_test_account: true, kyc_status: 'approved', kyc_notes: 'ID verified', internal_notes: 'VIP',
    })).rows[0].r;
    const want = {
      name: 'Acme Roofing', slug: 'tenant-a', partner_code: 'PA', custom_domain: 'checks.acme-roofing.com', subscription_status: 'past_due',
      max_checks_per_month: 250, is_test_account: true, moov_environment: 'sandbox', kyc_status: 'approved', kyc_notes: 'ID verified', internal_notes: 'VIP',
    };
    assert.deepEqual(await tenantA(), want);
    assert.equal(saved.ok, true);
    assert.equal(saved.tenant_id, TENANT_A);
    assert.deepEqual(saved.tenant, { id: TENANT_A, ...want });
    assert.deepEqual(await audit(since), [
      { field: 'custom_domain', actor_id: PLATFORM_OWNER, old_value: null, new_value: 'checks.acme-roofing.com' },
      { field: 'internal_notes', actor_id: PLATFORM_OWNER, old_value: null, new_value: 'VIP' },
      { field: 'is_test_account', actor_id: PLATFORM_OWNER, old_value: false, new_value: true },
      { field: 'kyc_notes', actor_id: PLATFORM_OWNER, old_value: null, new_value: 'ID verified' },
      { field: 'kyc_status', actor_id: PLATFORM_OWNER, old_value: 'pending', new_value: 'approved' },
      { field: 'max_checks_per_month', actor_id: PLATFORM_OWNER, old_value: 100, new_value: 250 },
      { field: 'moov_environment', actor_id: PLATFORM_OWNER, old_value: 'production', new_value: 'sandbox' },
      { field: 'name', actor_id: PLATFORM_OWNER, old_value: 'A', new_value: 'Acme Roofing' },
      { field: 'subscription_status', actor_id: PLATFORM_OWNER, old_value: 'active', new_value: 'past_due' },
    ]);
    // An empty custom domain clears it; notes may be cleared with null; only the changed fields are audited.
    since = await now();
    await setProfile(PLATFORM_OWNER, { custom_domain: '', kyc_notes: null, kyc_status: 'approved' });
    assert.equal((await tenantA()).custom_domain, null);
    assert.deepEqual((await audit(since)).map((row) => row.field), ['custom_domain', 'kyc_notes']);

    // 2) slug and partner_code are permanent; other keys are not profile fields.
    for (const key of ['slug', 'partner_code']) {
      await refuses(setProfile(PLATFORM_OWNER, { [key]: 'changed' }), '22023', /field_not_editable/, key);
    }
    for (const key of ['moov_environment', 'per_check_rate_cents', 'deposits_enabled', 'logo_url', 'id']) {
      await refuses(setProfile(PLATFORM_OWNER, { [key]: 'x' }), '22023', /invalid_field/, key);
    }
    // 3) Bad values (and nothing is written by a refused call).
    const beforeBad = await tenantA();
    for (const [key, value] of [
      ['name', ''], ['name', '   '], ['name', 5], ['name', 'x'.repeat(201)],
      ['custom_domain', 'not a domain'], ['custom_domain', 'nodot'], ['custom_domain', 7],
      ['subscription_status', 'bogus'], ['subscription_status', null],
      ['max_checks_per_month', -1], ['max_checks_per_month', 1.5], ['max_checks_per_month', '10'], ['max_checks_per_month', 3000000000],
      ['is_test_account', 'yes'], ['is_test_account', null],
      ['kyc_status', 'maybe'], ['kyc_notes', 5], ['internal_notes', 'x'.repeat(10001)],
    ]) {
      await refuses(setProfile(PLATFORM_OWNER, { name: 'Should Not Stick', [key]: value }), '22023', /invalid_value/, key);
    }
    assert.deepEqual(await tenantA(), beforeBad);
    await refuses(setProfile(PLATFORM_OWNER, {}), '22023', /missing_required_field/);
    await refuses(setProfile(PLATFORM_OWNER, { name: 'Ghost' }, NO_TENANT), 'P0002', /tenant_not_found/);
    // A custom domain another tenant already has.
    await setProfile(PLATFORM_OWNER, { custom_domain: 'taken.example.com' }, TENANT_B);
    await refuses(setProfile(PLATFORM_OWNER, { custom_domain: 'taken.example.com' }), '23505', /value_in_use/, 'custom_domain');

    // 4) Test mode moves the ledger until the tenant has a Moov account; then it is locked.
    await setProfile(PLATFORM_OWNER, { is_test_account: false });
    assert.deepEqual([(await tenantA()).is_test_account, (await tenantA()).moov_environment], [false, 'production']);
    await admin.query(`INSERT INTO public.payment_provider_accounts (tenant_id, environment, provider) VALUES ($1, 'production', 'moov')`, [TENANT_A]);
    await refuses(setProfile(PLATFORM_OWNER, { is_test_account: true }), '55000', /moov_environment_locked/, 'is_test_account');
    assert.deepEqual([(await tenantA()).is_test_account, (await tenantA()).moov_environment], [false, 'production']);
    // The unchanged value is not a change of test mode: accepted with the other fields, no ledger move.
    since = await now();
    await setProfile(PLATFORM_OWNER, { is_test_account: false, internal_notes: 'has moov' });
    assert.deepEqual((await audit(since)).map((row) => row.field), ['internal_notes']);
    assert.equal((await tenantA()).moov_environment, 'production');
    // Another provider's account does not lock it.
    await admin.query('DELETE FROM public.payment_provider_accounts WHERE tenant_id = $1', [TENANT_A]);
    await admin.query(`INSERT INTO public.payment_provider_accounts (tenant_id, environment, provider) VALUES ($1, 'sandbox', 'other')`, [TENANT_A]);
    await setProfile(PLATFORM_OWNER, { is_test_account: true });
    assert.equal((await tenantA()).moov_environment, 'sandbox');
    // Without payment_provider_accounts at all the lock is skipped, not an error.
    await admin.query('ALTER TABLE public.payment_provider_accounts RENAME TO payment_provider_accounts_away');
    try {
      await setProfile(PLATFORM_OWNER, { is_test_account: false });
      assert.equal((await tenantA()).moov_environment, 'production');
    } finally {
      await admin.query('ALTER TABLE public.payment_provider_accounts_away RENAME TO payment_provider_accounts');
    }

    // 5) A non-owner member is refused by both functions.
    await refuses(setProfile(MEMBER_A, { name: 'Member Rename' }), '42501', /not_authorized/);
    await refuses(setProfile(MEMBER_B, { name: 'Partner Rename' }), '42501', /not_authorized/);
    await refuses(as(MEMBER_A, REMOVE, [TENANT_A, TEAMMATE]), '42501', /not_authorized/);

    // 6) The column guard: a member's direct UPDATE still changes only the branding columns.
    for (const set of ["per_check_rate_cents = 1", "kyc_status = 'rejected'", 'is_test_account = NOT is_test_account',
      "moov_environment = 'sandbox'", "internal_notes = 'member note'", "max_checks_per_month = 1", "slug = 'mine'", "partner_code = 'MINE'"]) {
      await refuses(as(MEMBER_A, `UPDATE public.tenants SET ${set} WHERE id = $1`, [TENANT_A]), '42501', /tenant_column_not_member_writable/, undefined);
    }
    since = await now();
    const branded = await as(MEMBER_A, "UPDATE public.tenants SET name = 'Member Branded', company_phone = '555-0100' WHERE id = $1", [TENANT_A]);
    assert.equal(branded.rowCount, 1);
    // The audit trigger records a profile field change by any path (here the member's name).
    assert.deepEqual(await audit(since), [{ field: 'name', actor_id: MEMBER_A, old_value: 'Acme Roofing', new_value: 'Member Branded' }]);
    // The platform owner's direct UPDATE still matches no row (SQL 90); slug and partner_code are refused for everyone.
    assert.equal((await as(PLATFORM_OWNER, "UPDATE public.tenants SET kyc_status = 'rejected' WHERE id = $1", [TENANT_A])).rowCount, 0);
    assert.equal((await tenantA()).slug, 'tenant-a');
    assert.equal((await tenantA()).partner_code, 'PA');

    // 7) Member removal: only that membership, audited; the second call finds none.
    const members = async () => (await admin.query('SELECT tenant_id, user_id FROM public.tenant_users ORDER BY tenant_id, user_id')).rows;
    const beforeRemove = await members();
    since = await now();
    const removed = (await as(PLATFORM_OWNER, REMOVE, [TENANT_A, TEAMMATE])).rows[0].r;
    assert.deepEqual(removed, { ok: true, tenant_id: TENANT_A, user_id: TEAMMATE, removed: 1 });
    assert.deepEqual(await members(), beforeRemove.filter((row) => !(row.tenant_id === TENANT_A && row.user_id === TEAMMATE)));
    assert.ok((await members()).some((row) => row.tenant_id === TENANT_B && row.user_id === TEAMMATE), 'other memberships stay');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.identity_accounts WHERE application_user_id = $1', [TEAMMATE])).rows[0].n, 1);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.profiles WHERE id = $1', [TEAMMATE])).rows[0].n, 1);
    assert.deepEqual(await audit(since), [{ field: 'member_removed', actor_id: PLATFORM_OWNER, old_value: TEAMMATE, new_value: null }]);
    await refuses(as(PLATFORM_OWNER, REMOVE, [TENANT_A, TEAMMATE]), 'P0002', /membership_not_found/);
    await refuses(as(PLATFORM_OWNER, REMOVE, [TENANT_A, null]), '22023', /missing_required_field/);

    // 8) The functions' shape: SECURITY DEFINER, EXECUTE for checksops and authenticated only.
    const acl = (await admin.query(`SELECT p.proname, p.prosecdef,
        (SELECT array_agg(g.name ORDER BY g.name) FROM (
           SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS name
             FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) g) AS grantees
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('aws_platform_owner_set_tenant_profile', 'aws_platform_owner_remove_tenant_member', 'aws_tenant_profile_audit_row')
      ORDER BY p.proname`)).rows;
    assert.deepEqual(acl, [
      { proname: 'aws_platform_owner_remove_tenant_member', prosecdef: true, grantees: ['authenticated', 'checksops'] },
      { proname: 'aws_platform_owner_set_tenant_profile', prosecdef: true, grantees: ['authenticated', 'checksops'] },
      { proname: 'aws_tenant_profile_audit_row', prosecdef: true, grantees: null },
    ]);
  } finally {
    await api?.end().catch(() => {});
    await fx.close();
  }
});
