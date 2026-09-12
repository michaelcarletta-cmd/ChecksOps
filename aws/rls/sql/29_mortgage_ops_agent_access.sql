-- Mortgage Ops operational access for the platform mortgage_agent role.
-- Does not change aws_can_access_tenant() or general tenant RLS.
-- Cross-tenant rows are visible only to platform owners and to mortgage_agent
-- for queue-eligible / self-assigned requests.

CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_queue_visible(
  p_status text,
  p_assigned_employee_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
     AND (
       p_status IN ('requested', 'in_progress')
       OR p_assigned_employee_id = auth.uid()
     );
$$;

COMMENT ON FUNCTION public.aws_mortgage_agent_queue_visible(text, uuid) IS
  'True when auth.uid() is mortgage_agent and the request is queue-eligible or assigned to the caller.';

CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_can_see_tenant(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
     AND EXISTS (
       SELECT 1
       FROM public.mortgage_handling_requests r
       WHERE r.tenant_id = _tenant_id
         AND (
           r.status IN ('requested', 'in_progress')
           OR r.assigned_employee_id = auth.uid()
         )
     );
$$;

COMMENT ON FUNCTION public.aws_mortgage_agent_can_see_tenant(uuid) IS
  'Tenant-name embed for Mortgage Ops queue. Does not grant general tenant membership.';

CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_can_see_check(_check_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
     AND EXISTS (
       SELECT 1
       FROM public.mortgage_handling_requests r
       WHERE r.check_intake_item_id = _check_id
         AND (
           r.status IN ('requested', 'in_progress')
           OR r.assigned_employee_id = auth.uid()
         )
     );
$$;

COMMENT ON FUNCTION public.aws_mortgage_agent_can_see_check(uuid) IS
  'Check embed for Mortgage Ops queue/detail. Limited to requests the agent can work.';

REVOKE ALL ON FUNCTION public.aws_mortgage_agent_queue_visible(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_mortgage_agent_can_see_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_mortgage_agent_can_see_check(uuid) FROM PUBLIC;

DROP POLICY IF EXISTS aws_select_mortgage_handling_requests ON public.mortgage_handling_requests;
CREATE POLICY aws_select_mortgage_handling_requests
ON public.mortgage_handling_requests
FOR SELECT
TO authenticated
USING (
  public.aws_is_cross_tenant_reader()
  OR public.aws_can_access_tenant(tenant_id)
  OR public.aws_mortgage_agent_queue_visible(status, assigned_employee_id)
);

DROP POLICY IF EXISTS aws_select_check_intake_items ON public.check_intake_items;
CREATE POLICY aws_select_check_intake_items
ON public.check_intake_items
FOR SELECT
TO authenticated
USING (
  public.aws_is_cross_tenant_reader()
  OR public.aws_can_access_tenant(tenant_id)
  OR public.aws_mortgage_agent_can_see_check(id)
);

DROP POLICY IF EXISTS aws_select_tenants ON public.tenants;
CREATE POLICY aws_select_tenants
ON public.tenants
FOR SELECT
TO authenticated
USING (
  public.aws_can_access_tenant(id)
  OR public.aws_mortgage_agent_can_see_tenant(id)
);

DROP POLICY IF EXISTS aws_write_mortgage_handling_requests ON public.mortgage_handling_requests;
DROP POLICY IF EXISTS aws_insert_mortgage_handling_requests ON public.mortgage_handling_requests;
DROP POLICY IF EXISTS aws_update_mortgage_handling_requests ON public.mortgage_handling_requests;
DROP POLICY IF EXISTS aws_delete_mortgage_handling_requests ON public.mortgage_handling_requests;

CREATE POLICY aws_insert_mortgage_handling_requests
ON public.mortgage_handling_requests
FOR INSERT
TO authenticated
WITH CHECK (
  public.aws_is_cross_tenant_reader()
  OR (
    public.aws_can_write_tenant(tenant_id)
    AND status = 'requested'
    AND assigned_employee_id IS NULL
  )
);

CREATE POLICY aws_update_mortgage_handling_requests
ON public.mortgage_handling_requests
FOR UPDATE
TO authenticated
USING (
  public.aws_is_cross_tenant_reader()
  OR public.aws_can_write_tenant(tenant_id)
  OR (
    public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
    AND (
      (status = 'requested' AND assigned_employee_id IS NULL)
      OR assigned_employee_id = auth.uid()
    )
  )
)
WITH CHECK (
  public.aws_is_cross_tenant_reader()
  OR (
    public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
    AND (
      (status = 'requested' AND assigned_employee_id IS NULL)
      OR assigned_employee_id = auth.uid()
    )
  )
  OR (
    public.aws_can_write_tenant(tenant_id)
    AND status = 'requested'
    AND assigned_employee_id IS NULL
  )
);

CREATE POLICY aws_delete_mortgage_handling_requests
ON public.mortgage_handling_requests
FOR DELETE
TO authenticated
USING (
  public.aws_is_cross_tenant_reader()
  OR public.aws_can_write_tenant(tenant_id)
);
