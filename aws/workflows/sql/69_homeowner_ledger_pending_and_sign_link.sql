-- AWS staging: HomeownerOps ledger pending-signatures + Sign Now remint.
-- Additive only. Does not change aws_public_signature_* write helpers.
-- Production Supabase unchanged.

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
  pending_json jsonb;
  totals_json jsonb;
  received_amt numeric := 0;
  deposited_amt numeric := 0;
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

    SELECT COALESCE(SUM(amount), 0),
           COALESCE(SUM(amount) FILTER (
             WHERE lower(COALESCE(check_stage::text, '')) IN (
               'deposited', 'cleared', 'funds_released', 'disbursed'
             )
           ), 0)
      INTO received_amt, deposited_amt
    FROM public.check_intake_items
    WHERE claim_id = tok.claim_id;

    SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.sent_at DESC NULLS LAST), '[]'::jsonb)
      INTO pending_json
    FROM (
      SELECT r.id AS request_id,
             r.document_name,
             r.sent_at,
             (
               SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'signer_id', s.id,
                 'name', s.signer_name,
                 'email', s.signer_email,
                 'status', s.status,
                 'signed_at', s.signed_at,
                 'is_homeowner', lower(COALESCE(s.signer_email, '')) = lower(COALESCE(tok.homeowner_email, ''))
               ) ORDER BY s.signing_order, s.created_at), '[]'::jsonb)
               FROM public.signature_signers s
               WHERE s.signature_request_id = r.id
             ) AS signers
      FROM public.signature_requests r
      WHERE r.status IN ('pending', 'sent', 'partial', 'in_progress')
        AND (
          r.claim_id = tok.claim_id
          OR r.check_intake_item_id IN (
            SELECT cii.id FROM public.check_intake_items cii WHERE cii.claim_id = tok.claim_id
          )
        )
        AND EXISTS (
          SELECT 1
          FROM public.signature_signers hs
          WHERE hs.signature_request_id = r.id
            AND lower(COALESCE(hs.signer_email, '')) = lower(COALESCE(tok.homeowner_email, ''))
            AND COALESCE(hs.status, '') IS DISTINCT FROM 'signed'
        )
      ORDER BY r.sent_at DESC NULLS LAST
      LIMIT 50
    ) p;
  ELSE
    claim_json := NULL;
    events_json := '[]'::jsonb;
    pending_json := '[]'::jsonb;
  END IF;

  totals_json := jsonb_build_object(
    'received', COALESCE(received_amt, 0),
    'deposited', COALESCE(deposited_amt, 0),
    'released', 0,
    'remaining', GREATEST(0, COALESCE(received_amt, 0))
  );

  RETURN jsonb_build_object(
    'ok', true,
    'mode', CASE WHEN tok.claim_id IS NOT NULL THEN 'claim' ELSE 'pre_claim' END,
    'homeowner', jsonb_build_object(
      'name', tok.homeowner_name,
      'email', tok.homeowner_email
    ),
    'token', jsonb_build_object(
      'id', tok.id,
      'tenant_id', tok.tenant_id,
      'claim_id', tok.claim_id,
      'homeowner_email', tok.homeowner_email,
      'homeowner_name', tok.homeowner_name
    ),
    'claim', claim_json,
    'events', events_json,
    'totals', totals_json,
    'pending_signatures', COALESCE(pending_json, '[]'::jsonb),
    'pending_upload_count', 0,
    'can_upload', true,
    'allow_deductible_payment', false,
    'money', NULL,
    'deductible_payments', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_remint_signer(
  p_token text,
  p_signer_id uuid,
  p_token_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  rec record;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 8 THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF p_signer_id IS NULL THEN
    RETURN jsonb_build_object('error', 'signer_not_found');
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('error', 'invalid_hash');
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
  IF tok.claim_id IS NULL THEN
    RETURN jsonb_build_object('error', 'no_claim');
  END IF;

  SELECT s.id,
         s.signer_email,
         s.status AS signer_status,
         r.id AS request_id,
         r.claim_id,
         r.check_intake_item_id,
         r.status AS request_status
    INTO rec
  FROM public.signature_signers s
  JOIN public.signature_requests r ON r.id = s.signature_request_id
  WHERE s.id = p_signer_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'signer_not_found');
  END IF;

  IF rec.signer_status = 'signed' THEN
    RETURN jsonb_build_object('error', 'already_signed');
  END IF;
  IF rec.request_status IS NULL OR rec.request_status NOT IN ('pending', 'sent', 'partial', 'in_progress') THEN
    RETURN jsonb_build_object('error', 'invalid_state');
  END IF;

  IF rec.claim_id IS NOT NULL AND rec.claim_id IS DISTINCT FROM tok.claim_id THEN
    RETURN jsonb_build_object('error', 'mismatch');
  END IF;
  IF rec.claim_id IS NULL THEN
    IF rec.check_intake_item_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.check_intake_items cii
      WHERE cii.id = rec.check_intake_item_id
        AND cii.claim_id = tok.claim_id
    ) THEN
      RETURN jsonb_build_object('error', 'mismatch');
    END IF;
  END IF;

  IF lower(COALESCE(rec.signer_email, '')) IS DISTINCT FROM lower(COALESCE(tok.homeowner_email, '')) THEN
    RETURN jsonb_build_object('error', 'not_your_signature');
  END IF;

  UPDATE public.signature_signers
     SET token_hash = p_token_hash,
         expires_at = now() + interval '72 hours',
         access_token = ''
   WHERE id = rec.id;

  RETURN jsonb_build_object(
    'ok', true,
    'signer_id', rec.id,
    'request_id', rec.request_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_remint_signer(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_remint_signer(text, uuid, text) TO checksops;
