
-- Fix security definer views by revoking direct access and forcing access through RPC only
REVOKE ALL ON public.recovery_by_carrier FROM anon, authenticated;
REVOKE ALL ON public.recovery_by_loss_type FROM anon, authenticated;
REVOKE ALL ON public.recovery_by_escalation FROM anon, authenticated;

-- Grant only to service role (used by RPC functions)
GRANT SELECT ON public.recovery_by_carrier TO service_role;
GRANT SELECT ON public.recovery_by_loss_type TO service_role;
GRANT SELECT ON public.recovery_by_escalation TO service_role;
