-- Narrow Mortgage Ops Accept/Complete authorization overlay.
-- Staging repair only. Does not grant table-level UPDATE on
-- mortgage_handling_requests. Does not replace tenant-writer
-- aws_write_mortgage_handling_requests. Does not enable provider
-- execution, card/bank pulls, invoices, or the fail-closed billing stub.
--
-- Intended model:
--   mortgage_agent may Accept an unassigned requested row (self-assign,
--   in_progress, accepted_at);
--   mortgage_agent may Complete only a row assigned to them (completed_at);
--   never steal another agent's assignment;
--   never operate as a tenant user across tenants;
--   tenant writers keep the existing ALL policy.
--
-- Drops the historical aws_update_mortgage_handling_requests overlay when
-- present. That policy's WITH CHECK rejected the post-Accept row for
-- tenant writers (required requested + unassigned after the UPDATE).

DROP POLICY IF EXISTS aws_update_mortgage_handling_requests ON public.mortgage_handling_requests;

CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND public.has_role(auth.uid(), 'mortgage_agent'::public.app_role);
$$;
REVOKE ALL ON FUNCTION public.aws_is_mortgage_ops_agent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_is_mortgage_ops_agent() TO checksops, authenticated;

COMMENT ON FUNCTION public.aws_is_mortgage_ops_agent() IS
  'True when auth.uid() holds user_roles.mortgage_agent. Does not grant tenant-writer or cross-tenant owner rights.';

-- Desk agents are centralized. SELECT is additive; tenant isolation for
-- non-agents remains aws_can_access_tenant / owner.
DROP POLICY IF EXISTS aws_select_mortgage_ops_agent_queue ON public.mortgage_handling_requests;
CREATE POLICY aws_select_mortgage_ops_agent_queue ON public.mortgage_handling_requests
  FOR SELECT TO authenticated, checksops
  USING (public.aws_is_mortgage_ops_agent());

DROP POLICY IF EXISTS aws_update_mortgage_ops_accept_complete ON public.mortgage_handling_requests;
CREATE POLICY aws_update_mortgage_ops_accept_complete ON public.mortgage_handling_requests
  FOR UPDATE TO authenticated, checksops
  USING (
    public.aws_is_mortgage_ops_agent()
    AND (
      (status = 'requested' AND assigned_employee_id IS NULL)
      OR assigned_employee_id = auth.uid()
    )
  )
  WITH CHECK (
    public.aws_is_mortgage_ops_agent()
    AND assigned_employee_id = auth.uid()
    AND status IN ('in_progress', 'completed', 'cancelled')
    AND (
      (status = 'in_progress' AND accepted_at IS NOT NULL)
      OR status IN ('completed', 'cancelled')
    )
  );

COMMENT ON POLICY aws_update_mortgage_ops_accept_complete ON public.mortgage_handling_requests IS
  'Mortgage agent Accept (requested+unassigned → self+in_progress+accepted_at) and Complete/Cancel only when assigned to the caller. Not a table-wide UPDATE grant.';

-- Column grants only for Accept/Complete fields omitted by tranche 5.
-- Do not GRANT UPDATE on the table. Do not grant billing or invoice columns.
GRANT UPDATE (
  assigned_employee_id,
  accepted_at,
  completed_at
) ON TABLE public.mortgage_handling_requests TO checksops, authenticated;

-- Usage accrual INSERT is Accept-time only. Agents are not tenant writers,
-- so aws_write_check_billing_events cannot insert the usage row.
DROP POLICY IF EXISTS aws_insert_mortgage_ops_usage_events ON public.check_billing_events;
CREATE POLICY aws_insert_mortgage_ops_usage_events ON public.check_billing_events
  FOR INSERT TO authenticated, checksops
  WITH CHECK (
    event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
    AND status = 'recorded'
    AND payment_transfer_id IS NULL
    AND invoice_id IS NULL
    AND public.aws_is_mortgage_ops_agent()
    AND EXISTS (
      SELECT 1
      FROM public.mortgage_handling_requests r
      WHERE r.id = mortgage_request_id
        AND r.tenant_id = check_billing_events.tenant_id
        AND r.check_intake_item_id = check_billing_events.check_intake_item_id
        AND r.assigned_employee_id = auth.uid()
        AND r.status IN ('in_progress', 'completed')
        AND r.accepted_at IS NOT NULL
    )
  );

-- INSERT privilege for the Lambda login role only. authenticated is included
-- because some sessions inherit it; RLS still restricts the row shape.
GRANT INSERT ON TABLE public.check_billing_events TO checksops, authenticated;
