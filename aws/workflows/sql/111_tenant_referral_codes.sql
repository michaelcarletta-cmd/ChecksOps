-- SQL 111: tenant referral codes. Redeeming a referral code, the $5.00-per-referral maintenance
-- plan credit (at most $25.00 a month) and what each side of a referral sees.
--
-- Why:
-- 1) Settings > Refer & Earn calls apply_referral_code, the Supabase-era RPC. On AWS the API
--    refuses it (aws/functions/api/workflow-rpc.mjs classifies it financial_sensitive and the
--    generic /data/rpc path answers rpc_disabled), so entering a code always fails. The redeem
--    cannot be a generic write either: the redeeming tenant's members may not change
--    tenants.referred_by_tenant_id (aws_tenants_member_column_guard, SQL 102, refuses it with
--    42501), and the code must be looked up on another tenant's row, which aws_select_tenants
--    (aws_can_access_tenant) hides from them.
-- 2) The referrer cannot see who used its code (the same tenants policy hides the referred
--    tenants) and the referred tenant cannot see whose code it used.
-- 3) The monthly maintenance charge (aws/functions/api/tenant-billing-engine.mjs) subtracts only
--    tenants.referral_discount_cents, a figure the platform owner types in by hand (SQL 96).
--    Nothing turns a redeemed code into a discount.
--
-- Owner decision (2026-10-22): a tenant whose referral code another tenant uses gets $5.00 off
-- its monthly maintenance plan for each referral, up to $25.00 off a month. The referrer sees the
-- count and the amount; the tenant that used the code sees whose code it used.
--
-- What this file does (new functions only, all SECURITY DEFINER, search_path = public, owned by
-- the applying login like the other aws/workflows/sql DEFINER functions):
-- a) public.aws_tenant_referral_active_count(_tenant_id uuid) RETURNS integer (STABLE). The
--    number of distinct tenants that used _tenant_id's code: referral_events rows with
--    referrer_tenant_id = _tenant_id and status 'active', plus Supabase-era referrals recorded
--    only in tenants.referred_by_tenant_id (a referred tenant with any referral_events row is
--    counted by that row alone, so marking the event anything but 'active' removes it).
--    _tenant_id itself never counts. EXECUTE: the owner only (an internal helper of b, d, e).
-- b) public.aws_tenant_referral_credit_cents(_tenant_id uuid) RETURNS integer (STABLE):
--    least(2500, 500 * a). Refused (42501 not_authorized) for an identity that cannot access
--    the tenant (aws_can_access_tenant); a session with no app identity (the billing scheduler)
--    may read it. EXECUTE: checksops only. The billing engine takes
--    greatest(tenants.referral_discount_cents, this) as the maintenance discount, so the owner's
--    hand-set figure is never lowered and a referral credit never counts twice.
-- c) public.aws_apply_referral_code(_tenant_id uuid, _code text) RETURNS jsonb (VOLATILE). The
--    caller (auth.uid()) must hold tenant_users role owner or admin in _tenant_id, else
--    {"success":false,"error":"not_authorized"}. The code is trimmed and upper-cased and must be
--    3 to 40 of A-Z 0-9 _ -, else invalid_code. The redeeming tenant row is locked FOR UPDATE so
--    two redeems of one tenant serialise; a tenant already referred (referred_by_tenant_id set
--    or any referral_events row naming it as referred) gets already_redeemed. The referrer is the
--    one non-system tenant (tenants.is_system_tenant, when that column exists, not true) whose
--    trimmed, upper-cased referral_code equals the code (none, or more than one: invalid_code;
--    the redeeming tenant itself: own_code; a tenant that _tenant_id referred: mutual_referral).
--    It inserts one referral_events row (referrer, referred, referred_user_id = auth.uid(),
--    referral_code_used, discount_applied_cents 500, status 'active') and returns
--    {success, referral_event_id, referrer_tenant_id, referrer_name, message}. It does not change
--    any tenants row (referred_by_tenant_id, referral_discount_cents stay as they are).
-- d) public.aws_tenant_referral_summary(_tenant_id uuid) RETURNS jsonb (STABLE): for an identity
--    that can access the tenant (42501 otherwise): its code, the per-referral and monthly cap
--    amounts, active_referrals, earned_credit_cents (b), manual_discount_cents
--    (tenants.referral_discount_cents), applied_discount_cents (the greater of the two, at most
--    monthly_rate_cents), monthly_rate_cents, referred_by {tenant_id, name, code, applied_at} or
--    null, and the referrals it made [{name, applied_at, status}] (names and dates only).
-- e) public.aws_platform_owner_referral_overview() RETURNS jsonb (STABLE): the platform owner
--    only (42501 otherwise): one row per non-system tenant with the same figures plus who
--    referred it, for Tenant Management > Referral Dashboard.
--
-- Not changed: no table, column, policy, RLS flag or grant on a table; no existing function.
-- No tenants row and no referral_events row is changed; c only inserts referral_events rows.
--
-- Refuses to run (55000 sql111_prerequisite_missing) without public.tenants,
-- public.referral_events, public.tenant_users, the columns the functions use, auth.uid(),
-- public.aws_is_authenticated(), public.aws_can_access_tenant(uuid), public.is_platform_owner()
-- and role checksops, and (55000 sql111_definer_cannot_write) unless the applying login owns
-- public.referral_events and public.tenants without FORCE ROW LEVEL SECURITY (or is a superuser
-- or BYPASSRLS).
--
-- Transactions: no BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: every function is CREATE OR REPLACE.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect,
-- staging first.

DO $sql111_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.tenants', to_regclass('public.tenants')::oid),
      ('public.referral_events', to_regclass('public.referral_events')::oid),
      ('public.tenant_users', to_regclass('public.tenant_users')::oid),
      ('auth.uid()', to_regprocedure('auth.uid()')::oid),
      ('public.aws_is_authenticated()', to_regprocedure('public.aws_is_authenticated()')::oid),
      ('public.aws_can_access_tenant(uuid)', to_regprocedure('public.aws_can_access_tenant(uuid)')::oid),
      ('public.is_platform_owner()', to_regprocedure('public.is_platform_owner()')::oid),
      ('role checksops', (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('tenants', 'id'), ('tenants', 'name'), ('tenants', 'slug'), ('tenants', 'created_at'),
        ('tenants', 'referral_code'), ('tenants', 'referred_by_tenant_id'),
        ('tenants', 'referral_discount_cents'), ('tenants', 'monthly_rate_cents'),
        ('referral_events', 'id'), ('referral_events', 'referrer_tenant_id'),
        ('referral_events', 'referred_tenant_id'), ('referral_events', 'referred_user_id'),
        ('referral_events', 'referral_code_used'), ('referral_events', 'discount_applied_cents'),
        ('referral_events', 'status'), ('referral_events', 'created_at'),
        ('tenant_users', 'tenant_id'), ('tenant_users', 'user_id'), ('tenant_users', 'role')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql111_prerequisite_missing: SQL 111 needs the tenants, referral_events and tenant_users tables and the AWS identity helpers; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN ('public.referral_events'::regclass, 'public.tenants'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql111_definer_cannot_write: the applying login must own public.referral_events and public.tenants (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql111_prereq$;

-- a) How many tenants used a tenant's code (internal helper).
CREATE OR REPLACE FUNCTION public.aws_tenant_referral_active_count(_tenant_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(DISTINCT r.referred_tenant_id)::integer
  FROM (
    SELECT e.referred_tenant_id
      FROM public.referral_events e
     WHERE e.referrer_tenant_id = _tenant_id
       AND e.status = 'active'
    UNION
    SELECT t.id
      FROM public.tenants t
     WHERE t.referred_by_tenant_id = _tenant_id
       AND NOT EXISTS (SELECT 1 FROM public.referral_events e2 WHERE e2.referred_tenant_id = t.id)
  ) AS r(referred_tenant_id)
  WHERE r.referred_tenant_id IS NOT NULL
    AND r.referred_tenant_id <> _tenant_id;
$$;

REVOKE ALL ON FUNCTION public.aws_tenant_referral_active_count(uuid) FROM PUBLIC;
COMMENT ON FUNCTION public.aws_tenant_referral_active_count(uuid) IS
  'SQL 111: distinct tenants that used this tenant''s referral code (active referral_events, plus Supabase-era referred_by_tenant_id rows with no event). Owner only.';

-- b) The maintenance plan credit the referrals earn: $5.00 each, at most $25.00 a month.
CREATE OR REPLACE FUNCTION public.aws_tenant_referral_credit_cents(_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(public.aws_is_authenticated(), false)
     AND NOT COALESCE(public.aws_can_access_tenant(_tenant_id), false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN least(2500, 500 * public.aws_tenant_referral_active_count(_tenant_id));
END
$$;

REVOKE ALL ON FUNCTION public.aws_tenant_referral_credit_cents(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_tenant_referral_credit_cents(uuid) TO checksops;
COMMENT ON FUNCTION public.aws_tenant_referral_credit_cents(uuid) IS
  'SQL 111: the monthly maintenance plan credit from referrals, least(2500, 500 * referrals) cents. checksops only.';

-- c) Redeem another tenant's referral code.
CREATE OR REPLACE FUNCTION public.aws_apply_referral_code(_tenant_id uuid, _code text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_code text := upper(btrim(COALESCE(_code, '')));
  v_me public.tenants%ROWTYPE;
  v_ref_id uuid;
  v_ref_name text;
  v_event_id uuid;
  v_found integer;
BEGIN
  IF v_uid IS NULL OR NOT COALESCE(public.aws_is_authenticated(), false) OR _tenant_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.tenant_users tu
        WHERE tu.tenant_id = _tenant_id AND tu.user_id = v_uid
          AND lower(tu.role::text) IN ('owner', 'admin')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized',
      'message', 'Only an owner or admin of your company can redeem a referral code.');
  END IF;
  IF v_code !~ '^[A-Z0-9_-]{3,40}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_code',
      'message', 'That referral code was not found.');
  END IF;

  SELECT * INTO v_me FROM public.tenants WHERE id = _tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'tenant_not_found',
      'message', 'Your company was not found.');
  END IF;
  IF v_me.referred_by_tenant_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.referral_events e WHERE e.referred_tenant_id = _tenant_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_redeemed',
      'message', 'Your company has already used a referral code.');
  END IF;

  SELECT count(*)::integer, min(t.id::text)::uuid INTO v_found, v_ref_id
    FROM public.tenants t
   WHERE t.referral_code IS NOT NULL
     AND upper(btrim(t.referral_code)) = v_code
     AND NOT COALESCE((to_jsonb(t) ->> 'is_system_tenant')::boolean, false);
  IF v_found <> 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_code',
      'message', 'That referral code was not found.');
  END IF;
  IF v_ref_id = _tenant_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'own_code',
      'message', 'You cannot use your own referral code.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.referral_events e
              WHERE e.referrer_tenant_id = _tenant_id AND e.referred_tenant_id = v_ref_id)
     OR EXISTS (SELECT 1 FROM public.tenants t
                 WHERE t.id = v_ref_id AND t.referred_by_tenant_id = _tenant_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'mutual_referral',
      'message', 'That company joined with your referral code, so you cannot use theirs.');
  END IF;

  SELECT t.name INTO v_ref_name FROM public.tenants t WHERE t.id = v_ref_id;

  INSERT INTO public.referral_events (
    referrer_tenant_id, referred_tenant_id, referred_user_id, referral_code_used,
    discount_applied_cents, status
  ) VALUES (
    v_ref_id, _tenant_id, v_uid, v_code, 500, 'active'
  )
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'referral_event_id', v_event_id,
    'referrer_tenant_id', v_ref_id,
    'referrer_name', v_ref_name,
    'message', 'Referral code applied. You used ' || COALESCE(v_ref_name, 'another company') || '''s referral code.'
  );
END
$$;

REVOKE ALL ON FUNCTION public.aws_apply_referral_code(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_apply_referral_code(uuid, text) TO checksops;
COMMENT ON FUNCTION public.aws_apply_referral_code(uuid, text) IS
  'SQL 111: a tenant owner or admin redeems another tenant''s referral code: one active referral_events row. No tenants row changes. checksops only.';

-- d) What a tenant sees on Refer & Earn.
CREATE OR REPLACE FUNCTION public.aws_tenant_referral_summary(_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.tenants%ROWTYPE;
  v_count integer;
  v_earned integer;
  v_manual integer;
  v_rate integer;
  v_referred_by jsonb;
  v_referrals jsonb;
BEGIN
  IF NOT COALESCE(public.aws_is_authenticated(), false)
     OR NOT COALESCE(public.aws_can_access_tenant(_tenant_id), false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_me FROM public.tenants WHERE id = _tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_count := public.aws_tenant_referral_active_count(_tenant_id);
  v_earned := least(2500, 500 * v_count);
  v_manual := GREATEST(COALESCE(v_me.referral_discount_cents, 0), 0)::integer;
  v_rate := GREATEST(COALESCE(v_me.monthly_rate_cents, 0), 0)::integer;

  SELECT jsonb_build_object('tenant_id', r.id, 'name', r.name, 'code', x.code, 'applied_at', x.applied_at)
    INTO v_referred_by
    FROM (
      SELECT e.referrer_tenant_id AS ref_id, e.referral_code_used AS code, e.created_at AS applied_at
        FROM public.referral_events e
       WHERE e.referred_tenant_id = _tenant_id
       ORDER BY e.created_at DESC
       LIMIT 1
    ) AS x
    JOIN public.tenants r ON r.id = x.ref_id;
  IF v_referred_by IS NULL AND v_me.referred_by_tenant_id IS NOT NULL THEN
    SELECT jsonb_build_object('tenant_id', r.id, 'name', r.name, 'code', r.referral_code, 'applied_at', NULL)
      INTO v_referred_by
      FROM public.tenants r WHERE r.id = v_me.referred_by_tenant_id;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', x.name, 'applied_at', x.applied_at, 'status', x.status)
                            ORDER BY x.applied_at DESC NULLS LAST), '[]'::jsonb)
    INTO v_referrals
    FROM (
      SELECT t.name, e.created_at AS applied_at, e.status
        FROM public.referral_events e
        JOIN public.tenants t ON t.id = e.referred_tenant_id
       WHERE e.referrer_tenant_id = _tenant_id
      UNION ALL
      SELECT t.name, t.created_at, 'active'
        FROM public.tenants t
       WHERE t.referred_by_tenant_id = _tenant_id
         AND t.id <> _tenant_id
         AND NOT EXISTS (SELECT 1 FROM public.referral_events e2 WHERE e2.referred_tenant_id = t.id)
    ) AS x;

  RETURN jsonb_build_object(
    'tenant_id', _tenant_id,
    'referral_code', v_me.referral_code,
    'per_referral_cents', 500,
    'monthly_cap_cents', 2500,
    'active_referrals', v_count,
    'earned_credit_cents', v_earned,
    'manual_discount_cents', v_manual,
    'applied_discount_cents', least(GREATEST(v_earned, v_manual), v_rate),
    'monthly_rate_cents', v_rate,
    'referred_by', v_referred_by,
    'referrals', v_referrals
  );
END
$$;

REVOKE ALL ON FUNCTION public.aws_tenant_referral_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_tenant_referral_summary(uuid) TO checksops;
COMMENT ON FUNCTION public.aws_tenant_referral_summary(uuid) IS
  'SQL 111: a tenant''s referral code, the referrals it made (names and dates), the maintenance credit they earn and whose code it used. checksops only.';

-- e) The platform owner's Referral Dashboard.
CREATE OR REPLACE FUNCTION public.aws_platform_owner_referral_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT COALESCE(public.aws_is_authenticated(), false)
     OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(row_json ORDER BY created_at DESC NULLS LAST), '[]'::jsonb)
    FROM (
      SELECT t.created_at,
             jsonb_build_object(
               'tenant_id', t.id,
               'name', t.name,
               'slug', t.slug,
               'referral_code', t.referral_code,
               'created_at', t.created_at,
               'is_founding_partner', COALESCE((to_jsonb(t) ->> 'is_founding_partner')::boolean, false),
               'monthly_rate_cents', GREATEST(COALESCE(t.monthly_rate_cents, 0), 0),
               'manual_discount_cents', GREATEST(COALESCE(t.referral_discount_cents, 0), 0),
               'active_referrals', c.n,
               'earned_credit_cents', least(2500, 500 * c.n),
               'applied_discount_cents', least(GREATEST(least(2500, 500 * c.n), GREATEST(COALESCE(t.referral_discount_cents, 0), 0)),
                                               GREATEST(COALESCE(t.monthly_rate_cents, 0), 0)),
               'referred_by', (
                 SELECT jsonb_build_object('tenant_id', r.id, 'name', r.name, 'code', COALESCE(e.referral_code_used, r.referral_code))
                   FROM public.tenants r
                   LEFT JOIN LATERAL (
                     SELECT e1.referral_code_used FROM public.referral_events e1
                      WHERE e1.referred_tenant_id = t.id AND e1.referrer_tenant_id = r.id
                      ORDER BY e1.created_at DESC LIMIT 1
                   ) e ON true
                  WHERE r.id = COALESCE(
                    (SELECT e2.referrer_tenant_id FROM public.referral_events e2
                      WHERE e2.referred_tenant_id = t.id ORDER BY e2.created_at DESC LIMIT 1),
                    t.referred_by_tenant_id)
               )
             ) AS row_json
        FROM public.tenants t
        CROSS JOIN LATERAL (SELECT public.aws_tenant_referral_active_count(t.id) AS n) AS c
       WHERE NOT COALESCE((to_jsonb(t) ->> 'is_system_tenant')::boolean, false)
    ) AS rows
  );
END
$$;

REVOKE ALL ON FUNCTION public.aws_platform_owner_referral_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_referral_overview() TO checksops;
COMMENT ON FUNCTION public.aws_platform_owner_referral_overview() IS
  'SQL 111: the platform owner''s referral dashboard: every non-system tenant''s code, referrals, earned credit, hand-set discount and who referred it. checksops only.';
