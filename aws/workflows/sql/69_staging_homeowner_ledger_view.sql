-- AWS staging: passwordless homeowner ledger view bundle + sign-link mint.
-- SECURITY DEFINER so public token access does not require Cognito and does not
-- weaken table RLS. Production Supabase unchanged. Do not apply to production-prep.

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_bundle(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  claim_json jsonb;
  events_json jsonb := '[]'::jsonb;
  checks_json jsonb := '[]'::jsonb;
  splits_json jsonb := '[]'::jsonb;
  disb_json jsonb := '[]'::jsonb;
  sig_json jsonb := '[]'::jsonb;
  endo_json jsonb := '[]'::jsonb;
  docs_json jsonb := '[]'::jsonb;
  plan_json jsonb;
  upload_count integer := 0;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 8 THEN
    RETURN jsonb_build_object('error', 'invalid_token');
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

  UPDATE public.homeowner_ledger_tokens
  SET last_viewed_at = now()
  WHERE id = tok.id;

  IF tok.claim_id IS NOT NULL THEN
    SELECT to_jsonb(c) INTO claim_json
    FROM (
      SELECT id, claim_number,
             policyholder_address AS property_address,
             loss_type, status, created_at
      FROM public.claims
      WHERE id = tok.claim_id
    ) c;

    SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at DESC), '[]'::jsonb)
    INTO events_json
    FROM (
      SELECT id, check_id, event_type, occurred_at, amount, actor_label, payload_json
      FROM public.homeowner_ledger_events
      WHERE claim_id = tok.claim_id
      ORDER BY occurred_at DESC
      LIMIT 500
    ) e;

    SELECT COALESCE(jsonb_agg(to_jsonb(ck)), '[]'::jsonb)
    INTO checks_json
    FROM (
      SELECT id, amount, check_stage, check_number
      FROM public.check_intake_items
      WHERE claim_id = tok.claim_id
    ) ck;

    BEGIN
      SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
      INTO splits_json
      FROM (
        SELECT ds.amount, ds.status
        FROM public.disbursement_splits ds
        JOIN public.disbursement_batches db ON db.id = ds.batch_id
        JOIN public.check_intake_items ci ON ci.id = db.check_intake_item_id
        WHERE ci.claim_id = tok.claim_id
      ) s;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      splits_json := '[]'::jsonb;
    END;

    BEGIN
      SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb)
      INTO disb_json
      FROM (
        SELECT amount, status
        FROM public.claim_disbursements
        WHERE claim_id = tok.claim_id
      ) d;
    EXCEPTION WHEN undefined_table THEN
      disb_json := '[]'::jsonb;
    END;

    SELECT COALESCE(jsonb_agg(req), '[]'::jsonb)
    INTO sig_json
    FROM (
      SELECT jsonb_build_object(
        'id', sr.id,
        'document_name', sr.document_name,
        'status', sr.status,
        'sent_at', sr.sent_at,
        'signers', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', ss.id,
            'signer_name', ss.signer_name,
            'signer_email', ss.signer_email,
            'status', ss.status,
            'signed_at', ss.signed_at
          )), '[]'::jsonb)
          FROM public.signature_signers ss
          WHERE ss.signature_request_id = sr.id
        )
      ) AS req
      FROM public.signature_requests sr
      WHERE sr.status IN ('pending', 'sent', 'partial', 'in_progress')
        AND (
          sr.claim_id = tok.claim_id
          OR sr.check_intake_item_id IN (
            SELECT id FROM public.check_intake_items WHERE claim_id = tok.claim_id
          )
        )
      ORDER BY sr.sent_at DESC NULLS LAST
      LIMIT 50
    ) q;

    SELECT COALESCE(jsonb_agg(to_jsonb(en) ORDER BY en.created_at), '[]'::jsonb)
    INTO endo_json
    FROM (
      SELECT ce.id, ce.check_id, ce.payee_name, ce.payee_type, ce.status,
             ce.token, ce.contact_email, ce.signed_at, ce.request_sent_at, ce.created_at
      FROM public.check_endorsements ce
      JOIN public.check_intake_items ci ON ci.id = ce.check_id
      WHERE ci.claim_id = tok.claim_id
        AND ce.payee_type IN ('insured', 'mortgage_company')
    ) en;

    SELECT COALESCE(jsonb_agg(to_jsonb(doc) ORDER BY doc.created_at DESC), '[]'::jsonb)
    INTO docs_json
    FROM (
      SELECT id, file_name, file_path, doc_type, mime_type, file_size, created_at
      FROM public.tenant_documents
      WHERE tenant_id = tok.tenant_id
        AND shared_with_homeowners = true
    ) doc;

    BEGIN
      SELECT to_jsonb(p) INTO plan_json
      FROM (
        SELECT start_window_start, start_window_end, schedule_status, schedule_note,
               share_with_homeowner, updated_at
        FROM public.claim_project_plans
        WHERE claim_id = tok.claim_id
        LIMIT 1
      ) p;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      plan_json := NULL;
    END;
  ELSE
    SELECT count(*)::integer INTO upload_count
    FROM public.homeowner_ledger_check_uploads
    WHERE token_id = tok.id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', tok.tenant_id,
    'token', jsonb_build_object(
      'id', tok.id,
      'claim_id', tok.claim_id,
      'homeowner_email', tok.homeowner_email,
      'homeowner_name', tok.homeowner_name,
      'tenant_id', tok.tenant_id
    ),
    'claim', claim_json,
    'events', events_json,
    'checks', checks_json,
    'splits', splits_json,
    'disbursements', disb_json,
    'signature_requests', sig_json,
    'endorsements', endo_json,
    'documents', docs_json,
    'plan', plan_json,
    'pending_upload_count', upload_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_bundle(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_bundle(text) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_mint_sign_link(
  p_token text,
  p_signer_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  signer_email text;
  signer_status text;
  request_claim uuid;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 8 OR p_signer_id IS NULL OR p_token_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_fields');
  END IF;

  SELECT * INTO tok
  FROM public.homeowner_ledger_tokens
  WHERE token = trim(p_token)
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF tok.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'revoked', 'statusCode', 410);
  END IF;
  IF tok.expires_at IS NOT NULL AND tok.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired', 'statusCode', 410);
  END IF;
  IF tok.claim_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_claim', 'statusCode', 400);
  END IF;

  SELECT ss.signer_email, ss.status, COALESCE(sr.claim_id, ci.claim_id)
    INTO signer_email, signer_status, request_claim
  FROM public.signature_signers ss
  JOIN public.signature_requests sr ON sr.id = ss.signature_request_id
  LEFT JOIN public.check_intake_items ci ON ci.id = sr.check_intake_item_id
  WHERE ss.id = p_signer_id
  LIMIT 1;
  IF request_claim IS NULL AND signer_email IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'signer_not_found', 'statusCode', 404);
  END IF;
  IF request_claim IS DISTINCT FROM tok.claim_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mismatch', 'statusCode', 403);
  END IF;
  IF lower(coalesce(signer_status, '')) = 'signed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_signed', 'statusCode', 409);
  END IF;
  IF tok.homeowner_email IS NULL
     OR lower(trim(tok.homeowner_email)) <> lower(trim(coalesce(signer_email, ''))) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_signature', 'statusCode', 403);
  END IF;

  UPDATE public.signature_signers
  SET token_hash = p_token_hash,
      expires_at = p_expires_at
  WHERE id = p_signer_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_mint_sign_link(text, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_mint_sign_link(text, uuid, text, timestamptz) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_upload_insert(
  p_token text,
  p_front_path text,
  p_amount numeric,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  rec public.homeowner_ledger_check_uploads%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 8 OR p_front_path IS NULL OR length(trim(p_front_path)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_fields');
  END IF;

  SELECT * INTO tok
  FROM public.homeowner_ledger_tokens
  WHERE token = trim(p_token)
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF tok.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'revoked', 'statusCode', 410);
  END IF;
  IF tok.expires_at IS NOT NULL AND tok.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired', 'statusCode', 410);
  END IF;

  INSERT INTO public.homeowner_ledger_check_uploads (
    tenant_id, token_id, claim_id, front_path, status, amount_estimate, homeowner_note, created_at
  ) VALUES (
    tok.tenant_id, tok.id, tok.claim_id, p_front_path, 'pending_review', p_amount, p_note, now()
  )
  RETURNING * INTO rec;

  RETURN jsonb_build_object(
    'ok', true,
    'id', rec.id,
    'token_id', rec.token_id,
    'claim_id', rec.claim_id,
    'tenant_id', rec.tenant_id,
    'front_path', rec.front_path,
    'status', rec.status,
    'created_at', rec.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_upload_insert(text, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_upload_insert(text, text, numeric, text) TO checksops;
