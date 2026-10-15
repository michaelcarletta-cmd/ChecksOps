-- AWS: Homeowner Ledger public view contract (SQL 82).
-- CREATE OR REPLACE of public.aws_public_homeowner_ledger_by_token.
-- Replaces the thin definition from aws/workflows/sql/68_staging_class_a_grants.sql.
-- Does NOT rewrite historical aws/workflows/sql/68_staging_class_a_grants.sql.
-- Does NOT apply financial activation, Cognito, RLS broadening, or production.
--
-- Provenance: the function body is the staging-accepted Homeowner Ops
-- ledger view (Cursor branch SQL 73, last_viewed best-effort + check_stage
-- totals repair), renumbered to 82 so it does not collide with main's
-- 71_review_amount_column_grant.sql / 72_member_payment_writes.sql.
-- One security change from that body: pending_endorsements[].sign_url is
-- always NULL. The staging SQL 73 body returned '/endorse?token=' ||
-- check_endorsements.token (and, with an empty homeowner email, for every
-- insured party). The raw endorsement token must never be in the ledger
-- view; the endorse doorway in SQL 83 returns it only at click time.
--
-- Isolation: token → tenant → claim must agree. Fail closed on
-- invalid / revoked / expired / mismatched-tenant / mismatched-claim.
-- Every claim, check, event, endorsement, and disbursement read is
-- constrained to the token's authorized tenant and claim.
-- Do not trust claim_id alone when a tenant relationship can be verified.
--
-- claim_ok: a claim-linked token is authorized when the claim exists and
-- any one of these exact bindings is present:
--   1. claims.org_id = tok.tenant_id
--   2. check_intake_items row with that exact claim_id + tok.tenant_id
--   3. homeowner_ledger_events row with that exact claim_id + tok.tenant_id
-- A different non-null claims.org_id does not override (2) or (3).
-- Do not infer from homeowner, address, claim number, email, org name,
-- arbitrary membership, or a check/event on a different claim or tenant.
--
-- check_stage is cast to text in the totals block (a live check_stage
-- enum cannot accept '' from COALESCE(i.check_stage, '')).
--
-- last_viewed_at is telemetry. Record it only after successful
-- authorization (pre_claim, or claim_ok plus claim JSON). Wrap the
-- UPDATE so a view-recording failure cannot turn an otherwise valid
-- ledger into 503 ledger_view_failed.
--
-- Totals are calculated from authoritative check_intake_items +
-- disbursement records, never by summing homeowner_ledger_events.
--   received  = sum(check amounts) for this tenant+claim
--   deposited = sum of those checks in deposited|cleared|funds_released|disbursed
--   released  = non-dead disbursement_splits for those checks
--               + non-dead claim_disbursements for the authorized claim
--   remaining = greatest(0, received - released)
--
-- Pending endorsements: insured + mortgage_company only, status only.
--   insured           → homeowner signing status (mint via endorse doorway)
--   mortgage_company  → mortgage workflow/status
-- PA / contractor / internal parties are never returned.
--
-- pending_signatures is forced to []. The Lambda attaches a sanitized,
-- claim-scoped list from aws_public_homeowner_pending_signatures (SQL 83).

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  claim_ok boolean := false;
  claim_json jsonb;
  events_json jsonb;
  totals_json jsonb;
  pending_endorsements_json jsonb;
  pending_upload_count integer := 0;
  received_amt numeric := 0;
  deposited_amt numeric := 0;
  released_amt numeric := 0;
  remaining_amt numeric := 0;
  homeowner_email_lc text;
  homeowner_name_lc text;
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

  homeowner_email_lc := lower(trim(COALESCE(tok.homeowner_email, '')));
  homeowner_name_lc := lower(trim(COALESCE(tok.homeowner_name, '')));

  IF tok.claim_id IS NULL THEN
    BEGIN
      UPDATE public.homeowner_ledger_tokens
      SET last_viewed_at = now()
      WHERE id = tok.id;
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;

    SELECT COUNT(*)::integer
      INTO pending_upload_count
      FROM public.homeowner_ledger_check_uploads
      WHERE token_id = tok.id;

    RETURN jsonb_build_object(
      'ok', true,
      'mode', 'pre_claim',
      'token', jsonb_build_object(
        'id', tok.id,
        'tenant_id', tok.tenant_id,
        'claim_id', tok.claim_id,
        'homeowner_email', tok.homeowner_email,
        'homeowner_name', tok.homeowner_name
      ),
      'homeowner', jsonb_build_object(
        'name', tok.homeowner_name,
        'email', tok.homeowner_email
      ),
      'claim', NULL,
      'events', '[]'::jsonb,
      'totals', jsonb_build_object(
        'received', 0,
        'deposited', 0,
        'released', 0,
        'remaining', 0
      ),
      'pending_upload_count', pending_upload_count,
      'pending_signatures', '[]'::jsonb,
      'pending_endorsements', '[]'::jsonb,
      'shared_documents', '[]'::jsonb,
      'project_plan', NULL,
      'can_upload', true,
      'allow_deductible_payment', false,
      'money', NULL,
      'deductible_payments', '[]'::jsonb
    );
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
    RETURN NULL;
  END IF;

  SELECT to_jsonb(c) INTO claim_json
  FROM (
    SELECT id, claim_number,
           policyholder_address AS property_address,
           loss_type, status, created_at
    FROM public.claims
    WHERE id = tok.claim_id
  ) c;

  IF claim_json IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    UPDATE public.homeowner_ledger_tokens
    SET last_viewed_at = now()
    WHERE id = tok.id;
  EXCEPTION
    WHEN OTHERS THEN
      NULL;
  END;

  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at DESC), '[]'::jsonb)
    INTO events_json
  FROM (
    SELECT id, check_id, event_type, occurred_at, amount, actor_label, payload_json
    FROM public.homeowner_ledger_events
    WHERE claim_id = tok.claim_id
      AND tenant_id = tok.tenant_id
    ORDER BY occurred_at DESC
    LIMIT 500
  ) e;

  SELECT
    COALESCE(SUM(COALESCE(i.amount, 0)), 0),
    COALESCE(SUM(
      CASE
        WHEN lower(COALESCE(i.check_stage::text, '')) IN ('deposited', 'cleared', 'funds_released', 'disbursed')
          THEN COALESCE(i.amount, 0)
        ELSE 0
      END
    ), 0)
    INTO received_amt, deposited_amt
  FROM public.check_intake_items i
  WHERE i.claim_id = tok.claim_id
    AND i.tenant_id = tok.tenant_id;

  SELECT COALESCE(SUM(COALESCE(s.amount, 0)), 0)
    INTO released_amt
  FROM public.disbursement_splits s
  JOIN public.disbursement_batches b
    ON b.id = s.batch_id
   AND b.tenant_id = tok.tenant_id
  JOIN public.check_intake_items i
    ON i.id = b.check_intake_item_id
   AND i.claim_id = tok.claim_id
   AND i.tenant_id = tok.tenant_id
  WHERE s.tenant_id = tok.tenant_id
    AND lower(COALESCE(s.status, '')) NOT IN (
      'cancelled', 'canceled', 'failed', 'returned', 'voided'
    );

  released_amt := released_amt + COALESCE((
    SELECT SUM(COALESCE(d.amount, 0))
    FROM public.claim_disbursements d
    WHERE d.claim_id = tok.claim_id
      AND lower(COALESCE(d.status, '')) NOT IN (
        'cancelled', 'canceled', 'failed', 'returned', 'voided'
      )
      AND EXISTS (
        SELECT 1
        FROM public.claims c
        WHERE c.id = tok.claim_id
          AND c.org_id = tok.tenant_id
      )
  ), 0);

  remaining_amt := GREATEST(0, received_amt - released_amt);
  totals_json := jsonb_build_object(
    'received', received_amt,
    'deposited', deposited_amt,
    'released', released_amt,
    'remaining', remaining_amt
  );

  SELECT COALESCE(jsonb_agg(check_row ORDER BY check_row->>'check_id'), '[]'::jsonb)
    INTO pending_endorsements_json
  FROM (
    SELECT jsonb_build_object(
      'check_id', grouped.check_id,
      'check_number', grouped.check_number,
      'check_amount', grouped.check_amount,
      'parties', grouped.parties
    ) AS check_row
    FROM (
      SELECT
        i.id AS check_id,
        i.check_number,
        i.amount AS check_amount,
        jsonb_agg(
          jsonb_build_object(
            'endorsement_id', e.id,
            'payee_name', e.payee_name,
            'payee_type', e.payee_type,
            'status', e.status,
            'sent_at', e.request_sent_at,
            'is_homeowner', (
              e.payee_type = 'insured'
              AND (
                homeowner_email_lc = ''
                OR lower(COALESCE(e.contact_email, '')) = homeowner_email_lc
                OR (
                  homeowner_name_lc <> ''
                  AND EXISTS (
                    SELECT 1
                    FROM unnest(regexp_split_to_array(homeowner_name_lc, '\s+')) AS part
                    WHERE length(part) >= 3
                      AND strpos(lower(COALESCE(e.payee_name, '')), part) > 0
                  )
                )
              )
            ),
            -- SQL 82 security change from the staging SQL 73 body: never
            -- embed check_endorsements.token in the ledger view. The
            -- homeowner-ledger-endorse-link doorway (SQL 83) mints at click.
            'sign_url', NULL::text
          )
          ORDER BY e.created_at ASC
        ) AS parties
      FROM public.check_intake_items i
      JOIN public.check_endorsements e
        ON e.check_id = i.id
       AND (e.tenant_id IS NULL OR e.tenant_id = tok.tenant_id)
      WHERE i.claim_id = tok.claim_id
        AND i.tenant_id = tok.tenant_id
        AND e.payee_type IN ('insured', 'mortgage_company')
        AND e.signed_at IS NULL
        AND lower(COALESCE(e.status, '')) NOT IN (
          'signed', 'waived', 'endorsed', 'completed', 'complete'
        )
        AND (
          e.request_sent_at IS NOT NULL
          OR lower(COALESCE(e.status, '')) IN (
            'sent', 'requested', 'in_progress', 'pending_signature', 'awaiting_signature'
          )
          OR (
            e.payee_type = 'insured'
            AND (
              homeowner_email_lc = ''
              OR lower(COALESCE(e.contact_email, '')) = homeowner_email_lc
              OR (
                homeowner_name_lc <> ''
                AND EXISTS (
                  SELECT 1
                  FROM unnest(regexp_split_to_array(homeowner_name_lc, '\s+')) AS part
                  WHERE length(part) >= 3
                    AND strpos(lower(COALESCE(e.payee_name, '')), part) > 0
                )
              )
            )
          )
        )
      GROUP BY i.id, i.check_number, i.amount
    ) grouped
  ) listed;

  RETURN jsonb_build_object(
    'ok', true,
    'mode', 'claim',
    'token', jsonb_build_object(
      'id', tok.id,
      'tenant_id', tok.tenant_id,
      'claim_id', tok.claim_id,
      'homeowner_email', tok.homeowner_email,
      'homeowner_name', tok.homeowner_name
    ),
    'homeowner', jsonb_build_object(
      'name', tok.homeowner_name,
      'email', tok.homeowner_email
    ),
    'claim', claim_json,
    'events', events_json,
    'totals', totals_json,
    'pending_upload_count', 0,
    'pending_signatures', '[]'::jsonb,
    'pending_endorsements', pending_endorsements_json,
    'shared_documents', '[]'::jsonb,
    'project_plan', NULL,
    'can_upload', true,
    'allow_deductible_payment', false,
    'money', NULL,
    'deductible_payments', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) TO checksops;
