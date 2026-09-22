-- Claim ownership invariant for isolated production / production-prep.
--
-- Inspected create paths that can insert public.claims:
--   * Tracker / ClaimLedgerCard (newTrackingClaimInsert sends client org_id)
--   * Settings import (omits org_id → would persist NULL without this stamp)
--   * AWS /data/write (claims is NOT allowlisted; org_id is a stripped identity key)
--   * Check-intake associated create (same tracker insert; OCR persist never inserts claims)
--   * create_claim_for_staff is Supabase-only and is NOT present on isolated production
--   * No previous INSERT trigger stamped org_id (status/activity/retention/folders only)
--
-- This file is the smallest server-side correction: a BEFORE INSERT/UPDATE
-- trigger overwrites claims.org_id from trusted auth.uid() membership plus an
-- optional membership-checked request.active_tenant_slug. Client org_id / tenant
-- UUIDs are never used as the owner.
--
-- Sharing is unchanged: aws_share_check_with_partner / aws_revoke_shared_check
-- only touch shared_checks. This trigger preserves a non-null org_id on UPDATE
-- so share/revoke cannot change ownership even if a later path updates claims.

CREATE OR REPLACE FUNCTION public.aws_claim_owner_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _uid uuid;
  _slug text;
  _tenant uuid;
  _memberships int;
BEGIN
  _uid := auth.uid();
  IF _uid IS NULL THEN
    RETURN NULL;
  END IF;

  _slug := nullif(btrim(lower(coalesce(current_setting('request.active_tenant_slug', true), ''))), '');
  -- Never treat a client UUID as a tenant selector.
  IF _slug IS NOT NULL AND _slug ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    _slug := NULL;
  END IF;
  IF _slug IS NOT NULL AND _slug !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' THEN
    _slug := NULL;
  END IF;

  IF _slug IS NOT NULL THEN
    SELECT t.id INTO _tenant
    FROM public.tenants t
    JOIN public.tenant_users tu ON tu.tenant_id = t.id
    WHERE tu.user_id = _uid
      AND lower(t.slug) = _slug
    LIMIT 1;
    IF _tenant IS NOT NULL THEN
      RETURN _tenant;
    END IF;
  END IF;

  SELECT COUNT(DISTINCT tu.tenant_id)
    INTO _memberships
  FROM public.tenant_users tu
  WHERE tu.user_id = _uid;

  IF coalesce(_memberships, 0) = 1 THEN
    SELECT tu.tenant_id INTO _tenant
    FROM public.tenant_users tu
    WHERE tu.user_id = _uid
    LIMIT 1;
    RETURN _tenant;
  END IF;

  IF coalesce(_memberships, 0) > 1 THEN
    RAISE EXCEPTION 'claim_owner_tenant_required'
      USING ERRCODE = '22023',
            HINT = 'Set request.active_tenant_slug to a tenant the user belongs to.';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.aws_claim_owner_tenant_id() IS
  'Owning tenant for a new claim: membership-checked request.active_tenant_slug, else the user''s single tenant_users row. Never reads client org_id.';

CREATE OR REPLACE FUNCTION public.aws_stamp_claim_org_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _owner uuid;
BEGIN
  -- Existing ownership is immutable through this path. Share/revoke must not
  -- change claims.org_id, and client UPDATEs cannot reassign a claim.
  IF TG_OP = 'UPDATE' AND OLD.org_id IS NOT NULL THEN
    NEW.org_id := OLD.org_id;
    RETURN NEW;
  END IF;

  _owner := public.aws_claim_owner_tenant_id();
  IF _owner IS NOT NULL THEN
    NEW.org_id := _owner;
    RETURN NEW;
  END IF;

  -- Admin / unauthenticated / no-membership INSERT: require an explicit owner.
  -- Do not persist NULL through a normal creation path.
  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'claim_org_id_required'
      USING ERRCODE = '23502',
            HINT = 'Authenticated tenant users receive org_id from membership; admin INSERT must supply org_id.';
  END IF;

  IF auth.uid() IS NOT NULL
     AND NOT public.aws_is_cross_tenant_reader() THEN
    RAISE EXCEPTION 'claim_owner_tenant_required'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.aws_stamp_claim_org_id() IS
  'BEFORE INSERT/UPDATE: stamp claims.org_id from aws_claim_owner_tenant_id(); preserve existing org_id on UPDATE; reject NULL for tenant users.';

DROP TRIGGER IF EXISTS trg_aws_stamp_claim_org_id ON public.claims;
CREATE TRIGGER trg_aws_stamp_claim_org_id
  BEFORE INSERT OR UPDATE ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_stamp_claim_org_id();

REVOKE ALL ON FUNCTION public.aws_claim_owner_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_stamp_claim_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_claim_owner_tenant_id() TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_stamp_claim_org_id() TO checksops, authenticated;
