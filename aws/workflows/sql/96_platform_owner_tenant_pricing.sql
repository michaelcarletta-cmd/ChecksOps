-- SQL 96: the platform owner sets what ChecksOps charges each tenant; members never do.
--
-- Owner decision (2026-10-17): the platform owner (public.is_platform_owner(),
-- by email), from Tenant Management, sets every per-tenant price: the monthly
-- rate and referral discount, the founding-partner price flag, per-check
-- billing and its rate, the next-day / same-day deposit rates and the
-- MortgageOps initial / additional rates. Tenant members may read their own
-- rates but never change them.
--
-- Pricing columns on public.tenants (aws_tenant_pricing_columns()):
--   monthly_rate_cents, referral_discount_cents, is_founding_partner,
--   per_check_billing_enabled, per_check_rate_cents, next_day_rate_cents,
--   same_day_rate_cents, mortgage_ops_initial_rate_cents,
--   mortgage_ops_additional_rate_cents
-- (a column that does not exist in this database is refused by the setter,
-- never created here).
--
-- What this file does:
-- 1) public.tenant_pricing_audit (new, append-only): one row per changed
--    pricing column (who, tenant, field, old -> new), written by an AFTER
--    UPDATE trigger on tenants (aws_tenant_pricing_audit_row) for every path,
--    the setter below included. Readable by the platform owner only; no role
--    may INSERT, UPDATE or DELETE it directly.
-- 2) public.aws_platform_owner_set_tenant_pricing(uuid, jsonb) (new,
--    SECURITY DEFINER): the platform owner's only tenants write path. It
--    refuses anyone else (42501), unknown or non-pricing keys (22023
--    invalid_field / column_not_present), negative or fractional amounts and
--    non-boolean flags (22023 invalid_value), and a missing tenant (P0002).
--    SQL 90's aws_write_tenants stays the one tenants UPDATE policy (members
--    only), so a direct UPDATE by the platform owner still matches no row.
-- 3) public.aws_tenants_member_column_guard() (SQL 93's BEFORE UPDATE guard,
--    replaced here): an end-user request may change
--      - as a member of that tenant: SQL 93's display/branding/company-info
--        columns (unchanged), never a pricing column;
--      - as the platform owner: the pricing columns only (never branding,
--        slug, moov_*, payment_provider, is_test_account, kyc_*, ein, ...);
--      - plus updated_at. Anything else is refused with 42501
--        tenant_column_not_member_writable.
--    Re-running SQL 93 after this file would put back SQL 93's member-only
--    guard (fail closed: the platform owner could no longer set prices) until
--    SQL 96 is re-run.
-- 4) public.platform_fee_schedules (when present): write policy becomes the
--    platform owner only; members keep the existing SELECT
--    (aws_select_platform_fee_schedules, 12_final_select_policies.sql).
--
-- Refuses to run (55000 sql96_prerequisite_missing) without SQL 90 and SQL 93.
-- Idempotent. No BEGIN/COMMIT: the guarded SQL executor runs it in one
-- transaction. No data changes. Not applied by this change.
--
-- Writers: aws/functions/api/tenant-billing-engine.mjs (saveBillingSettings,
-- through tenant-billing-admin, platform owner only).

DO $sql96_prereq$
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('public.is_platform_owner()') IS NULL
     OR to_regprocedure('public.aws_is_authenticated()') IS NULL
     OR to_regprocedure('public.aws_is_tenant_member(uuid)') IS NULL
     OR to_regprocedure('public.aws_tenants_member_column_guard()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.tenants'::regclass
          AND tgname = 'aws_tenants_member_column_guard' AND NOT tgisinternal)
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'tenants'
          AND policyname = 'aws_write_tenants' AND cmd = 'UPDATE')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'checksops')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
  THEN
    RAISE EXCEPTION 'sql96_prerequisite_missing: apply SQL 90 and SQL 93 first'
      USING ERRCODE = '55000';
  END IF;
END
$sql96_prereq$;

-- The one list of per-tenant pricing columns.
CREATE OR REPLACE FUNCTION public.aws_tenant_pricing_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY[
    'monthly_rate_cents', 'referral_discount_cents', 'is_founding_partner',
    'per_check_billing_enabled', 'per_check_rate_cents',
    'next_day_rate_cents', 'same_day_rate_cents',
    'mortgage_ops_initial_rate_cents', 'mortgage_ops_additional_rate_cents'
  ]::text[];
$$;
REVOKE ALL ON FUNCTION public.aws_tenant_pricing_columns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_tenant_pricing_columns() TO checksops, authenticated;

-- 1) audit ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_pricing_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  actor_id uuid,
  field text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_pricing_audit_tenant_idx
  ON public.tenant_pricing_audit (tenant_id, created_at DESC);
COMMENT ON TABLE public.tenant_pricing_audit IS
  'SQL 96: append-only audit of per-tenant pricing changes (who, tenant, field, old -> new). Written only by aws_tenant_pricing_audit_row.';

ALTER TABLE public.tenant_pricing_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_pricing_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_pricing_audit FROM authenticated;
REVOKE ALL ON TABLE public.tenant_pricing_audit FROM checksops;
GRANT SELECT ON TABLE public.tenant_pricing_audit TO checksops, authenticated;
DROP POLICY IF EXISTS aws_select_tenant_pricing_audit ON public.tenant_pricing_audit;
CREATE POLICY aws_select_tenant_pricing_audit ON public.tenant_pricing_audit
  FOR SELECT TO authenticated
  USING (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false));

CREATE OR REPLACE FUNCTION public.aws_tenant_pricing_audit_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_actor uuid := auth.uid();
BEGIN
  INSERT INTO public.tenant_pricing_audit (tenant_id, actor_id, field, old_value, new_value)
  SELECT NEW.id, v_actor, c.col, v_old -> c.col, v_new -> c.col
    FROM unnest(public.aws_tenant_pricing_columns()) AS c(col)
   WHERE v_new ? c.col
     AND (v_new -> c.col) IS DISTINCT FROM (v_old -> c.col);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_tenant_pricing_audit_row() FROM PUBLIC;

DROP TRIGGER IF EXISTS aws_tenant_pricing_audit ON public.tenants;
CREATE TRIGGER aws_tenant_pricing_audit
  AFTER UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_tenant_pricing_audit_row();

-- 3) column guard (replaces SQL 93's) ----------------------------------------
CREATE OR REPLACE FUNCTION public.aws_tenants_member_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_member_columns CONSTANT text[] := ARRAY[
    'name', 'logo_url', 'primary_color', 'secondary_color',
    'invoice_letterhead_url', 'invoice_footer_note', 'invoice_default_terms',
    'invoice_accent_color', 'invoice_theme',
    'company_address', 'company_phone', 'company_email', 'letterhead_url'
  ];
  v_allowed text[] := ARRAY['updated_at'];
  v_old jsonb := to_jsonb(OLD);
  v_changed text[];
BEGIN
  -- Only end-user requests are limited; RLS already refuses requests with no caller.
  IF NOT COALESCE(public.aws_is_authenticated(), false) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(public.aws_is_tenant_member(OLD.id), false) THEN
    v_allowed := v_allowed || v_member_columns;
  END IF;
  IF COALESCE(public.is_platform_owner(), false) THEN
    v_allowed := v_allowed || public.aws_tenant_pricing_columns();
  END IF;
  SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) AS n
   WHERE NOT (n.key = ANY (v_allowed))
     AND n.value IS DISTINCT FROM (v_old -> n.key);
  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_column_not_member_writable: %', array_to_string(v_changed, ', ')
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.aws_tenants_member_column_guard() IS
  'SQL 96 (replaces SQL 93): members change only display/branding/company-info columns; the platform owner only pricing columns (aws_tenant_pricing_columns()); everything else is refused (42501).';

-- 2) the platform owner's pricing setter --------------------------------------
CREATE OR REPLACE FUNCTION public.aws_platform_owner_set_tenant_pricing(
  _tenant_id uuid,
  _pricing jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $body$
DECLARE
  v_key text;
  v_value jsonb;
  v_flags CONSTANT text[] := ARRAY['is_founding_partner', 'per_check_billing_enabled'];
  v_sets text[] := ARRAY[]::text[];
  v_keys text[] := ARRAY[]::text[];
  v_row jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF _tenant_id IS NULL OR _pricing IS NULL OR jsonb_typeof(_pricing) <> 'object' OR _pricing = '{}'::jsonb THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = _tenant_id) THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;

  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(_pricing) ORDER BY key
  LOOP
    IF NOT (v_key = ANY (public.aws_tenant_pricing_columns())) THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = v_key;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = v_key
    ) THEN
      RAISE EXCEPTION 'column_not_present' USING ERRCODE = '22023', DETAIL = v_key;
    END IF;
    IF v_key = ANY (v_flags) THEN
      IF jsonb_typeof(v_value) <> 'boolean' THEN
        RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = v_key;
      END IF;
    ELSIF jsonb_typeof(v_value) <> 'null' THEN
      IF jsonb_typeof(v_value) <> 'number'
         OR (v_value #>> '{}')::numeric < 0
         OR (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric)
         OR (v_value #>> '{}')::numeric > 1000000000 THEN
        RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = v_key;
      END IF;
    END IF;
    v_sets := v_sets || format('%1$I = (jsonb_populate_record(NULL::public.tenants, $1)).%1$I', v_key);
    v_keys := v_keys || v_key;
  END LOOP;

  EXECUTE format('UPDATE public.tenants SET %s WHERE id = $2', array_to_string(v_sets, ', '))
    USING _pricing, _tenant_id;

  SELECT jsonb_object_agg(c.col, t.j -> c.col) INTO v_row
    FROM (SELECT to_jsonb(x) AS j FROM public.tenants x WHERE x.id = _tenant_id) AS t,
         unnest(public.aws_tenant_pricing_columns()) AS c(col)
   WHERE t.j ? c.col;

  RETURN jsonb_build_object('ok', true, 'tenant_id', _tenant_id, 'updated', to_jsonb(v_keys), 'pricing', v_row);
END
$body$;
REVOKE ALL ON FUNCTION public.aws_platform_owner_set_tenant_pricing(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_set_tenant_pricing(uuid, jsonb) TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_platform_owner_set_tenant_pricing(uuid, jsonb) IS
  'SQL 96: the platform owner sets a tenant''s pricing columns (aws_tenant_pricing_columns()) only. Everyone else is refused (42501). Every change is audited in tenant_pricing_audit.';

-- 4) platform_fee_schedules: platform owner writes, members read --------------
DO $sql96_fees$
BEGIN
  IF to_regclass('public.platform_fee_schedules') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_write_platform_fee_schedules ON public.platform_fee_schedules';
    EXECUTE 'CREATE POLICY aws_write_platform_fee_schedules ON public.platform_fee_schedules
      FOR ALL TO authenticated
      USING (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))
      WITH CHECK (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))';
  END IF;
END
$sql96_fees$;
