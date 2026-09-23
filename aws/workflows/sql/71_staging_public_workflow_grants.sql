-- Public homeowner ledger upload insert (token already validated by API).
-- SECURITY DEFINER so the unauthenticated writer can persist the S3 object
-- metadata without impersonating staff. Does not move money.

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_upload_insert(
  p_token text,
  p_front_path text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  new_id uuid;
  created timestamptz;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 8 THEN
    RETURN jsonb_build_object('error', 'invalid_token');
  END IF;
  IF p_front_path IS NULL OR length(trim(p_front_path)) < 3 THEN
    RETURN jsonb_build_object('error', 'missing_file');
  END IF;

  SELECT * INTO tok
  FROM public.homeowner_ledger_tokens
  WHERE token = trim(p_token)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF tok.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'revoked');
  END IF;
  IF tok.expires_at IS NOT NULL AND tok.expires_at < now() THEN
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  INSERT INTO public.homeowner_ledger_check_uploads (
    tenant_id, claim_id, front_path, status, created_at
  ) VALUES (
    tok.tenant_id, tok.claim_id, trim(p_front_path), 'pending_review', now()
  )
  RETURNING id, created_at INTO new_id, created;

  RETURN jsonb_build_object(
    'ok', true,
    'id', new_id,
    'front_path', trim(p_front_path),
    'status', 'pending_review',
    'created_at', created,
    'note_ignored', p_note
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_upload_insert(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_upload_insert(text, text, text) TO checksops;
