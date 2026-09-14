-- Endorsement activation grants. Does not touch money tables.
-- deposit_recommendation is required for AWS auto Ready-for-Deposit.
-- Public token lookup includes uploaded_by so /public/endorsement can bind RLS.

GRANT UPDATE (deposit_recommendation) ON TABLE public.check_intake_items TO checksops, authenticated;

CREATE OR REPLACE FUNCTION public.aws_public_endorsement_by_token(p_token text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT jsonb_build_object(
    'id', e.id,
    'payee_name', e.payee_name,
    'payee_type', e.payee_type,
    'payee_id', e.payee_id,
    'status', e.status,
    'token', e.token,
    'token_expires_at', e.token_expires_at,
    'check_id', e.check_id,
    'contact_email', e.contact_email,
    'carrier_name', ci.carrier_name,
    'check_number', ci.check_number,
    'amount', ci.amount,
    'claim_id', ci.claim_id,
    'tenant_id', ci.tenant_id,
    'uploaded_by', ci.uploaded_by
  )
  FROM public.check_endorsements e
  LEFT JOIN public.check_intake_items ci ON ci.id = e.check_id
  WHERE e.token = p_token
  LIMIT 1;
$$;
