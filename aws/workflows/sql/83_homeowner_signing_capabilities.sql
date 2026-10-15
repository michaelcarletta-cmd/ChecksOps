-- AWS: Homeowner signing capabilities (SQL 83).
-- Sibling SECURITY DEFINER readers/doorways for check endorsement and
-- Signature Request attach. Does NOT rewrite SQL 82.
-- Does NOT rewrite historical aws/workflows/sql/82_homeowner_ledger_view.sql.
-- Does NOT rewrite historical aws/workflows/sql/68_staging_class_a_grants.sql.
-- Does NOT apply financial activation, Cognito, RLS broadening, or production.
-- Does NOT rotate signature_signers.token_hash or invalidate emailed /sign links.
--
-- Provenance: the staging Homeowner Ops signing doorway (Cursor branch
-- SQL 74), renumbered to 83 to follow main's 81_checkalt_production_register.sql.
-- First security change from that body: claim-only Signature Requests
-- (null check_intake_item_id) must also be on a claim whose org_id is the
-- token tenant (or null). SQL 74 accepted any claim-only request on the
-- token claim, even when claim_ok held only through a same-tenant check
-- or event on a claim another tenant owns.
-- Second change: a name match requires the token's homeowner name to have
-- at least two parts of 2+ letters, each a whole word of payee_name /
-- signer_name (same rule as SQL 82). SQL 74 accepted any one 3+ letter
-- part as a substring, so a co-insured sharing only a surname could mint
-- the other insured's /endorse or /sign link.
-- Third change (review of PR #989): the sole-insured / sole-signer
-- fallback counts every insured endorsement (any status) and applies only
-- when neither the contact/signer email nor the payee/signer name
-- contradicts the token; the endorse doorway accepts only status 'sent'
-- and mints under FOR UPDATE; the document doorway and reader accept only
-- request status pending|in_progress and signer status pending; an
-- org-less claim's claim-only request needs no other tenant's check on it.
--
-- Isolation: ledger token → exact tenant + claim. Fail closed on
-- invalid / revoked / expired / mismatched-tenant / mismatched-claim.
-- claim_ok is copied exactly from SQL 82. Do not edit SQL 82.
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
  insured_count integer := 0;
  email_hit boolean := false;
  name_hit boolean := false;
  email_conflict boolean := false;
  name_conflict boolean := false;
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
  LIMIT 1
  -- Lock the endorsement so a concurrent mint waits and then reads the
  -- stored token instead of returning one that was never written.
  FOR UPDATE OF e;

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
  -- Allow-list: only an endorsement staff actually requested. Both send
  -- paths (check-endorsement send and the Supabase sender) set 'sent' with
  -- request_sent_at; 'pending' is created-but-not-requested and
  -- 'manual_required' is handled outside the portal.
  IF status_lc <> 'sent' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state');
  END IF;

  -- Every insured endorsement on the check, any status: once one co-insured
  -- signs, the other does not become the "sole" insured.
  SELECT COUNT(*)::integer
    INTO insured_count
    FROM public.check_endorsements e2
    JOIN public.check_intake_items i2
      ON i2.id = e2.check_id
     AND i2.claim_id = tok.claim_id
     AND i2.tenant_id = tok.tenant_id
   WHERE e2.check_id = rec.check_id
     AND (e2.tenant_id IS NULL OR e2.tenant_id = tok.tenant_id)
     AND e2.payee_type = 'insured';

  email_hit := homeowner_email_lc <> ''
    AND lower(trim(COALESCE(rec.contact_email, ''))) = homeowner_email_lc;
  email_conflict := homeowner_email_lc <> ''
    AND lower(trim(COALESCE(rec.contact_email, ''))) <> ''
    AND lower(trim(COALESCE(rec.contact_email, ''))) <> homeowner_email_lc;
  name_hit := homeowner_name_lc <> ''
    AND (
      -- SQL 83: the homeowner name needs at least two parts of 2+ letters,
      -- and every one must be a whole word of the name. A shared surname
      -- alone, or a substring such as 'ada' in 'adam', is not a match.
      (
        SELECT count(*)
        FROM unnest(regexp_split_to_array(homeowner_name_lc, '[^a-z0-9]+')) AS part
        WHERE length(part) >= 2
      ) >= 2
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(regexp_split_to_array(homeowner_name_lc, '[^a-z0-9]+')) AS part
        WHERE length(part) >= 2
          AND NOT (part = ANY (regexp_split_to_array(lower(COALESCE(rec.payee_name, '')), '[^a-z0-9]+')))
      )
    );
  name_hit := COALESCE(name_hit, false);
  name_conflict := trim(COALESCE(rec.payee_name, '')) <> '' AND NOT name_hit;
  -- The sole-insured fallback applies only when nothing contradicts it.
  identity_ok := email_hit OR name_hit
    OR (insured_count = 1 AND NOT email_conflict AND NOT name_conflict);
  IF NOT identity_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_signature');
  END IF;

  endorse_token := trim(COALESCE(rec.token, ''));
  IF endorse_token = '' THEN
    UPDATE public.check_endorsements
       SET token = gen_random_uuid()::text
     WHERE id = rec.id
       AND (token IS NULL OR trim(token) = '')
    RETURNING token INTO endorse_token;
    IF endorse_token IS NULL THEN
      SELECT trim(COALESCE(token, '')) INTO endorse_token
        FROM public.check_endorsements
       WHERE id = rec.id;
    END IF;
  END IF;
  IF COALESCE(endorse_token, '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
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
        (
          r.check_intake_item_id IS NULL
          AND r.claim_id = tok.claim_id
          -- SQL 83 security change: a claim-only request carries no tenant.
          -- Bind it to the token tenant through claims.org_id so a token
          -- authorized by a same-tenant check/event on a claim another
          -- tenant owns cannot read that tenant's claim-only requests. An
          -- org-less claim qualifies only when no other tenant has a check
          -- on it.
          AND EXISTS (
            SELECT 1
            FROM public.claims rc
            WHERE rc.id = r.claim_id
              AND (
                rc.org_id = tok.tenant_id
                OR (
                  rc.org_id IS NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM public.check_intake_items oi
                    WHERE oi.claim_id = rc.id
                      AND oi.tenant_id IS DISTINCT FROM tok.tenant_id
                  )
                )
              )
          )
        )
        OR (
          r.check_intake_item_id IS NOT NULL
          AND i.id IS NOT NULL
          AND i.claim_id = tok.claim_id
          AND i.tenant_id = tok.tenant_id
        )
      )
      -- Allow-list of open request statuses (signature_requests.valid_status).
      AND lower(trim(COALESCE(r.status, ''))) IN ('pending', 'in_progress')
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
  matched AS (
    SELECT
      counted.*,
      (
        homeowner_email_lc <> ''
        AND lower(trim(COALESCE(counted.signer_email, ''))) = homeowner_email_lc
      ) AS email_hit,
      (
        homeowner_email_lc <> ''
        AND lower(trim(COALESCE(counted.signer_email, ''))) <> ''
        AND lower(trim(COALESCE(counted.signer_email, ''))) <> homeowner_email_lc
      ) AS email_conflict,
      (
        homeowner_name_lc <> ''
        AND (
          -- SQL 83: the homeowner name needs at least two parts of 2+ letters,
          -- and every one must be a whole word of the name. A shared surname
          -- alone, or a substring such as 'ada' in 'adam', is not a match.
          (
            SELECT count(*)
            FROM unnest(regexp_split_to_array(homeowner_name_lc, '[^a-z0-9]+')) AS part
            WHERE length(part) >= 2
          ) >= 2
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(regexp_split_to_array(homeowner_name_lc, '[^a-z0-9]+')) AS part
            WHERE length(part) >= 2
              AND NOT (part = ANY (regexp_split_to_array(lower(COALESCE(counted.signer_name, '')), '[^a-z0-9]+')))
          )
        )
      ) AS name_hit
    FROM counted
  ),
  annotated AS (
    SELECT
      matched.*,
      (
        matched.email_hit
        OR matched.name_hit
        -- Sole homeowner-type signer fallback only when nothing contradicts it.
        OR (
          matched.homeowner_signer_count = 1
          AND NOT matched.email_conflict
          AND NOT (trim(COALESCE(matched.signer_name, '')) <> '' AND NOT matched.name_hit)
        )
      ) AS is_homeowner,
      (
        matched.signed_at IS NULL
        -- Allow-list: signature_signers.valid_signer_status open value.
        AND lower(trim(COALESCE(matched.signer_status, ''))) = 'pending'
        AND (matched.expires_at IS NULL OR matched.expires_at >= now())
      ) AS signer_open
    FROM matched
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
            AND lower(trim(COALESCE(prior.status, ''))) = 'pending'
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
  email_conflict boolean := false;
  name_conflict boolean := false;
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
    -- SQL 83 security change: claim-only requests are bound to the token
    -- tenant through claims.org_id; an org-less claim qualifies only when no
    -- other tenant has a check on it (same rule as pending_signatures).
    IF NOT EXISTS (
      SELECT 1
      FROM public.claims rc
      WHERE rc.id = rec.claim_id
        AND (
          rc.org_id = tok.tenant_id
          OR (
            rc.org_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM public.check_intake_items oi
              WHERE oi.claim_id = rc.id
                AND oi.tenant_id IS DISTINCT FROM tok.tenant_id
            )
          )
        )
    ) THEN
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
    AND lower(trim(COALESCE(rec.signer_email, ''))) = homeowner_email_lc;
  email_conflict := homeowner_email_lc <> ''
    AND lower(trim(COALESCE(rec.signer_email, ''))) <> ''
    AND lower(trim(COALESCE(rec.signer_email, ''))) <> homeowner_email_lc;
  name_hit := homeowner_name_lc <> ''
    AND (
      -- SQL 83: the homeowner name needs at least two parts of 2+ letters,
      -- and every one must be a whole word of the name. A shared surname
      -- alone, or a substring such as 'ada' in 'adam', is not a match.
      (
        SELECT count(*)
        FROM unnest(regexp_split_to_array(homeowner_name_lc, '[^a-z0-9]+')) AS part
        WHERE length(part) >= 2
      ) >= 2
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(regexp_split_to_array(homeowner_name_lc, '[^a-z0-9]+')) AS part
        WHERE length(part) >= 2
          AND NOT (part = ANY (regexp_split_to_array(lower(COALESCE(rec.signer_name, '')), '[^a-z0-9]+')))
      )
    );
  name_conflict := trim(COALESCE(rec.signer_name, '')) <> '' AND NOT name_hit;
  -- The sole homeowner-type signer fallback applies only when nothing
  -- contradicts it.
  identity_ok := email_hit OR name_hit
    OR (homeowner_signer_count = 1 AND NOT email_conflict AND NOT name_conflict);
  IF NOT identity_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_signature');
  END IF;

  -- Allow-lists, same as pending_signatures: open requests are 'pending' or
  -- 'in_progress'; an open signer is 'pending'.
  request_status_lc := lower(trim(COALESCE(rec.request_status, '')));
  IF rec.completed_at IS NOT NULL OR request_status_lc NOT IN ('pending', 'in_progress') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state');
  END IF;

  signer_status_lc := lower(trim(COALESCE(rec.status, '')));
  IF rec.signed_at IS NOT NULL OR signer_status_lc = 'signed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_signed');
  END IF;
  IF signer_status_lc <> 'pending' THEN
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
      AND lower(trim(COALESCE(prior.status, ''))) = 'pending'
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
