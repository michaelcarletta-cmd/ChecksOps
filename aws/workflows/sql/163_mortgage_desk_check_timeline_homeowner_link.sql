-- SQL 163: the Mortgage Desk agent sees the request's check and its homeowner timeline, and can send the
-- homeowner tracking link. AWS only: nothing under supabase/migrations changes.
--
-- Why (owner 2026-11-12): "A check was sent for Kenneth Smith to mortgage desk, the check did not show for
-- mortgage agent and it says check not linked from checksops. The check should be linked." "notes should
-- show on the mortgage agents side as well so they know they made contact with homeowner or tenant."
-- "When sending homeowner link from mortgage desk, error missing_cognito_token. Fix it." Approval to build:
-- "Start the desk fixes" (2026-11-13).
--   - The Desk page reads the check from public.check_intake_items under RLS. Its policy has no mortgage
--     agent clause, so every assigned agent reads no row and the page says "No check linked to this
--     request" (the platform owner reads it as platform owner). The check images come from
--     get-check-image-urls, which reads the same row under RLS.
--   - "Log update to homeowner timeline" (SQL 124 h) writes public.homeowner_ledger_events; the Desk has
--     no read of that timeline, so the agent never sees what was logged.
--   - The tracking-link button calls homeowner-ledger-send with the tenant session (absent on the Desk:
--     missing_cognito_token). That handler also requires tenant_users membership, so the Desk session
--     alone would get cross_tenant_denied.
--
-- What this file does (each function plpgsql, SECURITY DEFINER, search_path = public, pg_temp, owned by
-- the applying login; the gate is SQL 124's public.aws_mortgage_desk_readable_request: the caller is the
-- assigned mortgage agent holding mortgage_agent, or the platform owner, the request is in_progress or
-- completed and has a check; otherwise 42501 not_authorized / not_assigned_to_you /
-- request_not_in_status or 22023 request_has_no_check):
-- 1) public.aws_mortgage_desk_request_check(_request_id uuid), STABLE: the request's check, one row, only
--    the fields the Desk page shows (id, claim, amount, check number, carrier, payee, payee and property
--    address, issue date, claim number read from the check, image paths, status, stage, funds type).
--    Never routing_number, account_number, OCR payloads or any tenant column.
-- 2) public.aws_mortgage_desk_homeowner_timeline(_request_id uuid), STABLE: the homeowner timeline of
--    the request's claim as the request's tenant wrote it (homeowner_ledger_events with that claim_id
--    and tenant_id), newest first, at most 200: event_id, event_type, occurred_at, actor_label, note
--    (payload_json->>'note' only), amount, from_desk (the payload carries desk_request_id, SQL 124 h).
--    No rows when the request has no claim. This is the timeline the homeowner already sees.
-- 3) public.aws_mortgage_desk_homeowner_link(_request_id uuid, _new_token text), VOLATILE: the homeowner
--    tracking link of the request's claim for the homeowner ON FILE, never a caller-chosen address:
--      a. the request has a claim (22023 request_has_no_claim), the claim belongs to the request's tenant
--         (claims.org_id, or no org_id and one of the tenant's checks carries it; else 42501
--         claim_not_in_tenant), and the homeowner email is the request's homeowner_email, else the
--         claim's policyholder_email, lower-cased and trimmed (22023 no_homeowner_email when neither is
--         an address);
--      b. reuses that recipient's own live token (same tenant, claim and email, not revoked or expired,
--         and a name that is blank or the same), as aws/functions/api/homeowner.mjs runHomeownerLedgerSend
--         does; else inserts _new_token (48 lower-case hex characters from the API, else 22023
--         invalid_token) with created_by the caller;
--      c. returns token, homeowner_email, homeowner_name, tenant_id and reused. The API builds the link
--         and sends the email.
-- 4) EXECUTE: REVOKE ALL FROM PUBLIC, and from anon, authenticated and service_role where those roles
--    exist; GRANT EXECUTE TO checksops (aws/functions/api/mortgage-desk-esign.mjs). The owner keeps its own.
--
-- Not changed: no table, column, policy, RLS setting, table grant, trigger or row; no other function
-- (SQL 124's gate keeps its body and ACL). The tenant's own reads and homeowner-ledger-send are unchanged.
--
-- Refuses to run (55000 sql163_prerequisite_missing) without the relations, columns, helper functions and
-- role it uses, and (55000 sql163_definer_cannot_reach) unless the applying login owns the relations it
-- reads or writes without FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS: a DEFINER filtered by
-- RLS would show the agent nothing.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql163_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.mortgage_handling_requests', pg_catalog.to_regclass('public.mortgage_handling_requests')::oid),
      ('public.check_intake_items', pg_catalog.to_regclass('public.check_intake_items')::oid),
      ('public.claims', pg_catalog.to_regclass('public.claims')::oid),
      ('public.homeowner_ledger_events', pg_catalog.to_regclass('public.homeowner_ledger_events')::oid),
      ('public.homeowner_ledger_tokens', pg_catalog.to_regclass('public.homeowner_ledger_tokens')::oid),
      ('public.aws_mortgage_desk_readable_request(uuid)', pg_catalog.to_regprocedure('public.aws_mortgage_desk_readable_request(uuid)')::oid),
      ('auth.uid()', pg_catalog.to_regprocedure('auth.uid()')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('mortgage_handling_requests', 'tenant_id'), ('mortgage_handling_requests', 'claim_id'),
      ('mortgage_handling_requests', 'check_intake_item_id'), ('mortgage_handling_requests', 'homeowner_email'),
      ('mortgage_handling_requests', 'homeowner_name'),
      ('check_intake_items', 'claim_id'), ('check_intake_items', 'tenant_id'), ('check_intake_items', 'amount'),
      ('check_intake_items', 'check_number'), ('check_intake_items', 'carrier_name'),
      ('check_intake_items', 'payee_line'), ('check_intake_items', 'payee_address'),
      ('check_intake_items', 'property_address'), ('check_intake_items', 'issue_date'),
      ('check_intake_items', 'detected_claim_number'), ('check_intake_items', 'front_image_path'),
      ('check_intake_items', 'back_image_path'), ('check_intake_items', 'status'),
      ('check_intake_items', 'check_stage'), ('check_intake_items', 'funds_type'),
      ('claims', 'org_id'), ('claims', 'policyholder_email'), ('claims', 'policyholder_name'),
      ('homeowner_ledger_events', 'tenant_id'), ('homeowner_ledger_events', 'claim_id'),
      ('homeowner_ledger_events', 'event_type'), ('homeowner_ledger_events', 'occurred_at'),
      ('homeowner_ledger_events', 'actor_label'), ('homeowner_ledger_events', 'payload_json'),
      ('homeowner_ledger_events', 'amount'),
      ('homeowner_ledger_tokens', 'token'), ('homeowner_ledger_tokens', 'tenant_id'),
      ('homeowner_ledger_tokens', 'claim_id'), ('homeowner_ledger_tokens', 'homeowner_email'),
      ('homeowner_ledger_tokens', 'homeowner_name'), ('homeowner_ledger_tokens', 'revoked_at'),
      ('homeowner_ledger_tokens', 'expires_at'), ('homeowner_ledger_tokens', 'created_by'),
      ('homeowner_ledger_tokens', 'created_at')) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql163_prerequisite_missing: SQL 163 needs the Mortgage Desk (SQL 124) and homeowner ledger schema first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(t.oid::regclass::text, ', ' ORDER BY t.oid::regclass::text) INTO v_unreachable
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_roles me ON me.rolname = current_user
  WHERE t.oid IN (pg_catalog.to_regclass('public.mortgage_handling_requests'), pg_catalog.to_regclass('public.check_intake_items'),
                  pg_catalog.to_regclass('public.claims'), pg_catalog.to_regclass('public.homeowner_ledger_events'),
                  pg_catalog.to_regclass('public.homeowner_ledger_tokens'))
    AND NOT (me.rolsuper OR me.rolbypassrls
             OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity));
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'sql163_definer_cannot_reach: the login running SQL 163 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql163_prereq$;

-- 1) The request's check, as the Desk page shows it.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_request_check(_request_id uuid)
RETURNS TABLE(
  check_id uuid,
  claim_id uuid,
  amount numeric,
  check_number text,
  carrier_name text,
  payee_line text,
  payee_address text,
  property_address text,
  issue_date text,
  detected_claim_number text,
  front_image_path text,
  back_image_path text,
  status text,
  check_stage text,
  funds_type text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
BEGIN
  v_req := public.aws_mortgage_desk_readable_request(_request_id);
  RETURN QUERY
  SELECT ci.id,
         ci.claim_id,
         ci.amount::numeric,
         ci.check_number::text,
         ci.carrier_name::text,
         ci.payee_line::text,
         ci.payee_address::text,
         ci.property_address::text,
         ci.issue_date::text,
         ci.detected_claim_number::text,
         ci.front_image_path::text,
         ci.back_image_path::text,
         ci.status::text,
         ci.check_stage::text,
         ci.funds_type::text
    FROM public.check_intake_items ci
   WHERE ci.id = v_req.check_intake_item_id
   LIMIT 1;
END;
$$;

-- 2) The homeowner timeline of the request's claim, as the request's tenant wrote it.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_homeowner_timeline(_request_id uuid)
RETURNS TABLE(
  event_id uuid,
  event_type text,
  occurred_at timestamp with time zone,
  actor_label text,
  note text,
  amount numeric,
  from_desk boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
BEGIN
  v_req := public.aws_mortgage_desk_readable_request(_request_id);
  IF v_req.claim_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT e.id,
         e.event_type::text,
         e.occurred_at,
         e.actor_label::text,
         (e.payload_json ->> 'note')::text,
         e.amount::numeric,
         (e.payload_json ? 'desk_request_id')
    FROM public.homeowner_ledger_events e
   WHERE e.claim_id = v_req.claim_id
     AND e.tenant_id = v_req.tenant_id
   ORDER BY e.occurred_at DESC, e.id DESC
   LIMIT 200;
END;
$$;

-- 3) The homeowner tracking link of the request's claim, for the homeowner on file.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_homeowner_link(_request_id uuid, _new_token text)
RETURNS TABLE(
  token text,
  homeowner_email text,
  homeowner_name text,
  tenant_id uuid,
  reused boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_email text;
  v_name text;
  v_token text;
BEGIN
  v_req := public.aws_mortgage_desk_readable_request(_request_id);
  IF v_req.claim_id IS NULL THEN
    RAISE EXCEPTION 'request_has_no_claim' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.claims c
     WHERE c.id = v_req.claim_id
       AND (c.org_id = v_req.tenant_id
            OR (c.org_id IS NULL AND EXISTS (
                  SELECT 1 FROM public.check_intake_items ci
                   WHERE ci.claim_id = c.id AND ci.tenant_id = v_req.tenant_id)))
  ) THEN
    RAISE EXCEPTION 'claim_not_in_tenant' USING ERRCODE = '42501';
  END IF;

  SELECT lower(btrim(COALESCE(NULLIF(btrim(v_req.homeowner_email), ''), c.policyholder_email))),
         NULLIF(btrim(COALESCE(NULLIF(btrim(v_req.homeowner_name), ''), c.policyholder_name)), '')
    INTO v_email, v_name
    FROM public.claims c
   WHERE c.id = v_req.claim_id;
  IF v_email IS NULL OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'no_homeowner_email' USING ERRCODE = '22023';
  END IF;

  SELECT t.token INTO v_token
    FROM public.homeowner_ledger_tokens t
   WHERE t.tenant_id = v_req.tenant_id
     AND t.claim_id = v_req.claim_id
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > now())
     AND lower(btrim(COALESCE(t.homeowner_email, ''))) = v_email
     AND (v_name IS NULL
          OR NULLIF(btrim(COALESCE(t.homeowner_name, '')), '') IS NULL
          OR lower(btrim(t.homeowner_name)) = lower(v_name))
   ORDER BY t.created_at DESC
   LIMIT 1;
  IF v_token IS NOT NULL THEN
    RETURN QUERY SELECT v_token, v_email, v_name, v_req.tenant_id, true;
    RETURN;
  END IF;

  IF _new_token IS NULL OR _new_token !~ '^[0-9a-f]{48}$' THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.homeowner_ledger_tokens (tenant_id, claim_id, token, homeowner_email, homeowner_name, created_by, created_at)
  VALUES (v_req.tenant_id, v_req.claim_id, _new_token, v_email, v_name, v_uid, now());
  RETURN QUERY SELECT _new_token, v_email, v_name, v_req.tenant_id, false;
END;
$$;

REVOKE ALL ON FUNCTION public.aws_mortgage_desk_request_check(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_homeowner_timeline(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_homeowner_link(uuid, text) FROM PUBLIC;

DO $sql163_revoke$
DECLARE
  v_role text;
  v_fn text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      FOREACH v_fn IN ARRAY ARRAY[
        'public.aws_mortgage_desk_request_check(uuid)',
        'public.aws_mortgage_desk_homeowner_timeline(uuid)',
        'public.aws_mortgage_desk_homeowner_link(uuid, text)'
      ] LOOP
        EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', v_fn, v_role);
      END LOOP;
    END IF;
  END LOOP;
END
$sql163_revoke$;

GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_request_check(uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_homeowner_timeline(uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_homeowner_link(uuid, text) TO checksops;
