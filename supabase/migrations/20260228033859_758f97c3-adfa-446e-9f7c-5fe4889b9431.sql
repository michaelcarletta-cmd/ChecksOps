
-- Fix SECURITY_DEFINER view by revoking direct API access
REVOKE ALL ON public.claim_money_snapshot FROM anon, authenticated;
