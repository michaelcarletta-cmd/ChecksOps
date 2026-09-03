-- Revoke staging-only provider sandbox tables. Does not touch production ledgers.

DROP POLICY IF EXISTS aws_provider_sandbox_objects_all ON public.aws_provider_sandbox_objects;
DROP POLICY IF EXISTS aws_provider_sandbox_operations_all ON public.aws_provider_sandbox_operations;
DROP POLICY IF EXISTS aws_provider_sandbox_audit_all ON public.aws_provider_sandbox_audit;
DROP POLICY IF EXISTS aws_provider_sandbox_webhooks_all ON public.aws_provider_sandbox_webhooks;

REVOKE ALL ON TABLE public.aws_provider_sandbox_objects FROM checksops;
REVOKE ALL ON TABLE public.aws_provider_sandbox_operations FROM checksops;
REVOKE ALL ON TABLE public.aws_provider_sandbox_audit FROM checksops;
REVOKE ALL ON TABLE public.aws_provider_sandbox_webhooks FROM checksops;

DROP TABLE IF EXISTS public.aws_provider_sandbox_webhooks;
DROP TABLE IF EXISTS public.aws_provider_sandbox_audit;
DROP TABLE IF EXISTS public.aws_provider_sandbox_operations;
DROP TABLE IF EXISTS public.aws_provider_sandbox_objects;
