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
  SELECT public.aws_is_cross_tenant_reader()
      OR EXISTS (
        SELECT 1
        FROM public.claims c
        WHERE c.id = _claim_id
          AND public.aws_can_access_tenant(c.org_id)
      )
      OR public.current_tenant_is_claim_funds_recipient(_claim_id)
      OR (
        public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
        AND public.mortgage_agent_can_view_claim(_claim_id)
      );
$$;

CREATE OR REPLACE FUNCTION public.aws_can_access_check(_check_id uuid)
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
      AND public.aws_can_access_check(di.check_id)
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
        OR public.aws_can_access_check(sr.check_intake_item_id)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.aws_can_access_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_claim(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_check(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_same_tenant_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_deposit_item(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_loss_draft(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_signature_request(uuid) FROM PUBLIC;
