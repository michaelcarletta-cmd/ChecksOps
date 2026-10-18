-- SQL 102: the platform owner edits a tenant's profile and removes members.
--
-- Owner decision (2026-10-18): the platform owner, as the tenant manager, edits
-- every tenant field on Admin -> Tenants except the slug and the partner code,
-- which are permanent; and removes a member from a tenant. Until now SQL 90's
-- aws_write_tenants (members only) and the SQL 93/96/98 column guard refused
-- those writes, so the Active switch, the Company tab, the KYC status select,
-- the Test Account switch, the notes dialog and the member Remove button failed
-- (column_not_allowlisted / "Only a member of this company ...").
--
-- What this file does:
-- 1) public.aws_platform_owner_set_tenant_profile(uuid, jsonb) (new, SECURITY
--    DEFINER): the platform owner's write path for the profile fields
--      name, custom_domain, subscription_status, max_checks_per_month,
--      is_test_account (moov_environment follows: sandbox / production),
--      kyc_status, kyc_notes, internal_notes.
--    It refuses anyone else (42501 not_authorized), slug and partner_code
--    (22023 field_not_editable), any other key (22023 invalid_field), a
--    column this database does not have (22023 column_not_present), a bad
--    value (22023 invalid_value), a test-mode change once the tenant has a
--    Moov payment account (55000 moov_environment_locked) and a missing
--    tenant (P0002 tenant_not_found). Returns the saved profile.
-- 2) public.aws_platform_owner_remove_tenant_member(uuid, uuid) (new, SECURITY
--    DEFINER): the platform owner removes a user's membership of a tenant
--    (P0002 membership_not_found when there is none). The user's account is
--    not touched.
-- 3) public.aws_tenant_profile_audit_row() + trigger aws_tenant_profile_audit
--    (AFTER UPDATE on tenants): one tenant_pricing_audit row per changed
--    profile field, by any path. A member removal is audited by the remover
--    (field member_removed).
-- 4) public.aws_tenants_member_column_guard() (SQL 98's, replaced here): the
--    same body, plus the profile fields and moov_environment for the platform
--    owner. Members still change only SQL 93's display/branding/company-info
--    columns; slug and partner_code stay refused for everyone. Re-running SQL
--    98 after this file would put back SQL 98's guard (fail closed: the
--    platform owner could no longer save the profile) until SQL 102 is re-run.
--
-- Refuses to run (55000 sql102_prerequisite_missing) without SQL 98 (and so
-- SQL 96 and SQL 93). Idempotent. No BEGIN/COMMIT: the guarded SQL executor
-- runs it in one transaction. No data changes. Not applied by this change.
--
-- Writers: aws/functions/api/tenant-billing-handlers.mjs (tenant-billing-admin
-- actions profile-update and member-remove, platform owner only).

DO $sql102_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.aws_platform_owner_set_tenant_deposits_enabled(uuid, boolean) (SQL 98)', to_regprocedure('public.aws_platform_owner_set_tenant_deposits_enabled(uuid, boolean)')::oid),
      ('public.aws_tenant_pricing_columns() (SQL 96)', to_regprocedure('public.aws_tenant_pricing_columns()')::oid),
      ('public.aws_tenants_member_column_guard() (SQL 93)', to_regprocedure('public.aws_tenants_member_column_guard()')::oid),
      ('public.is_platform_owner()', to_regprocedure('public.is_platform_owner()')::oid),
      ('public.aws_is_authenticated()', to_regprocedure('public.aws_is_authenticated()')::oid),
      ('public.aws_is_tenant_member(uuid)', to_regprocedure('public.aws_is_tenant_member(uuid)')::oid),
      ('auth.uid()', to_regprocedure('auth.uid()')::oid),
      ('public.tenants', to_regclass('public.tenants')::oid),
      ('public.tenant_users', to_regclass('public.tenant_users')::oid),
      ('public.tenant_pricing_audit (SQL 96)', to_regclass('public.tenant_pricing_audit')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops')),
      ('role authenticated', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'authenticated'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('tenants', 'id'), ('tenant_users', 'tenant_id'), ('tenant_users', 'user_id')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql102_prerequisite_missing: SQL 102 needs SQL 98 applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$sql102_prereq$;

-- The profile fields the platform owner sets (moov_environment follows
-- is_test_account and is never a key of its own).
CREATE OR REPLACE FUNCTION public.aws_tenant_profile_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY[
    'name', 'custom_domain', 'subscription_status', 'max_checks_per_month',
    'is_test_account', 'kyc_status', 'kyc_notes', 'internal_notes'
  ]::text[];
$$;
REVOKE ALL ON FUNCTION public.aws_tenant_profile_columns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_tenant_profile_columns() TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_tenant_profile_columns() IS
  'SQL 102: the tenant profile fields the platform owner sets through aws_platform_owner_set_tenant_profile (slug and partner_code are permanent).';

CREATE OR REPLACE FUNCTION public.aws_platform_owner_set_tenant_profile(
  _tenant_id uuid,
  _profile jsonb
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
  v_text text;
  v_values jsonb := '{}'::jsonb;
  v_sets text[] := ARRAY[]::text[];
  v_row jsonb;
  v_out jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF _tenant_id IS NULL OR _profile IS NULL OR jsonb_typeof(_profile) <> 'object' OR _profile = '{}'::jsonb THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  SELECT to_jsonb(t) INTO v_row FROM public.tenants t WHERE t.id = _tenant_id FOR UPDATE;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;

  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(_profile) LOOP
    IF v_key IN ('slug', 'partner_code') THEN
      RAISE EXCEPTION 'field_not_editable' USING ERRCODE = '22023', DETAIL = v_key;
    END IF;
    IF NOT (v_key = ANY (public.aws_tenant_profile_columns())) THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = v_key;
    END IF;
    IF NOT (v_row ? v_key) THEN
      RAISE EXCEPTION 'column_not_present' USING ERRCODE = '22023', DETAIL = v_key;
    END IF;

    IF v_key = 'name' THEN
      v_text := btrim(COALESCE(v_value #>> '{}', ''));
      IF jsonb_typeof(v_value) <> 'string' OR v_text = '' OR length(v_text) > 200 THEN
        RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = v_key;
      END IF;
      v_value := to_jsonb(v_text);
    ELSIF v_key = 'custom_domain' THEN
      IF jsonb_typeof(v_value) = 'null' OR btrim(COALESCE(v_value #>> '{}', '')) = '' THEN
        v_value := 'null'::jsonb;
      ELSE
        v_text := lower(btrim(v_value #>> '{}'));
        IF jsonb_typeof(v_value) <> 'string' OR length(v_text) > 253
           OR v_text !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' THEN
          RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = v_key;
        END IF;
        v_value := to_jsonb(v_text);
      END IF;
    ELSIF v_key = 'subscription_status' THEN
      IF jsonb_typeof(v_value) <> 'string'
         OR NOT ((v_value #>> '{}') = ANY (ARRAY['active', 'trialing', 'past_due', 'inactive', 'cancelled'])) THEN
        RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = v_key;
      END IF;
    ELSIF v_key = 'kyc_status' THEN
      IF jsonb_typeof(v_value) <> 'string'
         OR NOT ((v_value #>> '{}') = ANY (ARRAY['pending', 'approved', 'rejected'])) THEN
        RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = v_key;
      END IF;
    ELSIF v_key = 'max_checks_per_month' THEN
      IF jsonb_typeof(v_value) <> 'number' OR (v_value #>> '{}')::numeric < 0
         OR (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric)
         OR (v_value #>> '{}')::numeric > 2147483647 THEN
        RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = v_key;
      END IF;
    ELSIF v_key = 'is_test_account' THEN
      IF jsonb_typeof(v_value) <> 'boolean' THEN
        RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = v_key;
      END IF;
      -- Only a real change of test mode moves the ledger (moov_environment follows).
      IF (v_value)::text::boolean IS DISTINCT FROM COALESCE((v_row ->> 'is_test_account')::boolean, false) THEN
        -- Moving a tenant that already has a Moov account to the other ledger
        -- would strand that account: refused. Nested IFs: one IF condition is planned
        -- as a whole, so an AND would still name the table where it does not exist.
        IF to_regclass('public.payment_provider_accounts') IS NOT NULL THEN
          IF EXISTS (SELECT 1 FROM public.payment_provider_accounts a
                      WHERE a.tenant_id = _tenant_id AND a.provider = 'moov') THEN
            RAISE EXCEPTION 'moov_environment_locked' USING ERRCODE = '55000', DETAIL = v_key;
          END IF;
        END IF;
        IF v_row ? 'moov_environment' THEN
          v_values := v_values || jsonb_build_object('moov_environment',
            CASE WHEN (v_value)::text::boolean THEN 'sandbox' ELSE 'production' END);
          v_sets := v_sets || format('%1$I = (jsonb_populate_record(NULL::public.tenants, $1)).%1$I', 'moov_environment');
        END IF;
      END IF;
    ELSE
      -- kyc_notes, internal_notes
      IF jsonb_typeof(v_value) NOT IN ('string', 'null') OR length(COALESCE(v_value #>> '{}', '')) > 10000 THEN
        RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = v_key;
      END IF;
    END IF;

    v_values := v_values || jsonb_build_object(v_key, v_value);
    v_sets := v_sets || format('%1$I = (jsonb_populate_record(NULL::public.tenants, $1)).%1$I', v_key);
  END LOOP;

  BEGIN
    EXECUTE format('UPDATE public.tenants SET %s WHERE id = $2', array_to_string(v_sets, ', '))
      USING v_values, _tenant_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'value_in_use' USING ERRCODE = '23505', DETAIL = 'custom_domain';
    WHEN check_violation OR invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = 'check';
  END;

  SELECT to_jsonb(t) INTO v_row FROM public.tenants t WHERE t.id = _tenant_id;
  FOR v_key IN SELECT unnest(ARRAY['id', 'name', 'slug', 'partner_code', 'moov_environment']
                             || public.aws_tenant_profile_columns()) LOOP
    IF v_row ? v_key THEN
      v_out := v_out || jsonb_build_object(v_key, v_row -> v_key);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'tenant_id', _tenant_id, 'tenant', v_out);
END
$body$;
REVOKE ALL ON FUNCTION public.aws_platform_owner_set_tenant_profile(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_set_tenant_profile(uuid, jsonb) TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_platform_owner_set_tenant_profile(uuid, jsonb) IS
  'SQL 102: the platform owner sets a tenant''s profile fields (aws_tenant_profile_columns(); slug and partner_code are permanent). Everyone else is refused (42501). Audited in tenant_pricing_audit.';

CREATE OR REPLACE FUNCTION public.aws_platform_owner_remove_tenant_member(
  _tenant_id uuid,
  _user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $body$
DECLARE
  v_removed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF _tenant_id IS NULL OR _user_id IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.tenant_users WHERE tenant_id = _tenant_id AND user_id = _user_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  IF v_removed = 0 THEN
    RAISE EXCEPTION 'membership_not_found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.tenant_pricing_audit (tenant_id, actor_id, field, old_value, new_value)
  VALUES (_tenant_id, auth.uid(), 'member_removed', to_jsonb(_user_id), NULL);
  RETURN jsonb_build_object('ok', true, 'tenant_id', _tenant_id, 'user_id', _user_id, 'removed', v_removed);
END
$body$;
REVOKE ALL ON FUNCTION public.aws_platform_owner_remove_tenant_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_remove_tenant_member(uuid, uuid) TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_platform_owner_remove_tenant_member(uuid, uuid) IS
  'SQL 102: the platform owner removes a user''s membership of a tenant (the account is kept). Everyone else is refused (42501). Audited in tenant_pricing_audit (field member_removed).';

-- Every change of a profile field, by any path, is audited (who, tenant, old -> new).
CREATE OR REPLACE FUNCTION public.aws_tenant_profile_audit_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_key text;
BEGIN
  FOR v_key IN SELECT unnest(public.aws_tenant_profile_columns() || ARRAY['moov_environment']) LOOP
    IF v_new ? v_key AND (v_new -> v_key) IS DISTINCT FROM (v_old -> v_key) THEN
      INSERT INTO public.tenant_pricing_audit (tenant_id, actor_id, field, old_value, new_value)
      VALUES (NEW.id, auth.uid(), v_key, v_old -> v_key, v_new -> v_key);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_tenant_profile_audit_row() FROM PUBLIC;

DROP TRIGGER IF EXISTS aws_tenant_profile_audit ON public.tenants;
CREATE TRIGGER aws_tenant_profile_audit
  AFTER UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_tenant_profile_audit_row();

-- Column guard (SQL 98's, replaced here): SQL 98's body unchanged except that
-- the platform owner may also change the profile fields and moov_environment.
-- Members still change only SQL 93's display/branding/company-info columns;
-- slug and partner_code are in no list, so nobody changes them.
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
    v_allowed := v_allowed || public.aws_tenant_pricing_columns() || ARRAY['deposits_enabled']
      || public.aws_tenant_profile_columns() || ARRAY['moov_environment'];
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
  'SQL 102 (replaces SQL 98): members change only display/branding/company-info columns; the platform owner only pricing columns, deposits_enabled, the profile fields (aws_tenant_profile_columns()) and moov_environment; everything else, slug and partner_code included, is refused (42501).';
