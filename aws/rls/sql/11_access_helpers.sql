-- Tenant-scoped access helpers for the AWS SELECT policy set.
-- Cross-tenant reads require is_master_owner() or is_platform_owner() only.
-- SECURITY DEFINER + row_security=off so policy helpers can read mapping
-- tables without re-entering RLS (claims policy must not recurse through
-- aws_can_access_claim on public.claims itself).

CREATE OR REPLACE FUNCTION public.aws_can_access_tenant(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _tenant_id IS NOT NULL
     AND (
       public.aws_is_cross_tenant_reader()
       OR _tenant_id IN (SELECT public.aws_user_tenant_ids())
     );
$$;

COMMENT ON FUNCTION public.aws_can_access_tenant(uuid) IS
  'True when auth.uid() is a platform owner or a tenant_users member of _tenant_id.';

CREATE OR REPLACE FUNCTION public.aws_can_access_claim(_claim_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  -- NULL org_id claims are owner-only until deterministic ownership exists.
  SELECT public.aws_is_cross_tenant_reader()
      OR EXISTS (
        SELECT 1
        FROM public.claims c
        WHERE c.id = _claim_id
          AND c.org_id IS NOT NULL
          AND (
            public.aws_can_access_tenant(c.org_id)
            OR public.current_tenant_is_claim_funds_recipient(_claim_id)
            OR (
              public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
              AND public.mortgage_agent_can_view_claim(_claim_id)
            )
          )
      );
$$;

CREATE OR REPLACE FUNCTION public.aws_is_active_shared_check_target(_check_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _check_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.shared_checks sc
       WHERE sc.check_id = _check_id
         AND sc.revoked_at IS NULL
         AND public.aws_can_access_tenant(sc.target_tenant_id)
     );
$$;

COMMENT ON FUNCTION public.aws_is_active_shared_check_target(uuid) IS
  'True when auth.uid() can act as target_tenant_id of an unrevoked shared_checks row for _check_id. Knowledge of UUIDs or Partner Codes is not sufficient. Source/owner access is not granted here.';

CREATE OR REPLACE FUNCTION public.aws_can_access_check_non_partner(_check_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_cross_tenant_reader()
      OR EXISTS (
        SELECT 1
        FROM public.check_intake_items ci
        WHERE ci.id = _check_id
          AND public.aws_can_access_tenant(ci.tenant_id)
      )
      OR public.current_tenant_is_check_funds_recipient(_check_id)
      OR (
        public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
        AND public.mortgage_agent_can_view_check(_check_id)
      );
$$;

COMMENT ON FUNCTION public.aws_can_access_check_non_partner(uuid) IS
  'Owner-tenant / funds-recipient / mortgage-agent / platform SELECT. Does not include shared_checks partners. Use this for tables that carry bearer tokens or provider payloads.';

CREATE OR REPLACE FUNCTION public.aws_can_access_check(_check_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_can_access_check_non_partner(_check_id)
      OR public.aws_is_active_shared_check_target(_check_id);
$$;

COMMENT ON FUNCTION public.aws_can_access_check(uuid) IS
  'SELECT/read helper only. Active shared_checks target membership grants READ of non-secret check children. Do not use this helper for endorsement/payee/payment-direction/signer token columns or deposit provider JSON. Writes must use aws_can_write_check.';

CREATE OR REPLACE FUNCTION public.aws_can_access_same_tenant_user(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _user_id IS NOT NULL AND (
    _user_id = auth.uid()
    OR public.aws_is_cross_tenant_reader()
    OR EXISTS (
      SELECT 1
      FROM public.tenant_users mine
      JOIN public.tenant_users theirs
        ON theirs.tenant_id = mine.tenant_id
      WHERE mine.user_id = auth.uid()
        AND theirs.user_id = _user_id
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.aws_can_access_deposit_item(_item_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.deposit_items di
    WHERE di.id = _item_id
      AND public.aws_can_access_check_non_partner(di.check_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.aws_can_access_loss_draft(_loss_draft_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.loss_draft_tracking ldt
    WHERE ldt.id = _loss_draft_id
      AND public.aws_can_access_claim(ldt.claim_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.aws_can_access_signature_request(_request_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.signature_requests sr
    WHERE sr.id = _request_id
      AND (
        public.aws_can_access_claim(sr.claim_id)
        OR public.aws_can_access_check_non_partner(sr.check_intake_item_id)
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.aws_can_access_tax_profiles(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _tenant_id IS NOT NULL
     AND (
       public.is_platform_owner()
       OR EXISTS (
         SELECT 1
         FROM public.user_roles ur
         WHERE ur.user_id = auth.uid()
           AND ur.role::text = 'admin'
       )
       OR EXISTS (
         SELECT 1
         FROM public.tenant_users tu
         WHERE tu.tenant_id = _tenant_id
           AND tu.user_id = auth.uid()
           AND lower(tu.role) IN ('owner', 'admin')
       )
     );
$$;

COMMENT ON FUNCTION public.aws_can_access_tax_profiles(uuid) IS
  'Tax-profile access: platform owner, platform user_roles.admin, or tenant owner/admin of _tenant_id. Ordinary members are denied.';

REVOKE ALL ON FUNCTION public.aws_can_access_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_claim(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_is_active_shared_check_target(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_check_non_partner(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_check(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_same_tenant_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_deposit_item(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_loss_draft(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_signature_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_tax_profiles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_can_access_tax_profiles(uuid) TO checksops, authenticated;
