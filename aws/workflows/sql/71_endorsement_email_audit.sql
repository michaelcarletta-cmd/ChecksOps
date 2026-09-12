-- Staging-only: fail-closed endorsement / e-signature email audit + public submit.
-- Does NOT apply financial activation. Does NOT grant tenant users extra table DML.
-- Authorized writes go through SECURITY DEFINER helpers granted to checksops only.

-- ---------------------------------------------------------------------------
-- email_send_log shape required by the audited mailer
-- ---------------------------------------------------------------------------
ALTER TABLE public.email_send_log ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE public.email_send_log ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE public.email_send_log ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE public.email_send_log ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.email_send_log ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE public.email_send_log ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE public.email_send_log ADD COLUMN IF NOT EXISTS message_id text;

DO $$
BEGIN
  ALTER TABLE public.email_send_log DROP CONSTRAINT IF EXISTS email_send_log_status_check;
  ALTER TABLE public.email_send_log
    ADD CONSTRAINT email_send_log_status_check
    CHECK (status IN (
      'pending', 'sent', 'sunk', 'suppressed', 'failed', 'bounced', 'complained', 'dlq'
    ));
EXCEPTION
  WHEN others THEN
    RAISE NOTICE 'email_send_log_status_check not replaced: %', SQLERRM;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS email_send_log_idempotency_key_uq
  ON public.email_send_log (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_send_log_provider_message_id_idx
  ON public.email_send_log (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

COMMENT ON INDEX public.email_send_log_idempotency_key_uq IS
  'One durable reservation per logical send. Concurrent duplicate claims become unique_violation.';

-- Keep existing table DML grants for checksops. Do not GRANT extra UPDATE to authenticated.

-- ---------------------------------------------------------------------------
-- Peek committed reservation by idempotency key.
-- Authenticated callers cannot read another tenant's row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_email_send_log_peek(p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  rec public.email_send_log%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'row', NULL);
  END IF;

  SELECT * INTO rec
  FROM public.email_send_log
  WHERE idempotency_key = trim(p_idempotency_key)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'row', NULL);
  END IF;

  IF auth.uid() IS NOT NULL
     AND rec.tenant_id IS NOT NULL
     AND NOT public.aws_can_write_tenant(rec.tenant_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden', 'statusCode', 403);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'row', jsonb_build_object(
      'id', rec.id,
      'status', rec.status,
      'provider_message_id', COALESCE(rec.provider_message_id, rec.message_id),
      'recipient_email', rec.recipient_email,
      'tenant_id', rec.tenant_id,
      'template_name', rec.template_name,
      'idempotency_key', rec.idempotency_key,
      'error_message', rec.error_message,
      'metadata', COALESCE(rec.metadata, '{}'::jsonb)
    )
  );
END;
$$;

COMMENT ON FUNCTION public.aws_email_send_log_peek(text) IS
  'Authorized peek of a durable email_send_log reservation. checksops only.';

-- ---------------------------------------------------------------------------
-- Pre-send reservation. Must COMMIT in the caller before SES.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_email_send_log_reserve(
  p_id uuid,
  p_template_name text,
  p_recipient_email text,
  p_tenant_id uuid,
  p_provider text,
  p_idempotency_key text,
  p_metadata jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  rec public.email_send_log%ROWTYPE;
  meta jsonb;
BEGIN
  IF p_id IS NULL OR p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  END IF;
  IF p_recipient_email IS NULL OR position('@' in p_recipient_email) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_recipient');
  END IF;
  IF p_template_name IS NULL OR length(trim(p_template_name)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_template');
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF p_tenant_id IS NULL OR NOT public.aws_can_write_tenant(p_tenant_id) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'forbidden', 'statusCode', 403);
    END IF;
  END IF;

  meta := COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('claimed', true);

  INSERT INTO public.email_send_log (
    id, template_name, recipient_email, tenant_id, status, provider,
    provider_message_id, message_id, idempotency_key, error_message, metadata, created_at
  ) VALUES (
    p_id,
    trim(p_template_name),
    lower(trim(p_recipient_email)),
    p_tenant_id,
    'pending',
    COALESCE(nullif(trim(p_provider), ''), 'aws_staging'),
    NULL,
    NULL,
    trim(p_idempotency_key),
    NULL,
    meta,
    now()
  )
  RETURNING * INTO rec;

  RETURN jsonb_build_object(
    'ok', true,
    'claimed', true,
    'duplicate', false,
    'id', rec.id,
    'row', jsonb_build_object(
      'id', rec.id,
      'status', rec.status,
      'provider_message_id', rec.provider_message_id,
      'recipient_email', rec.recipient_email,
      'tenant_id', rec.tenant_id,
      'template_name', rec.template_name,
      'idempotency_key', rec.idempotency_key,
      'metadata', COALESCE(rec.metadata, '{}'::jsonb)
    )
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO rec
    FROM public.email_send_log
    WHERE idempotency_key = trim(p_idempotency_key)
    LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'idempotency_conflict');
    END IF;
    IF auth.uid() IS NOT NULL
       AND rec.tenant_id IS NOT NULL
       AND NOT public.aws_can_write_tenant(rec.tenant_id) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'forbidden', 'statusCode', 403);
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'claimed', false,
      'duplicate', true,
      'row', jsonb_build_object(
        'id', rec.id,
        'status', rec.status,
        'provider_message_id', COALESCE(rec.provider_message_id, rec.message_id),
        'recipient_email', rec.recipient_email,
        'tenant_id', rec.tenant_id,
        'template_name', rec.template_name,
        'idempotency_key', rec.idempotency_key,
        'metadata', COALESCE(rec.metadata, '{}'::jsonb)
      )
    );
END;
$$;

COMMENT ON FUNCTION public.aws_email_send_log_reserve(uuid, text, text, uuid, text, text, jsonb) IS
  'Fail-closed pre-send email_send_log reservation. checksops only. No SES without this row.';

-- ---------------------------------------------------------------------------
-- Post-send finalize. Writes provider MessageId even when status stays pending
-- so a later retry cannot send again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_email_send_log_finalize(
  p_id uuid,
  p_status text,
  p_provider_message_id text,
  p_error_message text,
  p_metadata jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  rec public.email_send_log%ROWTYPE;
  next_status text;
BEGIN
  IF p_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_log_id');
  END IF;

  SELECT * INTO rec FROM public.email_send_log WHERE id = p_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF auth.uid() IS NOT NULL
     AND rec.tenant_id IS NOT NULL
     AND NOT public.aws_can_write_tenant(rec.tenant_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden', 'statusCode', 403);
  END IF;

  next_status := COALESCE(nullif(trim(p_status), ''), rec.status, 'failed');
  IF next_status NOT IN ('pending', 'sent', 'sunk', 'suppressed', 'failed', 'bounced', 'complained', 'dlq') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_status');
  END IF;

  UPDATE public.email_send_log
  SET status = next_status,
      provider_message_id = COALESCE(nullif(p_provider_message_id, ''), provider_message_id),
      message_id = COALESCE(nullif(p_provider_message_id, ''), message_id, provider_message_id),
      error_message = COALESCE(p_error_message, error_message),
      metadata = COALESCE(p_metadata, metadata, '{}'::jsonb)
  WHERE id = p_id
  RETURNING * INTO rec;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'finalize_failed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'row', jsonb_build_object(
      'id', rec.id,
      'status', rec.status,
      'provider_message_id', COALESCE(rec.provider_message_id, rec.message_id),
      'recipient_email', rec.recipient_email,
      'tenant_id', rec.tenant_id,
      'template_name', rec.template_name,
      'idempotency_key', rec.idempotency_key,
      'metadata', COALESCE(rec.metadata, '{}'::jsonb)
    )
  );
END;
$$;

COMMENT ON FUNCTION public.aws_email_send_log_finalize(uuid, text, text, text, jsonb) IS
  'Finalize a reserved email_send_log row with provider MessageId. checksops only.';

-- ---------------------------------------------------------------------------
-- Persist endorsement request_sent_at / token after authorized send.
-- Idempotent: already-sent rows keep the original timestamp.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_mark_endorsement_request_sent(
  p_endorsement_id uuid,
  p_contact_email text,
  p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  rec public.check_endorsements%ROWTYPE;
  updated_count integer := 0;
  v_had_sent boolean;
BEGIN
  IF p_endorsement_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_endorsement_id');
  END IF;

  SELECT * INTO rec FROM public.check_endorsements WHERE id = p_endorsement_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'statusCode', 404);
  END IF;

  IF rec.tenant_id IS NULL OR NOT public.aws_can_write_tenant(rec.tenant_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden', 'statusCode', 403);
  END IF;

  IF rec.status IN ('signed', 'waived', 'rejected') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_final', true,
      'status', rec.status,
      'request_sent_at', rec.request_sent_at,
      'token', rec.token
    );
  END IF;

  v_had_sent := rec.request_sent_at IS NOT NULL;

  UPDATE public.check_endorsements
  SET status = CASE WHEN status IN ('pending', 'sent') THEN 'sent' ELSE status END,
      reminder_count = CASE
        WHEN v_had_sent THEN reminder_count
        ELSE COALESCE(reminder_count, 0) + 1
      END,
      request_sent_at = COALESCE(request_sent_at, now()),
      last_reminder_at = now(),
      contact_email = COALESCE(nullif(trim(p_contact_email), ''), contact_email),
      token = COALESCE(nullif(trim(p_token), ''), token),
      token_expires_at = NULL,
      updated_at = now()
  WHERE id = p_endorsement_id
    AND status NOT IN ('signed', 'waived', 'rejected')
  RETURNING * INTO rec;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'endorsement_update_failed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'id', rec.id,
    'status', rec.status,
    'request_sent_at', rec.request_sent_at,
    'token', rec.token
  );
END;
$$;

COMMENT ON FUNCTION public.aws_mark_endorsement_request_sent(uuid, text, text) IS
  'Authorized mark of check_endorsements.request_sent_at after provider accept. checksops only.';

-- ---------------------------------------------------------------------------
-- Public submit / reject by unused token. Token is the capability.
-- ---------------------------------------------------------------------------
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

  SELECT * INTO rec
  FROM public.check_endorsements
  WHERE token = trim(p_token)
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

CREATE OR REPLACE FUNCTION public.aws_public_reject_endorsement(
  p_token text,
  p_reason text,
  p_ip text,
  p_user_agent text,
  p_new_token text
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

  SELECT * INTO rec
  FROM public.check_endorsements
  WHERE token = trim(p_token)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_or_used_token', 'statusCode', 404);
  END IF;

  IF rec.status IN ('signed', 'rejected', 'waived', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_or_used_token', 'statusCode', 404);
  END IF;

  IF p_new_token IS NULL OR length(trim(p_new_token)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_rotated_token');
  END IF;

  UPDATE public.check_endorsements
  SET status = 'rejected',
      notes = COALESCE(p_reason, notes),
      ip_address = p_ip,
      user_agent = p_user_agent,
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

  RETURN jsonb_build_object(
    'ok', true,
    'id', rec.id,
    'check_id', rec.check_id,
    'tenant_id', rec.tenant_id,
    'payee_id', rec.payee_id,
    'payee_name', rec.payee_name,
    'contact_email', rec.contact_email,
    'status', rec.status
  );
END;
$$;

COMMENT ON FUNCTION public.aws_public_reject_endorsement(text, text, text, text, text) IS
  'Public unused-token endorsement reject. SECURITY DEFINER. checksops only.';

REVOKE ALL ON FUNCTION public.aws_email_send_log_peek(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_email_send_log_reserve(uuid, text, text, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_email_send_log_finalize(uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_mark_endorsement_request_sent(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_public_reject_endorsement(text, text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.aws_email_send_log_peek(text) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_email_send_log_reserve(uuid, text, text, uuid, text, text, jsonb) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_email_send_log_finalize(uuid, text, text, text, jsonb) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_mark_endorsement_request_sent(uuid, text, text) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_public_reject_endorsement(text, text, text, text, text) TO checksops;
