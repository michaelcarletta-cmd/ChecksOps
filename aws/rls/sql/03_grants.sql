-- EXECUTE on read-only policy helpers. Do not GRANT EXECUTE ON ALL FUNCTIONS.
-- Do not grant write RPCs.

GRANT EXECUTE ON FUNCTION public.aws_user_tenant_ids() TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_is_cross_tenant_reader() TO checksops;
