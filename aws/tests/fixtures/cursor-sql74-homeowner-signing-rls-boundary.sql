-- AWS staging: Homeowner signing RLS boundary repair (SQL 74).
-- Sibling SECURITY DEFINER readers/doorways for check endorsement and
-- Signature Request attach. Does NOT rewrite SQL 71, 72, or 73.
-- Does NOT rewrite historical aws/workflows/sql/71_homeowner_ledger_view_contract.sql.
-- Does NOT rewrite historical aws/workflows/sql/72_homeowner_ledger_view_claim_ok.sql.
-- Does NOT rewrite historical aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql.
-- Does NOT rewrite historical aws/workflows/sql/68_staging_class_a_grants.sql.
-- Does NOT apply financial activation, Cognito, RLS broadening, or production.
-- Does NOT rotate signature_signers.token_hash or invalidate emailed /sign links.
--
-- Isolation: ledger token → exact tenant + claim. Fail closed on
-- invalid / revoked / expired / mismatched-tenant / mismatched-claim.
-- claim_ok is copied exactly from SQL 73 / SQL 72. Do not edit SQL 73.
--
-- Endorse doorway: exact check + exact open insured endorsement.
-- Fail closed for mortgage/contractor/PA/other, signed/completed/
-- cancelled/revoked, and unmatched multiple insureds.
-- Mint check_endorsements.token only when empty. Return that token
-- only to the Homeowner doorway, never to the ledger view.
--
-- Document attach: outstanding Signature Request + outstanding signer
-- with role policyholder|insured|homeowner, matched to this homeowner
-- by email, name, or unambiguous sole homeowner-type fallback.
-- Supports claim-only requests (null check_intake_item_id).
-- Never returns access_token, token_hash, or unrelated signer secrets.
--
-- Document doorway: reuse existing access_token only when it is still
-- a safe hex capability. Otherwise existing_email_link_required.
-- Never UPDATE signature_signers.

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_endorse_capability(
  p_token text,
  p_endorsement_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  claim_ok boolean := false;
  homeowner_email_lc text;
  homeowner_name_lc text;
  rec record;
  open_insured_count integer := 0;
  email_hit boolean := false;
  name_hit boolean := false;
  identity_ok boolean := false;
  endorse_token text;
  status_lc text;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 8 OR p_endorsement_id IS NULL THEN
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
    RETURN jsonb_build_object('ok', false, 'error', 'revoked');
  END IF;
  IF tok.expires_at IS NOT NULL AND tok.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;
  IF tok.claim_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_claim');
  END IF;

  -- Fail closed: claim must exist and the token tenant must be bound to
  -- that exact claim. org_id match is sufficient. A different non-null
  -- org_id does not override an exact same-tenant check or ledger event.
  SELECT EXISTS (
    SELECT 1
    FROM public.claims c
    WHERE c.id = tok.claim_id
      AND (
        c.org_id = tok.tenant_id
        OR EXISTS (
          SELECT 1
          FROM public.check_intake_items i
          WHERE i.claim_id = tok.claim_id
            AND i.tenant_id = tok.tenant_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.homeowner_ledger_events e
          WHERE e.claim_id = tok.claim_id
            AND e.tenant_id = tok.tenant_id
        )
      )
  ) INTO claim_ok;

  IF NOT claim_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  homeowner_email_lc := lower(trim(COALESCE(tok.homeowner_email, '')));
  homeowner_name_lc := lower(trim(COALESCE(tok.homeowner_name, '')));

  SELECT
    e.id,
    e.check_id,
    e.payee_name,
    e.payee_type,
    e.status,
    e.token,
    e.contact_email,
    e.signed_at,
    e.tenant_id,
    i.tenant_id AS check_tenant_id,
    i.claim_id AS check_claim_id
  INTO rec
  FROM public.check_endorsements e
  JOIN public.check_intake_items i
    ON i.id = e.check_id
  WHERE e.id = p_endorsement_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF rec.check_tenant_id IS DISTINCT FROM tok.tenant_id
     OR rec.check_claim_id IS DISTINCT FROM tok.claim_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF rec.tenant_id IS NOT NULL AND rec.tenant_id IS DISTINCT FROM tok.tenant_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF rec.payee_type IS DISTINCT FROM 'insured' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_signature');
  END IF;

  status_lc := lower(COALESCE(rec.status, ''));
  IF rec.signed_at IS NOT NULL OR status_lc IN (
    'signed', 'waived', 'endorsed', 'completed', 'complete'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_signed');
  END IF;
  IF status_lc IN (
    'cancelled', 'canceled', 'rejected', 'revoked', 'expired', 'voided'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state');
  END IF;

  SELECT COUNT(*)::integer
    INTO open_insured_count
    FROM public.check_endorsements e2
    JOIN public.check_intake_items i2
      ON i2.id = e2.check_id
     AND i2.claim_id = tok.claim_id
     AND i2.tenant_id = tok.tenant_id
   WHERE e2.check_id = rec.check_id
     AND (e2.tenant_id IS NULL OR e2.tenant_id = tok.tenant_id)
     AND e2.payee_type = 'insured'
     AND e2.signed_at IS NULL
     AND lower(COALESCE(e2.status, '')) NOT IN (
       'signed', 'waived', 'endorsed', 'completed', 'complete',
       'cancelled', 'canceled', 'rejected', 'revoked', 'expired', 'voided'
     );

  email_hit := homeowner_email_lc <> ''
    AND lower(COALESCE(rec.contact_email, '')) = homeowner_email_lc;
  name_hit := homeowner_name_lc <> ''
    AND EXISTS (
      SELECT 1
      FROM unnest(regexp_split_to_array(homeowner_name_lc, '\s+')) AS part
      WHERE length(part) >= 3
        AND strpos(lower(COALESCE(rec.payee_name, '')), part) > 0
    );
  identity_ok := email_hit OR name_hit OR open_insured_count = 1;
  IF NOT identity_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_signature');
  END IF;

  endorse_token := trim(COALESCE(rec.token, ''));
  IF endorse_token = '' THEN
    endorse_token := gen_random_uuid()::text;
    UPDATE public.check_endorsements
       SET token = endorse_token
     WHERE id = rec.id
       AND (token IS NULL OR token = '');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'endorsement_id', rec.id,
    'check_id', rec.check_id,
    'endorse_token', endorse_token
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_pending_signatures(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  claim_ok boolean := false;
  homeowner_email_lc text;
  homeowner_name_lc text;
  requests_json jsonb;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 8 THEN
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
    RETURN jsonb_build_object('ok', false, 'error', 'revoked');
  END IF;
  IF tok.expires_at IS NOT NULL AND tok.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;
  IF tok.claim_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'requests', '[]'::jsonb);
  END IF;

  -- Fail closed: claim must exist and the token tenant must be bound to
  -- that exact claim. org_id match is sufficient. A different non-null
  -- org_id does not override an exact same-tenant check or ledger event.
  SELECT EXISTS (
    SELECT 1
    FROM public.claims c
    WHERE c.id = tok.claim_id
      AND (
        c.org_id = tok.tenant_id
        OR EXISTS (
          SELECT 1
          FROM public.check_intake_items i
          WHERE i.claim_id = tok.claim_id
            AND i.tenant_id = tok.tenant_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.homeowner_ledger_events e
          WHERE e.claim_id = tok.claim_id
            AND e.tenant_id = tok.tenant_id
        )
      )
  ) INTO claim_ok;

  IF NOT claim_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  homeowner_email_lc := lower(trim(COALESCE(tok.homeowner_email, '')));
  homeowner_name_lc := lower(trim(COALESCE(tok.homeowner_name, '')));

  WITH scoped AS (
    SELECT
      r.id AS request_id,
      r.document_name,
      r.status AS request_status,
      r.sent_at,
      r.created_at,
      r.completed_at,
      s.id AS signer_id,
      s.signer_name,
      s.signer_email,
      s.signer_type,
      s.status AS signer_status,
      s.signed_at,
      s.signing_order,
      s.expires_at
    FROM public.signature_requests r
    JOIN public.signature_signers s
      ON s.signature_request_id = r.id
    LEFT JOIN public.check_intake_items i
      ON i.id = r.check_intake_item_id
    WHERE (
        (r.check_intake_item_id IS NULL AND r.claim_id = tok.claim_id)
        OR (
          r.check_intake_item_id IS NOT NULL
          AND i.id IS NOT NULL
          AND i.claim_id = tok.claim_id
          AND i.tenant_id = tok.tenant_id
        )
      )
      AND lower(COALESCE(r.status, '')) IN ('pending', 'sent', 'partial', 'in_progress')
      AND r.completed_at IS NULL
      AND lower(COALESCE(s.signer_type, '')) IN ('policyholder', 'insured', 'homeowner')
  ),
  counted AS (
    SELECT
      scoped.*,
      COUNT(*) FILTER (
        WHERE lower(COALESCE(scoped.signer_type, '')) IN ('policyholder', 'insured', 'homeowner')
      ) OVER (PARTITION BY scoped.request_id) AS homeowner_signer_count
    FROM scoped
  ),
  annotated AS (
    SELECT
      counted.*,
      (
        (homeowner_email_lc <> '' AND lower(COALESCE(counted.signer_email, '')) = homeowner_email_lc)
        OR (
          homeowner_name_lc <> ''
          AND EXISTS (
            SELECT 1
            FROM unnest(regexp_split_to_array(homeowner_name_lc, '\s+')) AS part
            WHERE length(part) >= 3
              AND strpos(lower(COALESCE(counted.signer_name, '')), part) > 0
          )
        )
        OR counted.homeowner_signer_count = 1
      ) AS is_homeowner,
      (
        counted.signed_at IS NULL
        AND lower(COALESCE(counted.signer_status, '')) NOT IN (
          'signed', 'completed', 'complete',
          'cancelled', 'canceled', 'revoked', 'expired', 'voided', 'rejected'
        )
        AND (counted.expires_at IS NULL OR counted.expires_at >= now())
      ) AS signer_open
    FROM counted
  ),
  with_can AS (
    SELECT
      annotated.*,
      (
        annotated.is_homeowner
        AND annotated.signer_open
        AND NOT EXISTS (
          SELECT 1
          FROM public.signature_signers prior
          WHERE prior.signature_request_id = annotated.request_id
            AND prior.id IS DISTINCT FROM annotated.signer_id
            AND COALESCE(prior.signing_order, 1) < COALESCE(annotated.signing_order, 1)
            AND prior.signed_at IS NULL
            AND lower(COALESCE(prior.status, '')) NOT IN (
              'signed', 'completed', 'complete',
              'cancelled', 'canceled', 'revoked', 'expired', 'voided', 'rejected'
            )
            AND (prior.expires_at IS NULL OR prior.expires_at >= now())
        )
      ) AS can_sign
    FROM annotated
  )
  SELECT COALESCE(jsonb_agg(request_row ORDER BY request_row->>'sent_at' DESC NULLS LAST), '[]'::jsonb)
    INTO requests_json
  FROM (
    SELECT jsonb_build_object(
      'request_id', grouped.request_id,
      'document_name', grouped.document_name,
      'status', grouped.request_status,
      'sent_at', grouped.sent_at,
      'created_at', grouped.created_at,
      'signers', grouped.signers
    ) AS request_row
    FROM (
      SELECT
        with_can.request_id,
        min(with_can.document_name) AS document_name,
        min(with_can.request_status) AS request_status,
        min(with_can.sent_at) AS sent_at,
        min(with_can.created_at) AS created_at,
        jsonb_agg(
          jsonb_build_object(
            'signer_id', with_can.signer_id,
            'signer_name', with_can.signer_name,
            'signer_email', with_can.signer_email,
            'signer_type', with_can.signer_type,
            'status', with_can.signer_status,
            'signed_at', with_can.signed_at,
            'signing_order', with_can.signing_order,
            'is_homeowner', with_can.is_homeowner,
            'can_sign', with_can.can_sign
          )
          ORDER BY with_can.signing_order ASC, with_can.signer_id ASC
        ) AS signers
      FROM with_can
      GROUP BY with_can.request_id
    ) grouped
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(grouped.signers) AS signer
      WHERE (signer->>'is_homeowner')::boolean
        AND (signer->>'can_sign')::boolean
    )
  ) listed;

  RETURN jsonb_build_object('ok', true, 'requests', COALESCE(requests_json, '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_document_sign_capability(
  p_token text,
  p_signer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  claim_ok boolean := false;
  homeowner_email_lc text;
  homeowner_name_lc text;
  rec record;
  homeowner_signer_count integer := 0;
  email_hit boolean := false;
  name_hit boolean := false;
  identity_ok boolean := false;
  request_status_lc text;
  signer_status_lc text;
  order_blocked boolean := false;
  access_raw text;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 8 OR p_signer_id IS NULL THEN
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
    RETURN jsonb_build_object('ok', false, 'error', 'revoked');
  END IF;
  IF tok.expires_at IS NOT NULL AND tok.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;
  IF tok.claim_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_claim');
  END IF;

  -- Fail closed: claim must exist and the token tenant must be bound to
  -- that exact claim. org_id match is sufficient. A different non-null
  -- org_id does not override an exact same-tenant check or ledger event.
  SELECT EXISTS (
    SELECT 1
    FROM public.claims c
    WHERE c.id = tok.claim_id
      AND (
        c.org_id = tok.tenant_id
        OR EXISTS (
          SELECT 1
          FROM public.check_intake_items i
          WHERE i.claim_id = tok.claim_id
            AND i.tenant_id = tok.tenant_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.homeowner_ledger_events e
          WHERE e.claim_id = tok.claim_id
            AND e.tenant_id = tok.tenant_id
        )
      )
  ) INTO claim_ok;

  IF NOT claim_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  homeowner_email_lc := lower(trim(COALESCE(tok.homeowner_email, '')));
  homeowner_name_lc := lower(trim(COALESCE(tok.homeowner_name, '')));

  SELECT
    s.id,
    s.signer_name,
    s.signer_email,
    s.signer_type,
    s.status,
    s.signed_at,
    s.signing_order,
    s.expires_at,
    s.access_token,
    r.id AS request_id,
    r.status AS request_status,
    r.completed_at,
    r.claim_id,
    r.check_intake_item_id,
    i.tenant_id AS check_tenant_id,
    i.claim_id AS check_claim_id
  INTO rec
  FROM public.signature_signers s
  JOIN public.signature_requests r
    ON r.id = s.signature_request_id
  LEFT JOIN public.check_intake_items i
    ON i.id = r.check_intake_item_id
  WHERE s.id = p_signer_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF rec.check_intake_item_id IS NULL THEN
    IF rec.claim_id IS DISTINCT FROM tok.claim_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
  ELSE
    IF rec.check_tenant_id IS DISTINCT FROM tok.tenant_id
       OR rec.check_claim_id IS DISTINCT FROM tok.claim_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
  END IF;

  IF lower(COALESCE(rec.signer_type, '')) NOT IN ('policyholder', 'insured', 'homeowner') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_signature');
  END IF;

  SELECT COUNT(*)::integer
    INTO homeowner_signer_count
    FROM public.signature_signers s2
   WHERE s2.signature_request_id = rec.request_id
     AND lower(COALESCE(s2.signer_type, '')) IN ('policyholder', 'insured', 'homeowner');

  email_hit := homeowner_email_lc <> ''
    AND lower(COALESCE(rec.signer_email, '')) = homeowner_email_lc;
  name_hit := homeowner_name_lc <> ''
    AND EXISTS (
      SELECT 1
      FROM unnest(regexp_split_to_array(homeowner_name_lc, '\s+')) AS part
      WHERE length(part) >= 3
        AND strpos(lower(COALESCE(rec.signer_name, '')), part) > 0
    );
  identity_ok := email_hit OR name_hit OR homeowner_signer_count = 1;
  IF NOT identity_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_signature');
  END IF;

  request_status_lc := lower(COALESCE(rec.request_status, ''));
  IF rec.completed_at IS NOT NULL OR request_status_lc IN (
    'cancelled', 'canceled', 'revoked', 'expired', 'completed', 'complete',
    'failed', 'voided'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state');
  END IF;
  IF request_status_lc NOT IN ('pending', 'sent', 'partial', 'in_progress', '') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state');
  END IF;

  signer_status_lc := lower(COALESCE(rec.status, ''));
  IF rec.signed_at IS NOT NULL OR signer_status_lc IN ('signed', 'completed', 'complete') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_signed');
  END IF;
  IF signer_status_lc IN (
    'cancelled', 'canceled', 'revoked', 'expired', 'voided', 'rejected'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state');
  END IF;
  IF rec.expires_at IS NOT NULL AND rec.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.signature_signers prior
    WHERE prior.signature_request_id = rec.request_id
      AND prior.id IS DISTINCT FROM rec.id
      AND COALESCE(prior.signing_order, 1) < COALESCE(rec.signing_order, 1)
      AND prior.signed_at IS NULL
      AND lower(COALESCE(prior.status, '')) NOT IN (
        'signed', 'completed', 'complete',
        'cancelled', 'canceled', 'revoked', 'expired', 'voided', 'rejected'
      )
      AND (prior.expires_at IS NULL OR prior.expires_at >= now())
  ) INTO order_blocked;
  IF order_blocked THEN
    RETURN jsonb_build_object('ok', false, 'error', 'signer_order_blocked');
  END IF;

  access_raw := trim(COALESCE(rec.access_token, ''));
  IF access_raw = ''
     OR position('://' in access_raw) > 0
     OR position('//' in access_raw) > 0
     OR position(E'\\' in access_raw) > 0
     OR position('..' in access_raw) > 0
     OR access_raw !~ '^[A-Fa-f0-9]{32,}$' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'existing_email_link_required',
      'request_id', rec.request_id,
      'signer_id', rec.id
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'request_id', rec.request_id,
    'signer_id', rec.id,
    'access_token', access_raw,
    'reused_existing_access_token', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid) TO checksops;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_pending_signatures(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_public_homeowner_pending_signatures(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_pending_signatures(text) TO checksops;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_document_sign_capability(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_public_homeowner_document_sign_capability(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_document_sign_capability(text, uuid) TO checksops;
