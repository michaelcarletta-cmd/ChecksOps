-- AWS staging: Class A app-service grants + public token SECURITY DEFINER helpers.
-- Does NOT apply financial activation. Production Supabase unchanged.

-- Email audit / compliance tables for staging SES/sink mailer
GRANT SELECT, INSERT, UPDATE ON TABLE public.email_send_log TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.suppressed_emails TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.email_unsubscribe_tokens TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tenant_email_settings TO checksops;

-- HomeownerOps token / upload metadata
GRANT SELECT, INSERT, UPDATE ON TABLE public.homeowner_ledger_tokens TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.homeowner_check_uploads TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.homeowner_ledger_check_uploads TO checksops;
GRANT SELECT ON TABLE public.homeowner_intro_requests TO checksops;
GRANT UPDATE ON TABLE public.homeowner_intro_requests TO checksops;

-- OCR descriptive commits (amount may be written to intake; not payment execution)
GRANT EXECUTE ON FUNCTION public.ocr_commit_results TO checksops;

-- ---------------------------------------------------------------------------
-- Public ledger view by magic-link token (no Cognito). SECURITY DEFINER.
-- Returns token metadata + claim summary + timeline (amounts visible for display
-- only; no payment execution).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  claim_json jsonb;
  events_json jsonb;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 8 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO tok
  FROM public.homeowner_ledger_tokens
  WHERE token = trim(p_token)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
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
  ELSE
    claim_json := NULL;
    events_json := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'token', jsonb_build_object(
      'id', tok.id,
      'tenant_id', tok.tenant_id,
      'claim_id', tok.claim_id,
      'homeowner_email', tok.homeowner_email,
      'homeowner_name', tok.homeowner_name
    ),
    'claim', claim_json,
    'events', events_json,
    -- Financial CTAs stay disabled on AWS staging
    'allow_deductible_payment', false,
    'money', NULL,
    'deductible_payments', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) TO checksops;

-- ---------------------------------------------------------------------------
-- Public claim portal lead lookup by access_token
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_public_homeowner_claim_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lead public.homeowner_intro_requests%ROWTYPE;
  profile_json jsonb;
  uploads_json jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{32,80}$' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO lead
  FROM public.homeowner_intro_requests
  WHERE access_token = p_token
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT to_jsonb(p) INTO profile_json
  FROM (
    SELECT id, display_name, bio, tier, is_directory_listed, directory_opt_in, user_id
    FROM public.contractor_profiles
    WHERE id = lead.contractor_profile_id
  ) p;

  SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.created_at DESC), '[]'::jsonb)
  INTO uploads_json
  FROM (
    SELECT id, file_path, status, note, created_at
    FROM public.homeowner_check_uploads
    WHERE lead_id = lead.id
    ORDER BY created_at DESC
    LIMIT 50
  ) u;

  RETURN jsonb_build_object(
    'ok', true,
    'lead', to_jsonb(lead),
    'contractor', profile_json,
    'uploads', uploads_json,
    'pending', NOT (lead.status = 'accepted' AND lead.accepted_at IS NOT NULL),
    'allow_deductible_payment', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_claim_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_claim_by_token(text) TO checksops;

-- ---------------------------------------------------------------------------
-- Public homeowner check upload insert (token already validated in API).
-- Writes metadata only — no payment execution.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_public_homeowner_check_upload_insert(
  p_lead_id uuid,
  p_contractor_profile_id uuid,
  p_contractor_user_id uuid,
  p_homeowner_email text,
  p_homeowner_user_id uuid,
  p_file_path text,
  p_file_mime text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF p_contractor_profile_id IS NULL OR p_file_path IS NULL OR length(trim(p_file_path)) < 3 THEN
    RETURN jsonb_build_object('error', 'invalid_args');
  END IF;
  IF p_homeowner_email IS NULL OR position('@' in p_homeowner_email) = 0 THEN
    RETURN jsonb_build_object('error', 'invalid_email');
  END IF;

  INSERT INTO public.homeowner_check_uploads (
    lead_id, contractor_profile_id, contractor_user_id, homeowner_email, homeowner_user_id,
    file_path, file_mime, note, status, created_at
  ) VALUES (
    p_lead_id, p_contractor_profile_id, p_contractor_user_id, lower(trim(p_homeowner_email)),
    p_homeowner_user_id, p_file_path, p_file_mime, p_note, 'uploaded', now()
  )
  RETURNING id INTO new_id;

  RETURN jsonb_build_object('ok', true, 'id', new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_check_upload_insert(
  uuid, uuid, uuid, text, uuid, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_check_upload_insert(
  uuid, uuid, uuid, text, uuid, text, text, text
) TO checksops;
