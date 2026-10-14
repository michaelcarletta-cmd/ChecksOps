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
-- uses today, so the function keeps creating and reactivating live rows. It is
-- marked with a function-level SET of checksops.partnership_writer, which
-- Postgres restores when the function returns, so the marker never leaks into
-- the rest of the caller's transaction. Browsers cannot set GUCs and the API
-- runs no client SQL, the same boundary as request.app_user_id itself.
--
-- If 32_partner_share_lifecycle.sql is re-applied (CREATE OR REPLACE drops the
-- function's SET list), connect fails closed with
-- partnership_invitee_consent_required until this file is re-applied.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.aws_tenant_partnership_consent_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _trusted boolean := COALESCE(
    current_setting('checksops.partnership_writer', true) = 'aws_connect_partner_by_code',
    false
  );
  _was_live boolean := false;
  _is_live boolean := NEW.status = 'active' AND NEW.revoked_at IS NULL;
BEGIN
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

  IF _is_live AND NOT _was_live AND NOT _trusted THEN
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
  'BEFORE INSERT/UPDATE guard on tenant_partnerships: only an invitee-tenant writer (or aws_connect_partner_by_code) can make a row active, the tenant pair is immutable, revoke/decline is always allowed.';

REVOKE ALL ON FUNCTION public.aws_tenant_partnership_consent_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS aws_tenant_partnership_consent_guard ON public.tenant_partnerships;
CREATE TRIGGER aws_tenant_partnership_consent_guard
  BEFORE INSERT OR UPDATE ON public.tenant_partnerships
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_tenant_partnership_consent_guard();

ALTER FUNCTION public.aws_connect_partner_by_code(text, uuid)
  SET checksops.partnership_writer = 'aws_connect_partner_by_code';

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
