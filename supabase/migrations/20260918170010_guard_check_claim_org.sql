-- UNAPPLIED. Repo artifact only. Do not apply from this PR.
--
-- Narrow multi-tenant safety on Lovable claim linking.
-- Product identity remains globally unique claims.claim_number plus
-- freedom_claim_id / detected_claim_number auto-link (b21d4b989).
--
-- Rule:
-- * claim_id NULL (unlink) allowed
-- * missing claim denied
-- * missing check tenant denied
-- * claims.org_id IS NOT NULL must equal check_intake_items.tenant_id
-- * claims.org_id IS NULL is fail-closed unless other already-linked
--   intake rows or check_cases already establish exactly this tenant
-- * first-link / empty evidence does NOT assign ownership
--
-- Existing rows with the same claim_id are not re-validated on unrelated updates.

CREATE OR REPLACE FUNCTION public.claim_deterministic_tenant_ids(
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
  v_org uuid;
  v_exists boolean := false;
  v_tenants uuid[];
BEGIN
  IF p_claim_id IS NULL THEN
    RETURN 'unlinked';
  END IF;

  SELECT true, c.org_id
    INTO v_exists, v_org
  FROM public.claims c
  WHERE c.id = p_claim_id;

  IF NOT COALESCE(v_exists, false) THEN
    RETURN 'missing_claim';
  END IF;

  IF p_check_tenant_id IS NULL THEN
    RETURN 'missing_check_tenant';
  END IF;

  IF v_org IS NOT NULL THEN
    IF v_org IS DISTINCT FROM p_check_tenant_id THEN
      RETURN 'cross_org';
    END IF;
    RETURN 'same_org';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT t.tenant_id), ARRAY[]::uuid[])
    INTO v_tenants
  FROM public.claim_deterministic_tenant_ids(p_claim_id, p_exclude_check_id) t;

  IF COALESCE(array_length(v_tenants, 1), 0) = 0 THEN
    RETURN 'legacy_unassigned';
  END IF;

  IF COALESCE(array_length(v_tenants, 1), 0) > 1 THEN
    RETURN 'conflicting_tenants';
  END IF;

  IF v_tenants[1] IS DISTINCT FROM p_check_tenant_id THEN
    RETURN 'cross_org';
  END IF;

  RETURN 'legacy_same_tenant';
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
    IN ('unlinked', 'same_org', 'legacy_same_tenant');
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
  IF v_reason NOT IN ('unlinked', 'same_org', 'legacy_same_tenant') THEN
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

-- Preserve Lovable auto-link (b21d4b989) but do not attach a denied candidate.
CREATE OR REPLACE FUNCTION public.auto_link_check_to_claim()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  normalized TEXT;
  v_candidate uuid;
BEGIN
  IF NEW.claim_id IS NULL THEN
    IF NEW.freedom_claim_id IS NOT NULL THEN
      SELECT id INTO v_candidate
      FROM public.claims
      WHERE id = NEW.freedom_claim_id
      LIMIT 1;
    END IF;

    IF v_candidate IS NULL AND NEW.freedom_claim_number IS NOT NULL THEN
      normalized := regexp_replace(upper(NEW.freedom_claim_number), '[^A-Z0-9]', '', 'g');
      IF length(normalized) > 0 THEN
        SELECT id INTO v_candidate
        FROM public.claims
        WHERE regexp_replace(upper(coalesce(claim_number,'')), '[^A-Z0-9]', '', 'g') = normalized
        LIMIT 1;
      END IF;
    END IF;

    IF v_candidate IS NULL AND NEW.detected_claim_number IS NOT NULL THEN
      normalized := regexp_replace(upper(NEW.detected_claim_number), '[^A-Z0-9]', '', 'g');
      IF length(normalized) > 0 THEN
        SELECT id INTO v_candidate
        FROM public.claims
        WHERE regexp_replace(upper(coalesce(claim_number,'')), '[^A-Z0-9]', '', 'g') = normalized
        LIMIT 1;
      END IF;
    END IF;

    -- Auto-link may identify a candidate. It may not attach a denied claim.
    IF v_candidate IS NOT NULL
       AND public.check_claim_link_allowed(NEW.tenant_id, v_candidate, NEW.id) THEN
      NEW.claim_id := v_candidate;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

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

-- Older June auto-link (fd2d5505) still has its own BEFORE triggers.
-- It must obey the same guard so a skipped candidate is not attached afterward.
CREATE OR REPLACE FUNCTION public.tg_auto_link_check_to_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  found_claim_id uuid;
  needle text;
BEGIN
  IF NEW.claim_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  needle := NULLIF(btrim(NEW.detected_claim_number), '');
  IF needle IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.id
    INTO found_claim_id
  FROM public.claims c
  WHERE lower(btrim(c.claim_number)) = lower(needle)
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF found_claim_id IS NOT NULL
     AND public.check_claim_link_allowed(NEW.tenant_id, found_claim_id, NEW.id) THEN
    NEW.claim_id := found_claim_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_deterministic_tenant_ids(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.evaluate_check_claim_link(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_claim_link_allowed(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_check_claim_link_allowed(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_guard_check_claim_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_guard_check_claim_link() FROM authenticated;
REVOKE ALL ON FUNCTION public.claim_deterministic_tenant_ids(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.evaluate_check_claim_link(uuid, uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_check_claim_link_allowed(uuid, uuid, uuid) FROM authenticated;

-- RLS WITH CHECK runs as the inserting role and must be able to call this.
GRANT EXECUTE ON FUNCTION public.check_claim_link_allowed(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_check_claim_link(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_check_claim_link_allowed(uuid, uuid, uuid) TO service_role;
