-- SQL 165: the API's read of a tenant's vendor payees, and payroll history that can hold a vendor.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why (owner, 2026-11-13): a tenant pays a vendor (SQL 141) from a check, as a recipient beside stakeholders and
-- partners, and from the standalone Payroll payment, where the vendor is an allowed single recipient. The send
-- endpoint (moov-send.mjs) must refuse a payee link that was removed, whose organization is no longer marked a vendor,
-- or that is not active. The API login (checksops, a member of authenticated, subject to row-level security) cannot
-- see whether another organization is a vendor: SQL 141's aws_select_vendor_tenants lets only the vendor's own members
-- and the platform owner read a vendor_tenants row (aws/tests/sql141-permanent-vendor-payees-pg.test.mjs). The owner
-- chose (2026-11-13) "New migration": a read-only lookup, so unmarking a vendor stops new payments at once and the
-- vendor list can show "no longer a vendor"; and "Record in payroll": payroll history holds a vendor, so a vendor
-- payroll payment shows in payroll history and reports. Today public.payroll_runs.stakeholder_account_id is NOT NULL
-- (REFERENCES stakeholder_accounts), and a vendor is an organization, not a stakeholder account.
--
-- A new migration, not an edit to any earlier file (AGENTS.md: migrations are append-only). SQL 141's objects are
-- read here, never changed.
--
-- What this file does:
-- 1) public.aws_vendor_payees_for_tenant(_tenant_id uuid) RETURNS jsonb (new; plpgsql, STABLE, SECURITY DEFINER,
--    search_path = public, row_security = off, owned by the applying login like the other aws/workflows/sql DEFINER
--    functions; EXECUTE revoked from PUBLIC and granted to checksops only). Reads only; never raises for a refusal.
--      Refused unless the caller (auth.uid()) is a member of _tenant_id (aws_user_tenant_ids()):
--        {"ok": false, "error": "forbidden"}
--      Otherwise the tenant's live payee links (tenant_vendor_payees, removed_at IS NULL), by vendor name:
--        {"ok": true, "tenant_id": <uuid>, "payees": [{"link_id", "vendor_tenant_id", "vendor_name",
--          "partner_code_used", "added_at", "is_vendor" (a vendor_tenants row exists), "subscription_status"
--          (the vendor organization's tenants.subscription_status), "payable" (is_vendor and subscription_status
--          'active')}, ...]}
--    A removed link is not listed. Nothing about the vendor beyond its name and those two facts is returned.
-- 2) public.payroll_runs can record a payroll paid to a vendor:
--      a. vendor_tenant_id uuid (new, nullable, no default) with payroll_runs_vendor_tenant_id_fkey
--         FOREIGN KEY (vendor_tenant_id) REFERENCES public.tenants(id) (no ON DELETE action, as
--         stakeholder_account_id's), and the partial index payroll_runs_vendor_tenant_idx on it;
--      b. stakeholder_account_id DROP NOT NULL (its foreign key to stakeholder_accounts is unchanged);
--      c. payroll_runs_one_payee_check: CHECK (num_nonnulls(stakeholder_account_id, vendor_tenant_id) = 1), so every
--         run still names exactly one payee (every existing row names a stakeholder);
--      d. column INSERT on vendor_tenant_id to checksops (the API login, which writes payroll_runs in moov-send.mjs),
--         as SQL 164 granted its new columns; nothing to authenticated, PUBLIC, anon or service_role.
--    Every policy on payroll_runs (aws_select_payroll_runs, aws_write_payroll_runs and SQL 136's restrictive
--    money-write gates) and every table grant are unchanged, so a run is still written only by the send endpoint
--    under request.financial_execution, inside the paying tenant.
--
-- Not changed: SQL 141's tables, policies and functions; public.tenants; every other function, policy, RLS setting,
-- table grant and trigger; no row is written or changed; no money moves.
--
-- Refuses to run (55000 sql165_prerequisite_missing) without SQL 141's two tables and the columns read, tenants,
-- tenant_users, payroll_runs (id, tenant_id, stakeholder_account_id), auth.uid(), aws_user_tenant_ids() and the role
-- checksops; (55000 sql165_definer_cannot_read) unless the applying login reads tenants, vendor_tenants and
-- tenant_vendor_payees without row security (owns them with no FORCE ROW LEVEL SECURITY, or is a superuser or
-- BYPASSRLS), as the function does; and (55000 sql165_not_payroll_owner) unless it owns payroll_runs (ALTER TABLE).
--
-- Transactions: no BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once (CREATE OR REPLACE; ADD COLUMN IF NOT EXISTS; each constraint added only
-- when absent; CREATE INDEX IF NOT EXISTS; DROP NOT NULL and GRANT of a held privilege are no-ops). Not applied by
-- this change: staging first, then production, through the guarded SQL path (AGENTS.md).

DO $sql165_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.tenants', to_regclass('public.tenants')::oid),
      ('public.tenant_users', to_regclass('public.tenant_users')::oid),
      ('public.vendor_tenants (SQL 141)', to_regclass('public.vendor_tenants')::oid),
      ('public.tenant_vendor_payees (SQL 141)', to_regclass('public.tenant_vendor_payees')::oid),
      ('public.payroll_runs', to_regclass('public.payroll_runs')::oid),
      ('auth.uid()', to_regprocedure('auth.uid()')::oid),
      ('public.aws_user_tenant_ids()', to_regprocedure('public.aws_user_tenant_ids()')::oid),
      ('role checksops', (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('tenants', 'id'), ('tenants', 'name'), ('tenants', 'subscription_status'),
        ('vendor_tenants', 'tenant_id'),
        ('tenant_vendor_payees', 'id'), ('tenant_vendor_payees', 'tenant_id'),
        ('tenant_vendor_payees', 'vendor_tenant_id'), ('tenant_vendor_payees', 'partner_code_used'),
        ('tenant_vendor_payees', 'created_at'), ('tenant_vendor_payees', 'removed_at'),
        ('payroll_runs', 'id'), ('payroll_runs', 'tenant_id'), ('payroll_runs', 'stakeholder_account_id')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = to_regclass('public.' || want.tbl) AND a.attname = want.col
         AND a.attnum > 0 AND NOT a.attisdropped);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql165_prerequisite_missing: SQL 165 needs SQL 141, tenants, tenant_users, payroll_runs, the AWS identity helpers and the role checksops; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN ('public.tenants'::regclass, 'public.vendor_tenants'::regclass,
                    'public.tenant_vendor_payees'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql165_definer_cannot_read: the applying login must own public.tenants, public.vendor_tenants and public.tenant_vendor_payees (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid = 'public.payroll_runs'::regclass
      AND (me.rolsuper OR pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE'))
  ) THEN
    RAISE EXCEPTION 'sql165_not_payroll_owner: the applying login must own public.payroll_runs (ALTER TABLE)'
      USING ERRCODE = '55000';
  END IF;
END
$sql165_prereq$;

CREATE OR REPLACE FUNCTION public.aws_vendor_payees_for_tenant(_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_payees jsonb;
BEGIN
  IF v_actor IS NULL OR _tenant_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.aws_user_tenant_ids() t WHERE t = _tenant_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'link_id', l.id,
               'vendor_tenant_id', l.vendor_tenant_id,
               'vendor_name', t.name,
               'partner_code_used', l.partner_code_used,
               'added_at', l.created_at,
               'is_vendor', v.tenant_id IS NOT NULL,
               'subscription_status', t.subscription_status,
               'payable', v.tenant_id IS NOT NULL AND t.subscription_status IS NOT DISTINCT FROM 'active')
             ORDER BY lower(COALESCE(t.name, '')), l.created_at, l.id),
           '[]'::jsonb)
    INTO v_payees
    FROM public.tenant_vendor_payees l
    LEFT JOIN public.tenants t ON t.id = l.vendor_tenant_id
    LEFT JOIN public.vendor_tenants v ON v.tenant_id = l.vendor_tenant_id
   WHERE l.tenant_id = _tenant_id AND l.removed_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'tenant_id', _tenant_id, 'payees', v_payees);
END
$$;

REVOKE ALL ON FUNCTION public.aws_vendor_payees_for_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_vendor_payees_for_tenant(uuid) TO checksops;
COMMENT ON FUNCTION public.aws_vendor_payees_for_tenant(uuid) IS
  'SQL 165: a tenant member reads its live vendor payee links (SQL 141) with each vendor''s name, whether it is still a vendor and its subscription status. Read only; checksops only.';

ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS vendor_tenant_id uuid;

DO $sql165_payroll$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.payroll_runs'::regclass AND conname = 'payroll_runs_vendor_tenant_id_fkey'
  ) THEN
    ALTER TABLE public.payroll_runs
      ADD CONSTRAINT payroll_runs_vendor_tenant_id_fkey
      FOREIGN KEY (vendor_tenant_id) REFERENCES public.tenants(id);
  END IF;
END
$sql165_payroll$;

ALTER TABLE public.payroll_runs
  ALTER COLUMN stakeholder_account_id DROP NOT NULL;

DO $sql165_one_payee$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.payroll_runs'::regclass AND conname = 'payroll_runs_one_payee_check'
  ) THEN
    ALTER TABLE public.payroll_runs
      ADD CONSTRAINT payroll_runs_one_payee_check
      CHECK (num_nonnulls(stakeholder_account_id, vendor_tenant_id) = 1);
  END IF;
END
$sql165_one_payee$;

CREATE INDEX IF NOT EXISTS payroll_runs_vendor_tenant_idx
  ON public.payroll_runs (vendor_tenant_id) WHERE vendor_tenant_id IS NOT NULL;

GRANT INSERT (vendor_tenant_id) ON TABLE public.payroll_runs TO checksops;
