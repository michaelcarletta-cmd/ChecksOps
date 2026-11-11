/**
 * SQL 76 through the release engine (owner 2026-11-11: "apply SQL 76 to production through the guarded path", then
 * "Option 1"), on PostgreSQL 16. The file is applied byte for byte by a non-superuser login that owns
 * public.tenant_partnerships and SQL 32's aws_connect_partner_by_code (as checksops_admin does in production), on the
 * production pre-state the read-only inspect (SSM d04fa1e2-74d4-4795-854e-db5acf14b59b) found: the guard and its
 * trigger absent, the five Supabase-era policies already absent, connect exactly SQL 32's.
 *
 * Proves: the engine reads that pre-state as releaseStateHash('sql76', {}) with no precondition failure; after the
 * apply it reads the code-derived intended fingerprint (the pin's), the guard EXECUTE for its owner only; the
 * connect, owner and trigger preconditions refuse a drifted connect body, a connect owned by the API login and a
 * foreign trigger on the table; and the guard works: an inviter cannot make a row live, the invitee can, and the
 * Partner Code redemption through connect still opens a live row.
 *
 * Run: node --test aws/tests/release-sql76-production-pg.test.mjs (needs PostgreSQL 16; as root the PG helpers run
 * the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  readReleaseSqlState,
  releaseIntendedHash,
  releaseSharedPreconditionFailures,
  releaseStateHash,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { RELEASE_2026_10_17_PENDING_SQL_PINS as STAGING } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const REPO = path.join(AWS_ROOT, '..');
const KEY = 'sql76';
const TEXT = fs.readFileSync(path.join(REPO, STAGING[KEY].filename), 'utf8');
const SQL32 = fs.readFileSync(path.join(REPO, 'aws/rls/sql/32_partner_share_lifecycle.sql'), 'utf8');
const INVITER_USER = '11111111-1111-4111-8111-111111111111';
const INVITEE_USER = '22222222-2222-4222-8222-222222222222';
const INVITER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVITEE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVITEE_CODE = 'AB3K7X9P';

const SCHEMA = `
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE checksops LOGIN IN ROLE authenticated;
CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.app_user_id', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, checksops_admin;
GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin;
CREATE TABLE public.tenant_users (user_id uuid, tenant_id uuid);
INSERT INTO public.tenant_users VALUES ('${INVITER_USER}', '${INVITER}'), ('${INVITEE_USER}', '${INVITEE}');
CREATE FUNCTION public.aws_user_tenant_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$ SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid() $$;
CREATE FUNCTION public.aws_can_write_tenant(_tenant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT _tenant IN (SELECT public.aws_user_tenant_ids()) $$;
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text, partner_code text UNIQUE, subscription_status text NOT NULL DEFAULT 'active');
INSERT INTO public.tenants (id, name, partner_code) VALUES ('${INVITER}', 'Inviter Co', 'ZZZZZZZ1'), ('${INVITEE}', 'Invitee Co', '${INVITEE_CODE}');
CREATE FUNCTION public.lookup_tenant_by_partner_code(_code text) RETURNS TABLE(id uuid, name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.name FROM public.tenants t
  WHERE t.subscription_status = 'active' AND t.partner_code = regexp_replace(upper(coalesce(_code, '')), '[^A-Z0-9]', '', 'g') LIMIT 1 $$;
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, status text);
CREATE TABLE public.tenant_partnerships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inviter_tenant_id uuid NOT NULL, invitee_tenant_id uuid,
  invite_code text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending', created_by uuid,
  created_at timestamptz DEFAULT now(), accepted_at timestamptz, revoked_at timestamptz);
CREATE TABLE public.shared_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, source_tenant_id uuid NOT NULL,
  target_tenant_id uuid NOT NULL, shared_by uuid, access_level text NOT NULL DEFAULT 'read_only',
  created_at timestamptz DEFAULT now(), revoked_at timestamptz,
  CONSTRAINT shared_checks_unique_active UNIQUE (check_id, source_tenant_id, target_tenant_id));
ALTER TABLE public.tenant_partnerships ENABLE ROW LEVEL SECURITY;
CREATE POLICY aws_select_tenant_partnerships ON public.tenant_partnerships FOR SELECT TO authenticated
  USING (inviter_tenant_id IN (SELECT public.aws_user_tenant_ids()) OR invitee_tenant_id IN (SELECT public.aws_user_tenant_ids()));
CREATE POLICY aws_write_tenant_partnerships ON public.tenant_partnerships FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(inviter_tenant_id) OR public.aws_can_write_tenant(invitee_tenant_id))
  WITH CHECK (public.aws_can_write_tenant(inviter_tenant_id) OR public.aws_can_write_tenant(invitee_tenant_id));
GRANT SELECT, INSERT, UPDATE ON public.tenant_partnerships TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_user_tenant_ids(), public.aws_can_write_tenant(uuid) TO authenticated;
`;

test('SQL 76 on the release engine: production pre-state, preconditions, intended fingerprint and the guard (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('release-sql76-', 64300);
  const connect = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  const admin = await connect('ubuntu');
  try {
    await admin.query(SCHEMA);
    await admin.query(SQL32);
    // As in production: the admin login owns the table and connect (not a superuser).
    await admin.query(`ALTER TABLE public.tenant_partnerships OWNER TO checksops_admin;
      ALTER FUNCTION public.aws_connect_partner_by_code(text, uuid) OWNER TO checksops_admin;
      ALTER TABLE public.shared_checks OWNER TO checksops_admin;`);
    const owner = await connect('checksops_admin');
    const read = async () => {
      await owner.query('BEGIN READ ONLY');
      try { return (await readReleaseSqlState(owner, KEY)).details; } finally { await owner.query('ROLLBACK'); }
    };
    try {
      // The production pre-state: everything SQL 76 creates absent, the five policies absent.
      const before = await read();
      assert.equal(releaseStateHash(KEY, before), releaseStateHash(KEY, {}));
      assert.equal(releaseStateHash(KEY, {}), 'e1f21bd49f76bf0f619cbfb37f77c01711075e3c030ce1e271ee26052fff92d6');
      assert.deepEqual(releaseSharedPreconditionFailures(KEY, before, TEXT), []);
      for (const name of ['partnership_connect_pinned', 'partnership_connect_not_api_owned', 'tenant_partnerships_no_other_trigger']) {
        assert.equal(before.counts[name], 1, name);
      }

      // The preconditions refuse a drifted connect, a connect the API login owns and a foreign trigger.
      await admin.query('BEGIN');
      // (Its config drifted: search_path no longer exactly public, so PG_CONTEXT frames would print differently.)
      await admin.query('ALTER FUNCTION public.aws_connect_partner_by_code(text, uuid) SET search_path = public, pg_temp');
      const drift = (await readReleaseSqlState(admin, KEY)).details;
      await admin.query('ROLLBACK');
      assert.ok(releaseSharedPreconditionFailures(KEY, drift, TEXT).includes('partnership_connect_pinned'));
      // (Its body drifted: one character appended to prosrc.)
      await admin.query('BEGIN');
      await admin.query(`UPDATE pg_catalog.pg_proc SET prosrc = prosrc || ' '
        WHERE oid = pg_catalog.to_regprocedure('public.aws_connect_partner_by_code(text, uuid)')`);
      const bodyDrift = (await readReleaseSqlState(admin, KEY)).details;
      await admin.query('ROLLBACK');
      assert.ok(releaseSharedPreconditionFailures(KEY, bodyDrift, TEXT).includes('partnership_connect_pinned'));
      await admin.query('BEGIN');
      await admin.query('ALTER FUNCTION public.aws_connect_partner_by_code(text, uuid) OWNER TO checksops');
      const apiOwned = (await readReleaseSqlState(admin, KEY)).details;
      await admin.query('ROLLBACK');
      assert.ok(releaseSharedPreconditionFailures(KEY, apiOwned, TEXT).includes('partnership_connect_not_api_owned'));
      await admin.query('BEGIN');
      await admin.query(`CREATE FUNCTION public.t_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER other_trigger BEFORE INSERT ON public.tenant_partnerships FOR EACH ROW EXECUTE FUNCTION public.t_noop()`);
      const foreign = (await readReleaseSqlState(admin, KEY)).details;
      await admin.query('ROLLBACK');
      assert.ok(releaseSharedPreconditionFailures(KEY, foreign, TEXT).includes('tenant_partnerships_no_other_trigger'));

      // The apply, by the owner login, as the release engine runs the file.
      await owner.query('BEGIN');
      await owner.query(TEXT);
      await owner.query('COMMIT');
      const after = await read();
      assert.equal(releaseStateHash(KEY, after), releaseIntendedHash(KEY, TEXT));
      assert.equal(releaseStateHash(KEY, after), STAGING[KEY].intended_replacement_sha256);
      assert.deepEqual(after.functions['public.aws_tenant_partnership_consent_guard()'].acl, ['owner EXECUTE']);
      // Re-running the file (idempotent) keeps the same fingerprint.
      await owner.query('BEGIN');
      await owner.query(TEXT);
      await owner.query('COMMIT');
      assert.equal(releaseStateHash(KEY, await read()), STAGING[KEY].intended_replacement_sha256);
    } finally {
      await owner.end();
    }

    // The guard: the inviter cannot make a row live; the invitee can; connect still opens a live row.
    const api = await connect('checksops');
    try {
      await api.query(`SET request.app_user_id = '${INVITER_USER}'`);
      await api.query(`INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, invite_code, status)
        VALUES ('${INVITER}', '${INVITEE}', 'INV1', 'pending')`);
      await assert.rejects(
        api.query(`UPDATE public.tenant_partnerships SET status = 'active' WHERE invite_code = 'INV1'`),
        /partnership_invitee_consent_required/,
      );
      await api.query(`SET request.app_user_id = '${INVITEE_USER}'`);
      assert.equal((await api.query(`UPDATE public.tenant_partnerships SET status = 'active' WHERE invite_code = 'INV1'`)).rowCount, 1);
      await api.query(`UPDATE public.tenant_partnerships SET status = 'revoked', revoked_at = now() WHERE invite_code = 'INV1'`);
      await api.query(`SET request.app_user_id = '${INVITER_USER}'`);
      await api.query(`SELECT public.aws_connect_partner_by_code('${INVITEE_CODE}', '${INVITER}')`);
      const live = (await admin.query(`SELECT count(*)::int AS n FROM public.tenant_partnerships
        WHERE inviter_tenant_id = '${INVITER}' AND invitee_tenant_id = '${INVITEE}' AND status = 'active' AND revoked_at IS NULL`)).rows[0].n;
      assert.equal(live, 1);
    } finally {
      await api.end();
    }
  } finally {
    await admin.end();
    server.stop();
  }
});
