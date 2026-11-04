-- SQL 141: permanent vendors, and a tenant adding a vendor as a payee by its Partner Code.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why (owner, 2026-11-03): the platform owner creates permanent vendor organizations. Each has a
-- Partner Code (tenants.partner_code, as every organization does). A tenant enters a vendor's
-- Partner Code to add that vendor as a payee, immediately, without the vendor approving. The code
-- only adds a payee: it never creates a tenant partnership and never shares a check, a claim or any
-- other record with the vendor. Money paid to a vendor lands in the vendor's own ChecksOps (Moov)
-- wallet; the vendor chooses on its Wallet page whether it stays there or goes to its bank
-- (automatic payouts). Vendors use the Vendor Portal (/vendor-ops: Wallet, Payments & Financials,
-- Settings), not the Check Center.
--
-- Today a tenant can pay another organization's wallet only on the partner path of the send
-- endpoint (aws/functions/api/providers/production/moov-send.mjs resolveDestinations, kind
-- 'partner'), which requires the check to be shared with that organization or an active
-- tenant_partnerships row (SQL 76). A partnership is the check-sharing relationship, so it is the
-- wrong permission for a vendor. Payee rows (SQL 113) are paid by ACH to a bank only. This file adds
-- the permission a vendor payment needs and nothing else; the send endpoint accepting it is a
-- separate API change (not in this file).
--
-- Vendor status is its own table, not a tenants column: public.tenants is guarded by
-- aws_tenants_member_column_guard (SQL 102), which refuses a change to any column it does not list,
-- the platform owner's included, and is audited by the profile trigger. Keeping vendors out of
-- tenants leaves that guard, its audit and every tenants grant exactly as they are.
--
-- A new migration, not an edit to any earlier file (AGENTS.md: migrations are append-only).
--
-- What this file does:
-- a) public.vendor_tenants (new): one row per permanent vendor organization.
--      tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE;
--      created_at timestamptz NOT NULL DEFAULT now(); created_by uuid.
--    RLS on. One SELECT policy, aws_select_vendor_tenants, TO authenticated: the vendor's own
--    members (aws_user_tenant_ids(), so the Vendor Portal can tell its organization is a vendor)
--    and the platform owner (is_platform_owner()).
-- b) public.tenant_vendor_payees (new): one row per (tenant, vendor) payee link.
--      id uuid PK DEFAULT gen_random_uuid(); tenant_id (the paying organization) and
--      vendor_tenant_id (the vendor), both REFERENCES public.tenants(id) ON DELETE CASCADE;
--      partner_code_used text; added_by uuid; created_at timestamptz NOT NULL DEFAULT now();
--      removed_at timestamptz; removed_by uuid; CHECK (tenant_id <> vendor_tenant_id).
--      A partial unique index allows one live link (removed_at IS NULL) per pair; a removed link
--      stays as history and the vendor can be added again. An index on vendor_tenant_id.
--    RLS on. One SELECT policy, aws_select_tenant_vendor_payees, TO authenticated: the paying
--    organization's members and the platform owner. The vendor does not read which tenants added it.
--    Grants on both tables: every non-owner grant is revoked (what the database's default privileges
--    give a new table: the cause of SQL 117's staging rollback, fixed in SQL 118), then SELECT only
--    to checksops and authenticated. No INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER to
--    any role: every write goes through the functions below.
-- c) Three SECURITY DEFINER functions (VOLATILE, search_path = public, row_security = off, owned by
--    the applying login like the other aws/workflows/sql DEFINER functions; EXECUTE revoked from
--    PUBLIC and granted to checksops only):
--      aws_vendor_payee_add(_tenant_id uuid, _partner_code text)
--        A member of _tenant_id adds the vendor whose current Partner Code (tenants.partner_code)
--        or Partner Code alias (tenant_partner_code_aliases) is _partner_code. Refused unless the
--        code names exactly one organization, that organization is a vendor (vendor_tenants) with
--        subscription_status 'active', and it is not the caller's own organization. A regular
--        organization's code is answered like an unknown code (vendor_not_found), so it is not
--        confirmed to exist. A live link for the pair is returned as it is (replayed). Writes only
--        tenant_vendor_payees.
--      aws_vendor_payee_remove(_tenant_id uuid, _vendor_tenant_id uuid)
--        A member of _tenant_id ends its live link to that vendor (removed_at, removed_by).
--      aws_platform_owner_set_tenant_vendor(_tenant_id uuid, _is_vendor boolean)
--        The platform owner (is_platform_owner()) marks an organization as a vendor (a
--        vendor_tenants row) or not (the row deleted). Turning it off keeps the payee links as
--        history; the send endpoint is to refuse a link whose vendor is no longer a vendor.
--    Nothing here moves money, creates a Moov account or reads one.
--
-- Not changed: public.tenants (no column, trigger, grant or row), tenant_partnerships,
-- shared_checks, stakeholder_accounts, external_payment_recipients, every existing policy and
-- function (lookup_tenant_by_partner_code, aws_tenants_member_column_guard included); nothing to
-- anon, PUBLIC or service_role.
--
-- Preconditions fail closed (nothing changes otherwise):
--   a. public.tenants (id, name, partner_code, subscription_status), public.tenant_users,
--      public.tenant_partner_code_aliases (tenant_id, code), auth.uid(), aws_user_tenant_ids(),
--      is_platform_owner() and the roles checksops and authenticated exist
--      (55000 sql141_prerequisite_missing).
--   b. The applying login reads public.tenants and public.tenant_partner_code_aliases without row
--      security, as the functions do: it owns them (no FORCE ROW LEVEL SECURITY) or is a superuser
--      or BYPASSRLS (55000 sql141_definer_cannot_read).
--
-- Re-running the file is a no-op: CREATE TABLE / INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before
-- CREATE POLICY, the ACL reset, CREATE OR REPLACE FUNCTION.

DO $sql141_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.tenants', to_regclass('public.tenants')::oid),
      ('public.tenant_users', to_regclass('public.tenant_users')::oid),
      ('public.tenant_partner_code_aliases', to_regclass('public.tenant_partner_code_aliases')::oid),
      ('auth.uid()', to_regprocedure('auth.uid()')::oid),
      ('public.aws_user_tenant_ids()', to_regprocedure('public.aws_user_tenant_ids()')::oid),
      ('public.is_platform_owner()', to_regprocedure('public.is_platform_owner()')::oid),
      ('role checksops', (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'checksops')),
      ('role authenticated', (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('tenants', 'id'), ('tenants', 'name'), ('tenants', 'partner_code'),
        ('tenants', 'subscription_status'),
        ('tenant_users', 'tenant_id'), ('tenant_users', 'user_id'),
        ('tenant_partner_code_aliases', 'tenant_id'), ('tenant_partner_code_aliases', 'code')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql141_prerequisite_missing: SQL 141 needs the tenants, tenant_users and tenant_partner_code_aliases tables, the AWS identity helpers and the roles checksops and authenticated; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN ('public.tenants'::regclass, 'public.tenant_partner_code_aliases'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql141_definer_cannot_read: the applying login must own public.tenants and public.tenant_partner_code_aliases (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql141_prereq$;

-- a) Permanent vendors.
CREATE TABLE IF NOT EXISTS public.vendor_tenants (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
ALTER TABLE public.vendor_tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aws_select_vendor_tenants ON public.vendor_tenants;
CREATE POLICY aws_select_vendor_tenants ON public.vendor_tenants
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT public.aws_user_tenant_ids()) OR public.is_platform_owner());
COMMENT ON TABLE public.vendor_tenants IS
  'SQL 141: permanent vendor organizations (set by the platform owner). Tenants add a vendor as a payee by its Partner Code; vendors use the Vendor Portal. Written only by aws_platform_owner_set_tenant_vendor.';

-- b) The tenant -> vendor payee links.
CREATE TABLE IF NOT EXISTS public.tenant_vendor_payees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  vendor_tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  partner_code_used text,
  added_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid,
  CONSTRAINT tenant_vendor_payees_not_self CHECK (tenant_id <> vendor_tenant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_vendor_payees_live_pair_key
  ON public.tenant_vendor_payees (tenant_id, vendor_tenant_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS tenant_vendor_payees_vendor_idx
  ON public.tenant_vendor_payees (vendor_tenant_id);
ALTER TABLE public.tenant_vendor_payees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aws_select_tenant_vendor_payees ON public.tenant_vendor_payees;
CREATE POLICY aws_select_tenant_vendor_payees ON public.tenant_vendor_payees
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT public.aws_user_tenant_ids()) OR public.is_platform_owner());
COMMENT ON TABLE public.tenant_vendor_payees IS
  'SQL 141: a tenant''s vendor payees (added by Partner Code). Grants no access to checks or other records. Written only by aws_vendor_payee_add / aws_vendor_payee_remove.';

-- Both tables: no grant but the owner's (the default privileges of a new table included), then
-- SELECT for checksops and authenticated.
DO $sql141_table_acl$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass AS tbl, a.grantee
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid IN ('public.vendor_tenants'::regclass, 'public.tenant_vendor_payees'::regclass)
      AND a.grantee <> c.relowner
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', r.tbl);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', r.tbl, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END
$sql141_table_acl$;
REVOKE ALL ON TABLE public.vendor_tenants FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_vendor_payees FROM PUBLIC;
GRANT SELECT ON TABLE public.vendor_tenants TO checksops, authenticated;
GRANT SELECT ON TABLE public.tenant_vendor_payees TO checksops, authenticated;

-- c) The functions.
CREATE OR REPLACE FUNCTION public.aws_vendor_payee_add(_tenant_id uuid, _partner_code text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_code text := upper(btrim(COALESCE(_partner_code, '')));
  v_found integer;
  v_vendor uuid;
  v_vendor_row public.tenants%ROWTYPE;
  v_link public.tenant_vendor_payees%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR _tenant_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.aws_user_tenant_ids() t WHERE t = _tenant_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_code !~ '^[A-Z0-9_-]{3,40}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  SELECT count(DISTINCT x.id)::integer, min(x.id::text)::uuid INTO v_found, v_vendor
    FROM (
      SELECT t.id FROM public.tenants t
       WHERE t.partner_code IS NOT NULL AND upper(btrim(t.partner_code)) = v_code
      UNION
      SELECT a.tenant_id FROM public.tenant_partner_code_aliases a
       WHERE upper(btrim(a.code)) = v_code
    ) x;
  IF v_found <> 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vendor_not_found');
  END IF;
  IF v_vendor = _tenant_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'own_code');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vendor_tenants v WHERE v.tenant_id = v_vendor) THEN
    -- Not a vendor: the same answer as an unknown code, so the code of a regular
    -- organization is not confirmed to exist.
    RETURN jsonb_build_object('ok', false, 'error', 'vendor_not_found');
  END IF;
  SELECT * INTO v_vendor_row FROM public.tenants WHERE id = v_vendor;
  IF v_vendor_row.subscription_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vendor_inactive');
  END IF;

  SELECT * INTO v_link FROM public.tenant_vendor_payees
   WHERE tenant_id = _tenant_id AND vendor_tenant_id = v_vendor AND removed_at IS NULL;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'link_id', v_link.id,
                              'vendor_tenant_id', v_vendor, 'vendor_name', v_vendor_row.name);
  END IF;

  INSERT INTO public.tenant_vendor_payees (tenant_id, vendor_tenant_id, partner_code_used, added_by)
  VALUES (_tenant_id, v_vendor, v_code, v_actor)
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_link;
  IF NOT FOUND THEN
    -- A concurrent add of the same pair won the unique index: return that link.
    SELECT * INTO v_link FROM public.tenant_vendor_payees
     WHERE tenant_id = _tenant_id AND vendor_tenant_id = v_vendor AND removed_at IS NULL;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'link_id', v_link.id,
                              'vendor_tenant_id', v_vendor, 'vendor_name', v_vendor_row.name);
  END IF;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'link_id', v_link.id,
                            'vendor_tenant_id', v_vendor, 'vendor_name', v_vendor_row.name);
END
$$;

CREATE OR REPLACE FUNCTION public.aws_vendor_payee_remove(_tenant_id uuid, _vendor_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_actor IS NULL OR _tenant_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.aws_user_tenant_ids() t WHERE t = _tenant_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF _vendor_tenant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_vendor');
  END IF;
  UPDATE public.tenant_vendor_payees
     SET removed_at = now(), removed_by = v_actor
   WHERE tenant_id = _tenant_id AND vendor_tenant_id = _vendor_tenant_id AND removed_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  RETURN jsonb_build_object('ok', true, 'vendor_tenant_id', _vendor_tenant_id);
END
$$;

CREATE OR REPLACE FUNCTION public.aws_platform_owner_set_tenant_vendor(_tenant_id uuid, _is_vendor boolean)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF _tenant_id IS NULL OR _is_vendor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = _tenant_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_found');
  END IF;
  IF _is_vendor THEN
    INSERT INTO public.vendor_tenants (tenant_id, created_by) VALUES (_tenant_id, v_actor)
    ON CONFLICT (tenant_id) DO NOTHING;
  ELSE
    DELETE FROM public.vendor_tenants WHERE tenant_id = _tenant_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'tenant_id', _tenant_id, 'is_vendor', _is_vendor);
END
$$;

REVOKE ALL ON FUNCTION public.aws_vendor_payee_add(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_vendor_payee_remove(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_platform_owner_set_tenant_vendor(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_vendor_payee_add(uuid, text) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_vendor_payee_remove(uuid, uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_set_tenant_vendor(uuid, boolean) TO checksops;

COMMENT ON FUNCTION public.aws_vendor_payee_add(uuid, text) IS
  'SQL 141: a tenant member adds a vendor (vendor_tenants, active) as a payee by its Partner Code. No partnership, no shared record. checksops only.';
COMMENT ON FUNCTION public.aws_vendor_payee_remove(uuid, uuid) IS
  'SQL 141: a tenant member ends its live payee link to a vendor. checksops only.';
COMMENT ON FUNCTION public.aws_platform_owner_set_tenant_vendor(uuid, boolean) IS
  'SQL 141: the platform owner marks an organization as a permanent vendor (vendor_tenants) or not. checksops only.';
