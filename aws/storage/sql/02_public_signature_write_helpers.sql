-- Token-scoped public signature WRITE helpers for AWS staging.
-- Least privilege: three narrow operations instead of one generic writer.
--
--   A. aws_public_signature_mark_viewed(p_token_hash)
--   B. aws_public_signature_submit(p_token_hash, p_field_values, p_ip, p_user_agent, p_consent_text)
--   C. aws_public_signature_attach_signed(p_token_hash, p_final_rel)
--   D. aws_public_signature_set_completion_error(p_token_hash, p_error)  -- attach-fail only
--
-- Authority is the SHA-256 token hash only. Callers cannot pass signer, request,
-- tenant, claim, or check IDs as authority. Destination claim/check for attach is
-- resolved from the token-matched signature_requests row.
--
-- SECURITY DEFINER + explicit search_path. Function-local SET row_security = off
-- matches aws_public_signature_by_token_hash. This is not a session-wide RLS
-- disable and does not grant checksops BYPASSRLS or generic table writes.
-- GRANT EXECUTE to checksops only. REVOKE PUBLIC.
--
-- Do not apply to production.

CREATE OR REPLACE FUNCTION public.aws_public_signature_canonical_pdf_path(
  p_claim_id uuid,
  p_check_id uuid,
  p_request_id uuid
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_request_id IS NULL THEN NULL
    WHEN p_claim_id IS NOT NULL THEN
      'signed/' || p_claim_id::text || '/' || p_request_id::text || '-final.pdf'
    WHEN p_check_id IS NOT NULL THEN
      'check-intake/' || p_check_id::text || '/files/' || p_request_id::text || '-final.pdf'
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION public.aws_public_signature_canonical_pdf_path(uuid, uuid, uuid) IS
  'Internal canonical signed-PDF relative path. Not an authority check.';

REVOKE ALL ON FUNCTION public.aws_public_signature_canonical_pdf_path(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_signature_canonical_pdf_path(uuid, uuid, uuid) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_signature_mark_viewed(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  s public.signature_signers%ROWTYPE;
  r public.signature_requests%ROWTYPE;
  v_viewed timestamptz;
  v_recorded boolean := false;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT * INTO s
  FROM public.signature_signers
  WHERE token_hash = p_token_hash
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT * INTO r
  FROM public.signature_requests
  WHERE id = s.signature_request_id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  IF s.expires_at IS NOT NULL AND s.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;

  IF r.status IN ('cancelled', 'declined', 'expired')
     OR s.status IN ('declined', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'request_not_eligible', 'reason', COALESCE(r.status, s.status));
  END IF;

  UPDATE public.signature_signers
     SET viewed_at = COALESCE(viewed_at, now())
   WHERE id = s.id
     AND token_hash = p_token_hash
     AND viewed_at IS NULL
  RETURNING viewed_at INTO v_viewed;

  IF FOUND THEN
    v_recorded := true;
    INSERT INTO public.esign_event_logs (
      request_id, signer_id, claim_id, stage, status, message, payload
    ) VALUES (
      r.id, s.id, r.claim_id, 'signer_viewed', 'ok', 'Signer opened the document', '{}'::jsonb
    );
  ELSE
    v_viewed := s.viewed_at;
  END IF;

  UPDATE public.signature_requests
     SET status = 'in_progress'
   WHERE id = r.id
     AND status = 'pending';

  RETURN jsonb_build_object(
    'ok', true,
    'recorded', v_recorded,
    'viewed_at', v_viewed,
    'signer_id', s.id,
    'request_id', r.id
  );
END;
$$;

COMMENT ON FUNCTION public.aws_public_signature_mark_viewed(text) IS
  'Token-hash viewed_at persist for the AWS public Sign page. Idempotent. No caller IDs.';

REVOKE ALL ON FUNCTION public.aws_public_signature_mark_viewed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_signature_mark_viewed(text) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_signature_submit(
  p_token_hash text,
  p_field_values jsonb,
  p_ip text,
  p_user_agent text,
  p_consent_text text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  s public.signature_signers%ROWTYPE;
  r public.signature_requests%ROWTYPE;
  v_prior int;
  v_all_signed boolean := false;
  v_already boolean := false;
  v_field record;
  v_values jsonb := COALESCE(p_field_values, '{}'::jsonb);
  v_normalized jsonb := '{}'::jsonb;
  v_field_id uuid;
  v_raw text;
  v_canonical text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT * INTO s
  FROM public.signature_signers
  WHERE token_hash = p_token_hash
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT * INTO r
  FROM public.signature_requests
  WHERE id = s.signature_request_id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  IF s.expires_at IS NOT NULL AND s.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;

  IF r.status IN ('cancelled', 'declined', 'expired')
     OR s.status IN ('declined', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'request_not_eligible', 'reason', COALESCE(r.status, s.status));
  END IF;

  IF (s.signing_order IS NULL OR s.signing_order > 1) THEN
    SELECT count(*) INTO v_prior
    FROM public.signature_signers p
    WHERE p.signature_request_id = r.id
      AND p.signing_order < COALESCE(s.signing_order, 1)
      AND p.status IS DISTINCT FROM 'signed';
    IF v_prior > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'signer_order_blocked');
    END IF;
  END IF;

  IF s.status = 'signed' THEN
    v_already := true;
  ELSE
    FOR v_field IN
      SELECT f.id, f.field_type, f.label, f.page, f.x, f.y, f.width, f.height
      FROM public.signature_fields f
      WHERE f.signature_request_id = r.id
        AND f.signer_index = COALESCE(s.signing_order, 1) - 1
    LOOP
      v_field_id := v_field.id;
      v_raw := v_values ->> v_field_id::text;
      v_normalized := v_normalized || jsonb_build_object(
        v_field_id::text,
        jsonb_build_object(
          'field_type', v_field.field_type,
          'field_label', v_field.label,
          'value', v_values -> v_field_id::text,
          'page', v_field.page,
          'x', v_field.x,
          'y', v_field.y,
          'width', v_field.width,
          'height', v_field.height
        )
      );
      IF NOT EXISTS (
        SELECT 1 FROM public.signature_field_values fv
        WHERE fv.field_id = v_field_id AND fv.signer_id = s.id
      ) THEN
        INSERT INTO public.signature_field_values (field_id, signer_id, value, checked)
        VALUES (
          v_field_id,
          s.id,
          v_raw,
          CASE WHEN v_field.field_type = 'checkbox' THEN COALESCE(v_raw IN ('true', 't', '1'), false) ELSE false END
        );
      END IF;
    END LOOP;

    IF v_normalized = '{}'::jsonb THEN
      v_normalized := v_values;
    END IF;

    UPDATE public.signature_signers
       SET status = 'signed',
           signed_at = now(),
           field_values = v_normalized,
           ip_address = left(COALESCE(p_ip, ''), 64),
           user_agent = left(COALESCE(p_user_agent, ''), 500)
     WHERE id = s.id
       AND token_hash = p_token_hash
       AND status IS DISTINCT FROM 'signed';

    IF NOT FOUND THEN
      v_already := true;
    ELSE
      INSERT INTO public.esign_event_logs (
        request_id, signer_id, claim_id, stage, status, message, payload
      ) VALUES (
        r.id,
        s.id,
        r.claim_id,
        'signer_signed',
        'ok',
        COALESCE(s.signer_name, 'Signer') || ' signed the document',
        jsonb_build_object(
          'e_sign_consent_accepted', true,
          'consent_text', left(COALESCE(p_consent_text, 'Electronic records and signature consent accepted before signing.'), 500)
        )
      );
    END IF;
  END IF;

  SELECT bool_and(p.status = 'signed') AND count(*) > 0
    INTO v_all_signed
  FROM public.signature_signers p
  WHERE p.signature_request_id = r.id;

  IF v_all_signed AND r.status IS DISTINCT FROM 'completed' THEN
    UPDATE public.signature_requests
       SET status = 'completed',
           completed_at = COALESCE(completed_at, now()),
           last_error = NULL,
           completion_status = COALESCE(completion_status, 'pending')
     WHERE id = r.id
       AND status IS DISTINCT FROM 'completed';
  END IF;

  v_canonical := public.aws_public_signature_canonical_pdf_path(r.claim_id, r.check_intake_item_id, r.id);

  RETURN jsonb_build_object(
    'ok', true,
    'already_signed', v_already,
    'all_signed', COALESCE(v_all_signed, false),
    'request_completed', COALESCE(v_all_signed, false),
    'signer_id', s.id,
    'request_id', r.id,
    'claim_id', r.claim_id,
    'check_intake_item_id', r.check_intake_item_id,
    'document_path', r.document_path,
    'document_name', r.document_name,
    'final_rel', v_canonical
  );
END;
$$;

COMMENT ON FUNCTION public.aws_public_signature_submit(text, jsonb, text, text, text) IS
  'Token-hash public signature submit. Writes only the matching signer/request. No caller IDs.';

REVOKE ALL ON FUNCTION public.aws_public_signature_submit(text, jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_signature_submit(text, jsonb, text, text, text) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_signature_attach_signed(
  p_token_hash text,
  p_final_rel text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  s public.signature_signers%ROWTYPE;
  r public.signature_requests%ROWTYPE;
  v_canonical text;
  v_rel text;
  v_check_id uuid;
  v_claim_inserted boolean := false;
  v_check_inserted boolean := false;
  v_signed_name text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT * INTO s
  FROM public.signature_signers
  WHERE token_hash = p_token_hash
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT * INTO r
  FROM public.signature_requests
  WHERE id = s.signature_request_id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  IF s.status IS DISTINCT FROM 'signed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_signed');
  END IF;

  v_canonical := public.aws_public_signature_canonical_pdf_path(r.claim_id, r.check_intake_item_id, r.id);
  v_rel := btrim(p_final_rel);
  IF v_canonical IS NULL OR v_rel IS NULL OR v_rel <> v_canonical THEN
    RETURN jsonb_build_object('ok', false, 'error', 'path_mismatch');
  END IF;

  -- Never mutate document_path. Signed output is final_pdf_path only.
  UPDATE public.signature_requests
     SET final_pdf_path = v_canonical,
         completion_status = 'completed',
         last_error = NULL
   WHERE id = r.id;

  v_signed_name := 'SIGNED - ' || COALESCE(r.document_name, 'document');

  IF r.claim_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.claim_files
      WHERE claim_id = r.claim_id AND file_path = v_canonical
    ) THEN
      INSERT INTO public.claim_files (claim_id, file_name, file_path, file_type)
      VALUES (r.claim_id, v_signed_name, v_canonical, 'application/pdf');
      v_claim_inserted := true;
    END IF;
  END IF;

  v_check_id := r.check_intake_item_id;
  IF v_check_id IS NULL AND r.document_path IS NOT NULL THEN
    SELECT cf.check_intake_item_id INTO v_check_id
    FROM public.check_files cf
    WHERE cf.file_path = r.document_path
    LIMIT 1;
  END IF;

  IF v_check_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.check_files
      WHERE signature_request_id = r.id AND category = 'signed_dtp'
    ) THEN
      INSERT INTO public.check_files (
        check_intake_item_id, file_name, file_path, file_type, category, source, signature_request_id
      ) VALUES (
        v_check_id, v_signed_name || '.pdf', v_canonical, 'application/pdf', 'signed_dtp', 'system', r.id
      );
      v_check_inserted := true;
    END IF;
  END IF;

  UPDATE public.loss_draft_documents
     SET is_submitted = true,
         submitted_at = COALESCE(submitted_at, now()),
         signature_status = 'signed',
         signed_at = COALESCE(signed_at, now())
   WHERE signature_request_id = r.id;

  RETURN jsonb_build_object(
    'ok', true,
    'attached', (v_claim_inserted OR v_check_inserted),
    'already_attached', NOT (v_claim_inserted OR v_check_inserted),
    'final_pdf_path', v_canonical,
    'original_path', r.document_path,
    'claim_id', r.claim_id,
    'check_intake_item_id', v_check_id
  );
END;
$$;

COMMENT ON FUNCTION public.aws_public_signature_attach_signed(text, text) IS
  'Token-hash signed-PDF attach. Destination claim/check come from the token-resolved request. p_final_rel must equal the canonical path.';

REVOKE ALL ON FUNCTION public.aws_public_signature_attach_signed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_signature_attach_signed(text, text) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_signature_set_completion_error(
  p_token_hash text,
  p_error text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  s public.signature_signers%ROWTYPE;
  r public.signature_requests%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT * INTO s
  FROM public.signature_signers
  WHERE token_hash = p_token_hash
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT * INTO r
  FROM public.signature_requests
  WHERE id = s.signature_request_id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  UPDATE public.signature_requests
     SET completion_status = 'failed',
         last_error = left(COALESCE(p_error, 'attach_failed'), 180)
   WHERE id = r.id;

  RETURN jsonb_build_object('ok', true, 'request_id', r.id);
END;
$$;

COMMENT ON FUNCTION public.aws_public_signature_set_completion_error(text, text) IS
  'Token-hash completion_status=failed for a failed signed-PDF attach. No other mutations.';

REVOKE ALL ON FUNCTION public.aws_public_signature_set_completion_error(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_signature_set_completion_error(text, text) TO checksops;
