REVOKE EXECUTE ON FUNCTION public.tg_record_mortgage_handling_billing() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_record_mortgage_handling_billing() TO service_role;