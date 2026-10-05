-- Narrow INSERT policy for application payment event logging.
-- Tenant isolation via aws_can_write_tenant. Does not disable RLS.
-- Does not grant UPDATE/DELETE. Does not allow cross-tenant spoofing.

GRANT SELECT, INSERT ON public.payment_event_log TO authenticated;
GRANT SELECT, INSERT ON public.payment_event_log TO checksops;

DROP POLICY IF EXISTS aws_write_payment_event_log ON public.payment_event_log;
CREATE POLICY aws_write_payment_event_log ON public.payment_event_log
  FOR INSERT TO authenticated
  WITH CHECK (public.aws_can_write_tenant(tenant_id));
