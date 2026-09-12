-- Column grants required for Mortgage Ops staff RPCs (accept / status update).
-- Does not grant financial tables. Does not change aws_can_access_tenant().

GRANT UPDATE (
  assigned_employee_id,
  accepted_at,
  completed_at,
  cancelled_at
) ON TABLE public.mortgage_handling_requests TO checksops, authenticated;

GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_queue_visible(text, uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_see_tenant(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_see_check(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.mortgage_agent_can_view_check(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.mortgage_agent_can_view_claim(uuid) TO checksops, authenticated;
