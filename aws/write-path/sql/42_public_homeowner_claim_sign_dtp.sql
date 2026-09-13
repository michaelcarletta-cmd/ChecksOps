-- Phase 2: public claim-portal Direction to Pay persist.
-- Token already proven by aws_public_homeowner_claim_by_token in the API.
-- This function re-validates the token and writes DTP metadata as SECURITY
-- DEFINER so the public checksops session (no app_user_id) can persist.
-- Does not send email, mint arbitrary tokens, or touch payments.

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_claim_sign_dtp(
  p_token text,
  p_signature_name text,
  p_insurance_carrier text,
  p_claim_number text,
  p_policy_number text,
  p_property_address text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  signed_row record;
  name_trim text;
BEGIN
  IF p_token IS NULL OR p_token !~* '^[a-f0-9]{32,80}$' THEN
    RETURN jsonb_build_object('error', 'invalid_token');
  END IF;

  name_trim := trim(coalesce(p_signature_name, ''));
  IF length(name_trim) < 2 THEN
    RETURN jsonb_build_object('error', 'missing_signature_name');
  END IF;

  UPDATE public.homeowner_intro_requests SET
    dtp_signed_at = now(),
    dtp_signature_name = name_trim,
    dtp_insurance_carrier = COALESCE(nullif(trim(coalesce(p_insurance_carrier, '')), ''), dtp_insurance_carrier),
    dtp_claim_number = COALESCE(nullif(trim(coalesce(p_claim_number, '')), ''), dtp_claim_number),
    dtp_policy_number = COALESCE(nullif(trim(coalesce(p_policy_number, '')), ''), dtp_policy_number),
    dtp_property_address = COALESCE(nullif(trim(coalesce(p_property_address, '')), ''), dtp_property_address),
    updated_at = now()
  WHERE access_token = p_token
    AND status = 'accepted'
    AND accepted_at IS NOT NULL
  RETURNING id, dtp_signed_at, dtp_signature_name, dtp_insurance_carrier, dtp_claim_number
  INTO signed_row;

  IF signed_row.id IS NULL OR signed_row.dtp_signed_at IS NULL THEN
    RETURN jsonb_build_object('error', 'persist_failed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'signed', true,
    'id', signed_row.id,
    'dtp_signed_at', signed_row.dtp_signed_at,
    'dtp_signature_name', signed_row.dtp_signature_name,
    'dtp_insurance_carrier', signed_row.dtp_insurance_carrier,
    'dtp_claim_number', signed_row.dtp_claim_number
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_claim_sign_dtp(
  text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_claim_sign_dtp(
  text, text, text, text, text, text
) TO checksops;
