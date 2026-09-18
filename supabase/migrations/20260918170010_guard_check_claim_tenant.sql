-- UNAPPLIED. Repo artifact only. Do not apply from this PR.
--
-- Closes cross-tenant check_intake_items.claim_id assignment before any
-- SECURITY DEFINER ledger trigger can amplify an invalid link.
--
-- Authoritative product model (do NOT use claims.org_id alone):
-- * check tenant  = check_intake_items.tenant_id
-- * claim tenant  = distinct tenant keys observed on the claim:
--     - other check_intake_items.tenant_id for the same claim_id
--     - check_cases.tenant_id where external_claim_id = claims.id
--     - claims.org_id when NOT NULL
--     - homeowner_ledger_events.tenant_id for the same claim_id
--     - claim_checks / claim_payments via their intake tenant
-- * first link (no observed claim tenant) is allowed
-- * claim_id NULL (unlink) remains allowed
-- * missing claim is denied
-- * missing check tenant on a link is denied
-- * applies to direct table writes, including service_role (BEFORE trigger)

CREATE OR REPLACE FUNCTION public.claim_observed_tenant_ids(
  p_claim_id uuid,
  p_exclude_check_id uuid DEFAULT NULL
)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT DISTINCT x.tenant_id
  FROM (
    SELECT ci.tenant_id
    FROM public.check_intake_items ci
    WHERE ci.claim_id = p_claim_id
      AND ci.tenant_id IS NOT NULL
      AND (p_exclude_check_id IS NULL OR ci.id IS DISTINCT FROM p_exclude_check_id)

    UNION
    SELECT cc.tenant_id
    FROM public.check_cases cc
    WHERE cc.external_claim_id = p_claim_id
      AND cc.tenant_id IS NOT NULL

    UNION
    SELECT cl.org_id
    FROM public.claims cl
    WHERE cl.id = p_claim_id
      AND cl.org_id IS NOT NULL

    UNION
    SELECT hle.tenant_id
    FROM public.homeowner_ledger_events hle
    WHERE hle.claim_id = p_claim_id
      AND hle.tenant_id IS NOT NULL

    UNION
    SELECT ci.tenant_id
    FROM public.claim_checks chk
    JOIN public.check_intake_items ci ON ci.id = chk.check_intake_item_id
    WHERE chk.claim_id = p_claim_id
      AND ci.tenant_id IS NOT NULL
      AND (p_exclude_check_id IS NULL OR ci.id IS DISTINCT FROM p_exclude_check_id)

    UNION
    SELECT ci.tenant_id
    FROM public.claim_payments cp
    JOIN public.check_intake_items ci ON ci.id = cp.check_intake_item_id
    WHERE cp.claim_id = p_claim_id
      AND ci.tenant_id IS NOT NULL
      AND (p_exclude_check_id IS NULL OR ci.id IS DISTINCT FROM p_exclude_check_id)
  ) x
  WHERE x.tenant_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_check_claim_link(
  p_check_tenant_id uuid,
  p_claim_id uuid,
  p_exclude_check_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenants uuid[];
BEGIN
  IF p_claim_id IS NULL THEN
    RETURN 'unlinked';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.id = p_claim_id) THEN
    RETURN 'missing_claim';
  END IF;

  IF p_check_tenant_id IS NULL THEN
    RETURN 'missing_check_tenant';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT t.tenant_id), ARRAY[]::uuid[])
    INTO v_tenants
  FROM public.claim_observed_tenant_ids(p_claim_id, p_exclude_check_id) t;

  IF COALESCE(array_length(v_tenants, 1), 0) = 0 THEN
    RETURN 'first_link';
  END IF;

  IF COALESCE(array_length(v_tenants, 1), 0) > 1 THEN
    RETURN 'conflicting_claim_tenants';
  END IF;

  IF v_tenants[1] IS DISTINCT FROM p_check_tenant_id THEN
    RETURN 'cross_tenant';
  END IF;

  RETURN 'same_tenant';
END;
$$;

CREATE OR REPLACE FUNCTION public.check_claim_link_allowed(
  p_check_tenant_id uuid,
  p_claim_id uuid,
  p_exclude_check_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.evaluate_check_claim_link(p_check_tenant_id, p_claim_id, p_exclude_check_id)
    IN ('unlinked', 'first_link', 'same_tenant');
$$;

CREATE OR REPLACE FUNCTION public.assert_check_claim_link_allowed(
  p_check_id uuid,
  p_check_tenant_id uuid,
  p_claim_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reason text;
BEGIN
  v_reason := public.evaluate_check_claim_link(p_check_tenant_id, p_claim_id, p_check_id);
  IF v_reason NOT IN ('unlinked', 'first_link', 'same_tenant') THEN
    RAISE EXCEPTION 'check_claim_link_denied: %', v_reason
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_guard_check_claim_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.claim_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.claim_id IS NOT DISTINCT FROM OLD.claim_id THEN
    RETURN NEW;
  END IF;
  PERFORM public.assert_check_claim_link_allowed(NEW.id, NEW.tenant_id, NEW.claim_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_check_claim_link ON public.check_intake_items;
CREATE TRIGGER trg_guard_check_claim_link
BEFORE INSERT OR UPDATE ON public.check_intake_items
FOR EACH ROW
EXECUTE FUNCTION public.trg_guard_check_claim_link();

DROP POLICY IF EXISTS "Owner tenant staff can insert checks" ON public.check_intake_items;
CREATE POLICY "Owner tenant staff can insert checks"
ON public.check_intake_items
FOR INSERT
WITH CHECK (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND user_belongs_to_tenant(auth.uid(), tenant_id)
  AND public.check_claim_link_allowed(tenant_id, claim_id, id)
);

DROP POLICY IF EXISTS "Owner tenant staff can update checks" ON public.check_intake_items;
CREATE POLICY "Owner tenant staff can update checks"
ON public.check_intake_items
FOR UPDATE
USING (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND user_belongs_to_tenant(auth.uid(), tenant_id)
)
WITH CHECK (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND user_belongs_to_tenant(auth.uid(), tenant_id)
  AND public.check_claim_link_allowed(tenant_id, claim_id, id)
);

REVOKE ALL ON FUNCTION public.claim_observed_tenant_ids(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.evaluate_check_claim_link(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_claim_link_allowed(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_check_claim_link_allowed(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_guard_check_claim_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_guard_check_claim_link() FROM authenticated;

GRANT EXECUTE ON FUNCTION public.claim_observed_tenant_ids(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_check_claim_link(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_claim_link_allowed(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_check_claim_link_allowed(uuid, uuid, uuid) TO service_role;
