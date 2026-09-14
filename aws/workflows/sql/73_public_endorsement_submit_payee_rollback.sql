-- Rollback for SQL 73. Restores the SQL 71 public submit body (endorsement
-- sign + token rotate only; no check_payees UPDATE).
-- Does NOT DROP aws_public_submit_endorsement.
-- Does not touch SQL 71 reject / mark-sent / email_send_log RPCs.
-- Does not touch SQL 72 aws_public_endorsement_by_token.
-- After rollback, public CTA submit can again leave check_payees pending
-- because the follow-up JS UPDATE is RLS-denied on the public path.

CREATE OR REPLACE FUNCTION public.aws_public_submit_endorsement(
  p_token text,
  p_signature_image_url text,
  p_consent_text text,
  p_ip text,
  p_user_agent text,
  p_new_token text,
  p_check_id uuid DEFAULT NULL,
  p_payee_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  rec public.check_endorsements%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'token_required', 'statusCode', 400);
  END IF;

  PERFORM 1
  FROM public.check_endorsements
  WHERE token = trim(p_token)
  FOR UPDATE;

  SELECT * INTO rec
  FROM public.check_endorsements
  WHERE token = trim(p_token)
  ORDER BY CASE WHEN status IN ('pending', 'sent') THEN 0 WHEN status = 'signed' THEN 1 ELSE 2 END,
           updated_at DESC NULLS LAST
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_or_used_token', 'statusCode', 404);
  END IF;

  IF p_check_id IS NOT NULL AND rec.check_id IS DISTINCT FROM p_check_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'check_mismatch', 'statusCode', 403);
  END IF;
  IF p_payee_id IS NOT NULL AND rec.payee_id IS DISTINCT FROM p_payee_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payee_mismatch', 'statusCode', 403);
  END IF;

  IF rec.status = 'signed' THEN
    IF p_new_token IS NOT NULL AND length(trim(p_new_token)) > 0 THEN
      UPDATE public.check_endorsements
      SET token = CASE
            WHEN id = rec.id THEN trim(p_new_token)
            ELSE gen_random_uuid()::text
          END,
          token_expires_at = NULL,
          updated_at = now()
      WHERE token = trim(p_token);
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'already_signed', true,
      'id', rec.id,
      'check_id', rec.check_id,
      'tenant_id', rec.tenant_id,
      'payee_id', rec.payee_id,
      'payee_name', rec.payee_name,
      'contact_email', rec.contact_email,
      'status', rec.status,
      'token', rec.token
    );
  END IF;

  IF rec.status IN ('rejected', 'waived', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_or_used_token', 'statusCode', 404);
  END IF;

  IF rec.token_expires_at IS NOT NULL AND rec.token_expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_or_used_token', 'statusCode', 404);
  END IF;

  IF p_new_token IS NULL OR length(trim(p_new_token)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_rotated_token');
  END IF;

  UPDATE public.check_endorsements
  SET status = 'signed',
      signed_at = now(),
      signature_image_url = p_signature_image_url,
      signature_method = 'portal',
      ip_address = p_ip,
      user_agent = p_user_agent,
      consent_text = p_consent_text,
      token = trim(p_new_token),
      token_expires_at = NULL,
      updated_at = now()
  WHERE id = rec.id
    AND token = trim(p_token)
    AND status IN ('pending', 'sent')
  RETURNING * INTO rec;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_or_used_token', 'statusCode', 404);
  END IF;

  UPDATE public.check_endorsements
  SET token = gen_random_uuid()::text,
      token_expires_at = NULL,
      updated_at = now()
  WHERE token = trim(p_token)
    AND id <> rec.id;

  RETURN jsonb_build_object(
    'ok', true,
    'already_signed', false,
    'id', rec.id,
    'check_id', rec.check_id,
    'tenant_id', rec.tenant_id,
    'payee_id', rec.payee_id,
    'payee_name', rec.payee_name,
    'contact_email', rec.contact_email,
    'status', rec.status,
    'token', rec.token
  );
END;
$$;

COMMENT ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) IS
  'Public unused-token endorsement submit. SECURITY DEFINER. checksops only.';

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) TO checksops;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) FROM anon';
  END IF;
END
$$;
