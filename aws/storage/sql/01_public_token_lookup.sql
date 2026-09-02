-- Read-only public token lookups for AWS staging Sign/Endorse pages.
-- SECURITY DEFINER + row_security=off so an unauthenticated token can resolve
-- only the exact matching signer/endorsement row. No DML. No service_role login.
-- GRANT EXECUTE to checksops only.

CREATE OR REPLACE FUNCTION public.aws_public_signature_by_token_hash(p_token_hash text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT jsonb_build_object(
    'signer', jsonb_build_object(
      'id', s.id,
      'signer_name', s.signer_name,
      'signer_email', s.signer_email,
      'signer_type', s.signer_type,
      'signing_order', s.signing_order,
      'status', s.status,
      'signed_at', s.signed_at,
      'viewed_at', s.viewed_at,
      'expires_at', s.expires_at
    ),
    'request', jsonb_build_object(
      'id', r.id,
      'document_name', r.document_name,
      'document_path', r.document_path,
      'document_type', r.document_type,
      'field_data', r.field_data,
      'status', r.status,
      'claim_id', r.claim_id
    ),
    'claim', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', c.id,
      'claim_number', c.claim_number,
      'policyholder_name', c.policyholder_name
    ) END,
    'waiting_for', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', p.signer_name,
        'order', p.signing_order
      ) ORDER BY p.signing_order)
      FROM public.signature_signers p
      WHERE p.signature_request_id = r.id
        AND p.signing_order < s.signing_order
        AND p.status IS DISTINCT FROM 'signed'
    ), '[]'::jsonb),
    'fields', COALESCE((
      SELECT jsonb_agg(to_jsonb(f) ORDER BY f.page, f.y, f.x, f.id)
      FROM public.signature_fields f
      WHERE f.signature_request_id = r.id
        AND f.signer_index = s.signing_order - 1
    ), '[]'::jsonb),
    'presets', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'document_type', pr.document_type,
        'fields', pr.fields
      ) ORDER BY pr.label)
      FROM public.signature_document_presets pr
    ), '[]'::jsonb)
  )
  FROM public.signature_signers s
  JOIN public.signature_requests r ON r.id = s.signature_request_id
  LEFT JOIN public.claims c ON c.id = r.claim_id
  WHERE s.token_hash = p_token_hash
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.aws_public_signature_by_token_hash(text) IS
  'Token-hash lookup for the AWS staging Sign page. Returns only the matching signer/request. Read-only.';

REVOKE ALL ON FUNCTION public.aws_public_signature_by_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_signature_by_token_hash(text) TO checksops;

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
    'status', e.status,
    'token', e.token,
    'token_expires_at', e.token_expires_at,
    'check_id', e.check_id,
    'carrier_name', ci.carrier_name,
    'check_number', ci.check_number,
    'amount', ci.amount,
    'claim_id', ci.claim_id,
    'tenant_id', ci.tenant_id
  )
  FROM public.check_endorsements e
  LEFT JOIN public.check_intake_items ci ON ci.id = e.check_id
  WHERE e.token = p_token
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.aws_public_endorsement_by_token(text) IS
  'Plain token lookup for the AWS staging Endorse page. Returns only the matching endorsement. Read-only.';

REVOKE ALL ON FUNCTION public.aws_public_endorsement_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_endorsement_by_token(text) TO checksops;
