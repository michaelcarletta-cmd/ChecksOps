-- SQL 117: the platform owner deactivates, reactivates or permanently deletes a tenant.
--
-- Why: Tenant Management has no working way to remove a tenant (owner, 2026-10-26). The old
-- settings screen deletes the tenants row from the browser, which the AWS data API refuses
-- (tenants allows insert and update only), and a real delete would cascade through about fifty
-- tables while the money and ledger tables that reference tenants without ON DELETE refuse it.
-- Owner decision: any tenant can be deactivated (hidden, its users lose access, every record
-- kept, reversible); a tenant with no checks and no money movement (a test tenant) can be
-- permanently deleted.
--
-- 1) public.tenant_deactivations (new): one row per deactivated tenant: when, by whom, why,
--    the subscription_status it had, and the tenant_users rows that were suspended (as jsonb,
--    so they are restored exactly). ON DELETE CASCADE from tenants. RLS on, no policy, no grant
--    to anyone: only the functions below read or write it.
-- 2) public.aws_platform_owner_deactivate_tenant(_tenant_id uuid, _reason text): moves every
--    tenant_users row of the tenant into tenant_deactivations.memberships and deletes it from
--    tenant_users, so the tenant's users lose access through the same path as a removed member
--    (aws_user_tenant_ids() reads tenant_users), and sets subscription_status 'inactive'. The
--    platform owner may change subscription_status (aws_tenants_member_column_guard, SQL 102)
--    and the profile audit trigger records the change. No table references tenant_users, so
--    removing its rows removes nothing else. A second call is a no-op that reports
--    already_deactivated. The system tenant is refused (55000 system_tenant_protected).
-- 3) public.aws_platform_owner_reactivate_tenant(_tenant_id uuid): puts the suspended rows back
--    in tenant_users (a membership added since is kept: ON CONFLICT DO NOTHING), restores the
--    exact previous subscription_status and removes the tenant_deactivations row.
-- 4) public.aws_platform_owner_tenant_activity(_tenant_id uuid): the number of rows the tenant
--    has in each table that holds checks or money (only tables present on this database), and
--    whether all are zero.
-- 5) public.aws_platform_owner_delete_empty_tenant(_tenant_id uuid, _confirm_slug text): deletes
--    the tenants row (its cascades remove the tenant's settings, memberships and other dependent
--    rows) only when _confirm_slug equals the tenant's slug, the tenant is not the system tenant
--    and aws_platform_owner_tenant_activity reports it empty (else 55000 tenant_not_empty). A
--    row in any other table that references the tenant without a cascade makes PostgreSQL refuse
--    the delete; that is reported as 55000 tenant_has_records with the constraint's name.
-- 6) public.aws_platform_owner_deactivated_tenants(): the tenant_deactivations rows (no
--    membership details), for the Tenant Management list.
--
-- Every function: SECURITY DEFINER, search_path public, row_security off, refuses anyone but
-- the platform owner (42501, as SQL 102), EXECUTE revoked from PUBLIC and granted to checksops
-- and authenticated (as SQL 102). Every change is audited in public.tenant_pricing_audit
-- (fields tenant_deactivated, tenant_reactivated, tenant_deleted); that table has no foreign key
-- to tenants, so the audit of a deleted tenant is kept.
--
-- Not changed: no existing function, policy, grant, trigger or column; aws_user_tenant_ids()
-- and every RLS policy are untouched. Partner sharing, homeowner links and the Moov account of
-- a deactivated tenant are not changed (a tenant with a Moov account is never empty, so it can
-- only be deactivated).
-- Refuses to run (55000 sql117_prerequisite_missing) without public.tenants,
-- public.tenant_users, public.tenant_pricing_audit (SQL 96), public.is_platform_owner() and
-- public.aws_tenants_member_column_guard() (SQL 102).
--
-- Caller: aws/functions/api/tenant-billing-handlers.mjs (tenant-billing-admin actions
-- tenant-deactivate, tenant-reactivate, tenant-activity, tenant-delete, tenants-deactivated),
-- in a later change.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to re-run. Not applied by this change.

DO $sql117_prereq$
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR to_regclass('public.tenant_users') IS NULL
     OR to_regclass('public.tenant_pricing_audit') IS NULL
     OR to_regprocedure('public.is_platform_owner()') IS NULL
     OR to_regprocedure('public.aws_tenants_member_column_guard()') IS NULL THEN
    RAISE EXCEPTION 'sql117_prerequisite_missing: SQL 117 needs public.tenants, public.tenant_users, public.tenant_pricing_audit (SQL 96), public.is_platform_owner() and public.aws_tenants_member_column_guard() (SQL 102)'
      USING ERRCODE = '55000';
  END IF;
END
$sql117_prereq$;

CREATE TABLE IF NOT EXISTS public.tenant_deactivations (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  deactivated_at timestamptz NOT NULL DEFAULT now(),
  deactivated_by uuid,
  reason text,
  previous_subscription_status text,
  memberships jsonb NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE public.tenant_deactivations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_deactivations FROM PUBLIC;
COMMENT ON TABLE public.tenant_deactivations IS
  'SQL 117: deactivated tenants and their suspended tenant_users rows. Written and read only by the aws_platform_owner_*_tenant functions.';

-- Tables whose rows mean the tenant has checks or money movement. Absent tables are skipped.
CREATE OR REPLACE FUNCTION public.aws_tenant_activity_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'check_intake_items', 'deposit_items', 'checkalt_deposits', 'check_billing_events',
    'payment_provider_accounts', 'payment_transfers', 'payment_wallet_ledger',
    'disbursement_batches', 'external_payment_recipients', 'moov_invoices',
    'platform_fee_occurrences', 'tenant_maintenance_payments', 'cash_job_payments',
    'homeowner_deductible_payments', 'claim_check_payments', 'wallet_funding_requests'
  ]::text[];
$$;
REVOKE ALL ON FUNCTION public.aws_tenant_activity_tables() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_tenant_activity_tables() TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_tenant_activity_tables() IS
  'SQL 117: tables whose rows (by tenant_id) mean a tenant has checks or money movement and so cannot be permanently deleted.';

CREATE OR REPLACE FUNCTION public.aws_platform_owner_tenant_activity(_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $body$
DECLARE
  v_table text;
  v_count bigint;
  v_counts jsonb := '{}'::jsonb;
  v_total bigint := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = _tenant_id) THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;
  FOREACH v_table IN ARRAY public.aws_tenant_activity_tables() LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('public.' || v_table)
            AND attname = 'tenant_id' AND NOT attisdropped
       ) THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id = $1', v_table)
        INTO v_count USING _tenant_id;
      v_counts := v_counts || jsonb_build_object(v_table, v_count);
      v_total := v_total + v_count;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('tenant_id', _tenant_id, 'counts', v_counts, 'total', v_total, 'empty', v_total = 0);
END
$body$;
REVOKE ALL ON FUNCTION public.aws_platform_owner_tenant_activity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_tenant_activity(uuid) TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_platform_owner_tenant_activity(uuid) IS
  'SQL 117: the platform owner reads how many check and money rows a tenant has (aws_tenant_activity_tables) and whether it is empty. Everyone else is refused (42501).';

CREATE OR REPLACE FUNCTION public.aws_platform_owner_deactivate_tenant(_tenant_id uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $body$
DECLARE
  v_tenant public.tenants%ROWTYPE;
  v_members jsonb;
  v_count integer;
  v_reason text := NULLIF(btrim(COALESCE(_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'invalid_value' USING ERRCODE = '22023', DETAIL = 'reason';
  END IF;
  SELECT * INTO v_tenant FROM public.tenants WHERE id = _tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_tenant.is_system_tenant, false) THEN
    RAISE EXCEPTION 'system_tenant_protected' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_deactivations WHERE tenant_id = _tenant_id) THEN
    RETURN jsonb_build_object('ok', true, 'tenant_id', _tenant_id, 'already_deactivated', true, 'suspended', 0);
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(tu) ORDER BY tu.created_at), '[]'::jsonb), count(*)
    INTO v_members, v_count
    FROM public.tenant_users tu
   WHERE tu.tenant_id = _tenant_id;
  DELETE FROM public.tenant_users WHERE tenant_id = _tenant_id;

  INSERT INTO public.tenant_deactivations (tenant_id, deactivated_by, reason, previous_subscription_status, memberships)
  VALUES (_tenant_id, auth.uid(), v_reason, v_tenant.subscription_status, v_members);

  IF v_tenant.subscription_status IS DISTINCT FROM 'inactive' THEN
    UPDATE public.tenants SET subscription_status = 'inactive' WHERE id = _tenant_id;
  END IF;

  INSERT INTO public.tenant_pricing_audit (tenant_id, actor_id, field, old_value, new_value)
  VALUES (_tenant_id, auth.uid(), 'tenant_deactivated',
          to_jsonb(v_tenant.subscription_status),
          jsonb_build_object('reason', v_reason, 'suspended_memberships', v_count));

  RETURN jsonb_build_object('ok', true, 'tenant_id', _tenant_id, 'already_deactivated', false, 'suspended', v_count);
END
$body$;
REVOKE ALL ON FUNCTION public.aws_platform_owner_deactivate_tenant(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_deactivate_tenant(uuid, text) TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_platform_owner_deactivate_tenant(uuid, text) IS
  'SQL 117: the platform owner deactivates a tenant: its tenant_users rows move to tenant_deactivations (its users lose access) and subscription_status becomes inactive. Reversible with aws_platform_owner_reactivate_tenant. Audited in tenant_pricing_audit.';

CREATE OR REPLACE FUNCTION public.aws_platform_owner_reactivate_tenant(_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $body$
DECLARE
  v_row public.tenant_deactivations%ROWTYPE;
  v_restored integer;
  v_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = _tenant_id) THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_row FROM public.tenant_deactivations WHERE tenant_id = _tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'tenant_id', _tenant_id, 'already_active', true, 'restored', 0);
  END IF;

  INSERT INTO public.tenant_users
  SELECT * FROM jsonb_populate_recordset(NULL::public.tenant_users, v_row.memberships)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  v_status := v_row.previous_subscription_status;
  UPDATE public.tenants SET subscription_status = v_status
   WHERE id = _tenant_id AND subscription_status IS DISTINCT FROM v_status;

  DELETE FROM public.tenant_deactivations WHERE tenant_id = _tenant_id;

  INSERT INTO public.tenant_pricing_audit (tenant_id, actor_id, field, old_value, new_value)
  VALUES (_tenant_id, auth.uid(), 'tenant_reactivated',
          jsonb_build_object('deactivated_at', v_row.deactivated_at, 'reason', v_row.reason),
          jsonb_build_object('subscription_status', v_status, 'restored_memberships', v_restored));

  RETURN jsonb_build_object('ok', true, 'tenant_id', _tenant_id, 'already_active', false, 'restored', v_restored);
END
$body$;
REVOKE ALL ON FUNCTION public.aws_platform_owner_reactivate_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_reactivate_tenant(uuid) TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_platform_owner_reactivate_tenant(uuid) IS
  'SQL 117: the platform owner reactivates a tenant: its suspended tenant_users rows are restored (memberships added since are kept) with its previous subscription_status. Audited in tenant_pricing_audit.';

CREATE OR REPLACE FUNCTION public.aws_platform_owner_delete_empty_tenant(_tenant_id uuid, _confirm_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $body$
DECLARE
  v_tenant public.tenants%ROWTYPE;
  v_activity jsonb;
  v_constraint text;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF _tenant_id IS NULL OR NULLIF(btrim(COALESCE(_confirm_slug, '')), '') IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_tenant FROM public.tenants WHERE id = _tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_tenant.is_system_tenant, false) THEN
    RAISE EXCEPTION 'system_tenant_protected' USING ERRCODE = '55000';
  END IF;
  IF lower(btrim(_confirm_slug)) IS DISTINCT FROM lower(v_tenant.slug) THEN
    RAISE EXCEPTION 'confirmation_mismatch' USING ERRCODE = '22023', DETAIL = 'confirm_slug';
  END IF;
  v_activity := public.aws_platform_owner_tenant_activity(_tenant_id);
  IF NOT COALESCE((v_activity ->> 'empty')::boolean, false) THEN
    RAISE EXCEPTION 'tenant_not_empty' USING ERRCODE = '55000', DETAIL = (v_activity -> 'counts')::text;
  END IF;

  INSERT INTO public.tenant_pricing_audit (tenant_id, actor_id, field, old_value, new_value)
  VALUES (_tenant_id, auth.uid(), 'tenant_deleted',
          jsonb_build_object('name', v_tenant.name, 'slug', v_tenant.slug, 'created_at', v_tenant.created_at),
          NULL);

  BEGIN
    DELETE FROM public.tenants WHERE id = _tenant_id;
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'tenant_has_records' USING ERRCODE = '55000', DETAIL = COALESCE(v_constraint, 'unknown');
  END;

  RETURN jsonb_build_object('ok', true, 'tenant_id', _tenant_id, 'deleted', true, 'slug', v_tenant.slug);
END
$body$;
REVOKE ALL ON FUNCTION public.aws_platform_owner_delete_empty_tenant(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_delete_empty_tenant(uuid, text) TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_platform_owner_delete_empty_tenant(uuid, text) IS
  'SQL 117: the platform owner permanently deletes a tenant that has no checks or money rows (aws_platform_owner_tenant_activity), confirmed by typing its slug. Refused for the system tenant and for any tenant another table still references. Audited in tenant_pricing_audit.';

CREATE OR REPLACE FUNCTION public.aws_platform_owner_deactivated_tenants()
RETURNS TABLE (
  tenant_id uuid,
  deactivated_at timestamptz,
  deactivated_by uuid,
  reason text,
  previous_subscription_status text,
  suspended_memberships integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $body$
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized: platform owner required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT d.tenant_id, d.deactivated_at, d.deactivated_by, d.reason, d.previous_subscription_status,
           jsonb_array_length(d.memberships)
      FROM public.tenant_deactivations d
     ORDER BY d.deactivated_at DESC;
END
$body$;
REVOKE ALL ON FUNCTION public.aws_platform_owner_deactivated_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_deactivated_tenants() TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_platform_owner_deactivated_tenants() IS
  'SQL 117: the platform owner lists deactivated tenants (no membership details). Everyone else is refused (42501).';
