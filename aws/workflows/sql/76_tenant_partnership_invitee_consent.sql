-- Only the invitee side can make a tenant_partnerships row active.
--
-- A row is "live" when status = 'active' AND revoked_at IS NULL. That is what
-- list_partner_payout_options, add_partner_stakeholder_to_check,
-- aws_share_check_with_partner and the production Moov send handler trust.
--
-- The RLS write policies on this table (aws_write_tenant_partnerships and the
-- copied Supabase policies) let a writer on EITHER side insert or update a row
-- and do not constrain status, so the inviter could create or flip its own
-- row to active. This trigger closes that whatever the live policy set is:
--
--   * A row may become live (INSERT as live, or UPDATE from not-live to live)
--     only when the acting user (auth.uid(), from request.app_user_id) is a
--     tenant_users member of invitee_tenant_id who can write that tenant.
--     Platform owners and the inviter side cannot do it for them.
--   * On UPDATE the tenant pair is fixed: inviter_tenant_id never changes and
--     invitee_tenant_id can only go from NULL to a tenant (redeeming an open
--     invite). The live rule then applies to that new invitee.
--   * Pending, decline and revoke/end are unchanged: either side may write a
--     row that is not live (status 'pending', 'revoked', 'declined', or any
--     row with revoked_at set). Going from live to not-live is always allowed.
--
-- Trusted writer: aws_connect_partner_by_code (Settings > Partner Code). The
-- redeemer entering the invitee's own Partner Code is the consent this product
-- uses today, so the function keeps creating and reactivating live rows. The
-- guard recognises it from PG_CONTEXT, the call stack Postgres itself builds:
--   * current_user must be connect's owner (connect runs with its owner's
--     rights). This is the main boundary: the API role is not the owner.
--   * The writing statement must be one of connect's own three row writes
--     (matched by sha256 of the text PG_CONTEXT prints), run directly by
--     aws_connect_partner_by_code(text,uuid). Postgres prints statement text
--     unescaped, so the hash, not the frame shape, is what stops dynamic SQL
--     run as the owner from passing itself off as connect.
-- A function-level SET of a custom setting is not used: Postgres 15+ lets only
-- a superuser attach one, and the AWS database user is not one.
--
-- Fails closed (connect is refused, nothing is opened) if connect's write
-- statements change, if connect or this guard lose SET search_path = public
-- (frames would print schema-qualified), or if server messages are translated
-- (lc_messages is superuser-only; AWS uses English). The pattern is an E''
-- string so standard_conforming_strings cannot change it.
--
-- The guard does not change aws_connect_partner_by_code, so re-applying
-- 32_partner_share_lifecycle.sql unchanged keeps connect working. If connect's
-- write statements ever change, update the hashes here (a repo test derives
-- them from SQL 32). The staging executor pins connect's body and refuses apply
-- when the API role owns connect or is a member of its owner.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.aws_tenant_partnership_consent_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _ctx text;
  _stmt text;
  _trusted boolean := false;
  _was_live boolean := false;
  _is_live boolean := NEW.status = 'active' AND NEW.revoked_at IS NULL;
BEGIN
  -- Trusted writer: one of aws_connect_partner_by_code's own write statements,
  -- run directly by it as its owner. PG_CONTEXT lists this guard first, then the
  -- writing statement, then the function that ran it. Postgres prints statement
  -- text unescaped, so the statement must hash to exactly one of connect's three
  -- row writes in SQL 32 (reactivate, new row, and the reactivate in its
  -- unique_violation retry); a dynamic statement cannot reproduce them.
  GET DIAGNOSTICS _ctx = PG_CONTEXT;
  _stmt := substring(_ctx from E'^PL/pgSQL function aws_tenant_partnership_consent_guard\\(\\) line [0-9]+ at GET DIAGNOSTICS\nSQL statement "([^"]*)"\nPL/pgSQL function aws_connect_partner_by_code\\(text,uuid\\) line [0-9]+ at SQL statement(?:\n|$)');
  _trusted := COALESCE(
    encode(pg_catalog.sha256(convert_to(_stmt, 'UTF8')), 'hex') IN (
      'c8fc47f91e83fcf246df089dc86d9a1f91d7dfc14196f5d77e0a393920bcfd48',
      'd5f42d0e619e1c484f63e71077e27c6cbcbf7b5bd8d279d65f6a3b6192f6e414',
      '993e0708fac80457d614485ba16be98a6869ceb9b74bca9200eb6db16b803867'
    )
    AND current_user = (
      SELECT pg_catalog.pg_get_userbyid(p.proowner)
      FROM pg_catalog.pg_proc p
      WHERE p.oid = pg_catalog.to_regprocedure('public.aws_connect_partner_by_code(text, uuid)')
    ),
    false
  );

  IF TG_OP = 'UPDATE' THEN
    _was_live := OLD.status = 'active' AND OLD.revoked_at IS NULL;
    IF NOT _trusted AND (
      NEW.inviter_tenant_id IS DISTINCT FROM OLD.inviter_tenant_id
      OR (OLD.invitee_tenant_id IS NOT NULL
          AND NEW.invitee_tenant_id IS DISTINCT FROM OLD.invitee_tenant_id)
    ) THEN
      RAISE EXCEPTION 'partnership_tenants_immutable' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Becoming live, or a live row getting a (new) invitee, needs that invitee's writer.
  IF _is_live AND NOT _trusted AND (
    NOT _was_live
    OR (TG_OP = 'UPDATE' AND NEW.invitee_tenant_id IS DISTINCT FROM OLD.invitee_tenant_id)
  ) THEN
    IF NEW.invitee_tenant_id IS NULL
       OR NOT (
         NEW.invitee_tenant_id IN (SELECT public.aws_user_tenant_ids())
         AND COALESCE(public.aws_can_write_tenant(NEW.invitee_tenant_id), false)
       )
    THEN
      RAISE EXCEPTION 'partnership_invitee_consent_required' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.aws_tenant_partnership_consent_guard() IS
  'BEFORE INSERT/UPDATE guard on tenant_partnerships: only an invitee-tenant writer (or a statement inside aws_connect_partner_by_code) can make a row active, the tenant pair is immutable, revoke/decline is always allowed.';

REVOKE ALL ON FUNCTION public.aws_tenant_partnership_consent_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS aws_tenant_partnership_consent_guard ON public.tenant_partnerships;
CREATE TRIGGER aws_tenant_partnership_consent_guard
  BEFORE INSERT OR UPDATE ON public.tenant_partnerships
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_tenant_partnership_consent_guard();

-- Retire the Supabase-era write and admin policies copied to AWS. Writes go
-- through the definer-rights lifecycle functions in 32_partner_share_lifecycle.sql;
-- aws_write_tenant_partnerships and aws_select_tenant_partnerships stay. The admin
-- policies let any user_roles admin read or write every tenant's partnerships;
-- ChecksOps has no cross-tenant admin role.
DROP POLICY IF EXISTS "Inviter can create partnerships" ON public.tenant_partnerships;
DROP POLICY IF EXISTS "Partners can update partnerships" ON public.tenant_partnerships;
DROP POLICY IF EXISTS "Admins can create any partnership" ON public.tenant_partnerships;
DROP POLICY IF EXISTS "Admins can view any partnership" ON public.tenant_partnerships;
DROP POLICY IF EXISTS "Admins can update any partnership" ON public.tenant_partnerships;
