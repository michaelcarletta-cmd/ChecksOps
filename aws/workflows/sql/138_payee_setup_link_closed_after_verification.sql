-- SQL 138: a payee's setup link records no further step once the payee is verified.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why (security audit 2026-10-29, finding 18, low): SQL 113's public link function
-- public.aws_public_payee_record(_token, _event, _data) checks only that the payee is not
-- disconnected, that the link has not expired (token_expires_at, 14 days from the email in the
-- API) and the attempt counter; it never looks at verified_at. aws_payee_apply_status('verified')
-- sets verified_at and token_used_at but keeps secure_token, so the link stays usable until it
-- expires. Through it, after verification, a 'bank_linked' event disconnects the verified bank's
-- payment_provider_methods row and connects another one (SQL 113 lines 469-513; onboarding_status
-- stays 'verified', line 512), and the API (aws/functions/api/providers/payees/handlers.mjs,
-- publicBankAdd with replace_bank: true) then removes the previous bank at the payment provider.
-- Whoever holds a leaked link can therefore replace a verified payee's bank.
--
-- What the product intends (read, not assumed): a verified payee never changes their bank through
-- a setup link. aws_payee_reissue_link refuses a verified payee ('already_verified', SQL 113 line
-- 330), the API's publicIdentity refuses a verified payee, and the page
-- (src/pages/RecipientPaymentSetup.tsx) offers "Use a different bank account" only on the Verify
-- step, before setup is complete; the Done step offers nothing but "You're all set". No API call
-- of the legitimate flow records a step after verification: syncPayee records tos_accepted and
-- bank_verified only while they are unset, and verification requires both
-- (aws_payee_apply_status 'setup_incomplete'); publicTosAccept, publicBankVerify and publicBankAdd
-- without replace_bank record nothing once their step is done.
--
-- What this file does (owner 2026-10-31: "Okay, let's do option A and fix it correctly for SQL 138"):
-- 1) CREATE OR REPLACE public.aws_public_payee_record(text, text, jsonb), the same signature,
--    LANGUAGE plpgsql, VOLATILE, SECURITY DEFINER, SET search_path = public and owner as SQL 113
--    left it, with one change: once the payee is verified (verified_at IS NOT NULL) every event
--    (tos_accepted, identity_submitted, bank_linked, bank_verified and any other) returns
--    {"error": "already_verified"} and writes nothing: no setup_attempts increment, no
--    payment_provider_methods row, no external_payment_recipients column. The check runs after
--    the row is read FOR UPDATE, so an event that waited on a concurrent aws_payee_apply_status
--    sees its verified_at. Everything else is SQL 113's body, byte for byte: an unverified payee's
--    steps (including replacing a not-yet-verified bank) and the not_found, disconnected, expired
--    and rate_limited answers are unchanged.
--    Why verified_at: it is the column the product reads as "setup complete" (aws_payee_reissue_link,
--    the API's publicIdentity, syncPayee and the page). aws_payee_apply_status sets token_used_at in
--    the same UPDATE, but token_used_at is not cleared by aws_payee_reissue_link and the column
--    predates SQL 113 (it is one of SQL 113's prerequisites), so a row could carry it without being
--    verified; keying on it could lock out a payee still setting up.
--    Why 'already_verified': the code SQL 113 already uses for the same state
--    (aws_payee_reissue_link; the API's TENANT_ERRORS maps it to 409 "This payee has already
--    finished setup."). The public handlers map a code not in LINK_ERRORS to 400
--    setup_step_refused "This step could not be saved." (a plain inline error, not a 500 and not a
--    terminal page); syncPayee ignores a refused record. No existing link code fits: expired and
--    disconnected would tell a verified payee to ask for a new link or that setup was cancelled,
--    neither of which is true, and the legitimate flow never reaches this answer.
-- 2) EXECUTE: REVOKE ALL FROM PUBLIC, GRANT EXECUTE TO checksops, as SQL 113 (CREATE OR REPLACE
--    keeps the ACL; these restate it and are no-ops on SQL 113's state). The ACL stays checksops
--    and the owner. The COMMENT names SQL 138.
--
-- Not changed: aws_public_payee_by_token (the link still reads the payee's state, so the page shows
-- "You're all set" after verification), aws_payee_create, aws_payee_reissue_link (a tenant's new
-- link for an unverified payee still replaces secure_token, which closes the old link),
-- aws_payee_disconnect, aws_payee_apply_status; no table, column, constraint, policy, RLS setting,
-- table grant, trigger or row. No API or SPA change.
-- Known residue outside this file (API ordering, reported with this change): publicBankAdd calls the
-- payment provider's bank-account create before aws_public_payee_record, so after SQL 138 a leaked
-- link can still attach an unverified extra bank account to the payee's provider account; the
-- refused record stops the API before its disableBank of the previous bank, and the database keeps
-- the verified bank on the stakeholder and payment_provider_methods rows. Closing that needs an API
-- check before the provider call (a separate guarded Lambda change).
--
-- Refuses to run (55000 sql138_prerequisite_missing) without SQL 113's
-- public.aws_public_payee_record(text, text, jsonb) and public.aws_public_payee_by_token(text), the
-- tables and columns the function uses, and role checksops; (55000 sql138_definer_cannot_write)
-- unless the applying login owns public.external_payment_recipients and
-- public.payment_provider_methods without FORCE ROW LEVEL SECURITY (or is a superuser or
-- BYPASSRLS); and (55000 sql138_function_not_owned) unless the applying login owns
-- aws_public_payee_record (CREATE OR REPLACE must keep its owner, and with it the DEFINER rights).
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: CREATE OR REPLACE of the same body, REVOKE of an absent privilege and GRANT of a held
-- one are no-ops on a second run. Not applied by this change: staging first, then production,
-- through the guarded SQL path (AGENTS.md).

DO $sql138_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.external_payment_recipients', pg_catalog.to_regclass('public.external_payment_recipients')::oid),
      ('public.payment_provider_methods', pg_catalog.to_regclass('public.payment_provider_methods')::oid),
      ('public.aws_public_payee_record(text, text, jsonb)', pg_catalog.to_regprocedure('public.aws_public_payee_record(text, text, jsonb)')::oid),
      ('public.aws_public_payee_by_token(text)', pg_catalog.to_regprocedure('public.aws_public_payee_by_token(text)')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('external_payment_recipients', 'id'), ('external_payment_recipients', 'tenant_id'),
        ('external_payment_recipients', 'environment'), ('external_payment_recipients', 'provider_account_id'),
        ('external_payment_recipients', 'onboarding_status'), ('external_payment_recipients', 'secure_token'),
        ('external_payment_recipients', 'token_expires_at'), ('external_payment_recipients', 'updated_at'),
        ('external_payment_recipients', 'provider_bank_account_id'), ('external_payment_recipients', 'provider_bank_name'),
        ('external_payment_recipients', 'provider_last_four'), ('external_payment_recipients', 'bank_linked_at'),
        ('external_payment_recipients', 'tos_accepted_at'), ('external_payment_recipients', 'identity_submitted_at'),
        ('external_payment_recipients', 'bank_verified_at'), ('external_payment_recipients', 'verified_at'),
        ('external_payment_recipients', 'disconnected_at'), ('external_payment_recipients', 'setup_attempts'),
        ('payment_provider_methods', 'id'), ('payment_provider_methods', 'tenant_id'),
        ('payment_provider_methods', 'external_recipient_id'), ('payment_provider_methods', 'provider'),
        ('payment_provider_methods', 'environment'), ('payment_provider_methods', 'provider_account_id'),
        ('payment_provider_methods', 'provider_bank_account_id'), ('payment_provider_methods', 'bank_name'),
        ('payment_provider_methods', 'account_type'), ('payment_provider_methods', 'last_four'),
        ('payment_provider_methods', 'holder_name'), ('payment_provider_methods', 'verification_status'),
        ('payment_provider_methods', 'connection_status'), ('payment_provider_methods', 'can_receive'),
        ('payment_provider_methods', 'can_send'), ('payment_provider_methods', 'connected_at'),
        ('payment_provider_methods', 'disconnected_at'), ('payment_provider_methods', 'updated_at')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql138_prerequisite_missing: SQL 138 needs SQL 113''s payee setup first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN ('public.external_payment_recipients'::regclass,
                    'public.payment_provider_methods'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql138_definer_cannot_write: the login running SQL 138 must own public.external_payment_recipients and public.payment_provider_methods (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE p.oid = 'public.aws_public_payee_record(text, text, jsonb)'::regprocedure
      AND NOT (me.rolsuper OR pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE'))
  ) THEN
    RAISE EXCEPTION 'sql138_function_not_owned: the login running SQL 138 must own public.aws_public_payee_record(text, text, jsonb) (SQL 113''s owner), or be a superuser'
      USING ERRCODE = '55000';
  END IF;
END
$sql138_prereq$;

-- Public (link token): record one setup step the API has completed with Moov; none once verified.
CREATE OR REPLACE FUNCTION public.aws_public_payee_record(_token text, _event text, _data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.external_payment_recipients%ROWTYPE;
  v_token text := trim(COALESCE(_token, ''));
  v_event text := lower(trim(COALESCE(_event, '')));
  v_data jsonb := COALESCE(_data, '{}'::jsonb);
  v_bank_id text;
  v_bank_name text;
  v_last_four text;
  v_account_type text;
  v_holder text;
  v_method uuid;
BEGIN
  IF length(v_token) < 32 THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO rec FROM public.external_payment_recipients WHERE secure_token = v_token LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF rec.disconnected_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'disconnected'); END IF;
  -- SQL 138: a verified payee's link records nothing (no bank swap, no other step, no counter).
  IF rec.verified_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_verified'); END IF;
  IF rec.token_expires_at IS NULL OR rec.token_expires_at < now() THEN
    RETURN jsonb_build_object('error', 'expired');
  END IF;
  IF rec.setup_attempts >= 60 THEN RETURN jsonb_build_object('error', 'rate_limited'); END IF;

  UPDATE public.external_payment_recipients
     SET setup_attempts = setup_attempts + 1, updated_at = now()
   WHERE id = rec.id;

  IF v_event = 'tos_accepted' THEN
    UPDATE public.external_payment_recipients
       SET tos_accepted_at = COALESCE(tos_accepted_at, now()),
           onboarding_status = CASE WHEN onboarding_status IN ('invited', 'not_started') THEN 'tos_accepted' ELSE onboarding_status END
     WHERE id = rec.id;

  ELSIF v_event = 'identity_submitted' THEN
    UPDATE public.external_payment_recipients
       SET identity_submitted_at = now(),
           onboarding_status = CASE WHEN onboarding_status IN ('invited', 'not_started', 'tos_accepted', 'failed')
                                    THEN 'identity_submitted' ELSE onboarding_status END
     WHERE id = rec.id;

  ELSIF v_event = 'bank_linked' THEN
    v_bank_id := trim(COALESCE(v_data->>'provider_bank_account_id', ''));
    v_bank_name := NULLIF(left(trim(COALESCE(v_data->>'bank_name', '')), 120), '');
    v_last_four := trim(COALESCE(v_data->>'last_four', ''));
    v_account_type := lower(trim(COALESCE(v_data->>'account_type', '')));
    v_holder := NULLIF(left(trim(COALESCE(v_data->>'holder_name', '')), 200), '');
    IF v_bank_id !~ '^[A-Za-z0-9-]{8,64}$' THEN RETURN jsonb_build_object('error', 'invalid_bank_account'); END IF;
    IF v_last_four !~ '^[0-9]{4}$' THEN RETURN jsonb_build_object('error', 'invalid_last_four'); END IF;
    IF v_account_type NOT IN ('checking', 'savings') THEN RETURN jsonb_build_object('error', 'invalid_account_type'); END IF;

    -- One active bank per payee: a new bank replaces the earlier one.
    UPDATE public.payment_provider_methods
       SET connection_status = 'disconnected', disconnected_at = now(), updated_at = now()
     WHERE external_recipient_id = rec.id AND provider_bank_account_id <> v_bank_id
       AND connection_status <> 'disconnected';

    SELECT id INTO v_method FROM public.payment_provider_methods
     WHERE provider = 'moov' AND environment = rec.environment AND provider_bank_account_id = v_bank_id
     LIMIT 1;
    IF v_method IS NULL THEN
      INSERT INTO public.payment_provider_methods (
        tenant_id, external_recipient_id, provider, environment, provider_account_id,
        provider_bank_account_id, bank_name, account_type, last_four, holder_name,
        verification_status, connection_status, can_receive, can_send, connected_at
      ) VALUES (
        rec.tenant_id, rec.id, 'moov', rec.environment, rec.provider_account_id,
        v_bank_id, v_bank_name, v_account_type, v_last_four, v_holder,
        'pending', 'connected', true, false, now()
      );
    ELSIF EXISTS (SELECT 1 FROM public.payment_provider_methods
                   WHERE id = v_method AND external_recipient_id IS DISTINCT FROM rec.id) THEN
      RETURN jsonb_build_object('error', 'conflict');
    ELSE
      UPDATE public.payment_provider_methods
         SET bank_name = v_bank_name, account_type = v_account_type, last_four = v_last_four,
             holder_name = v_holder, connection_status = 'connected', disconnected_at = NULL,
             updated_at = now()
       WHERE id = v_method;
    END IF;

    UPDATE public.external_payment_recipients
       SET provider_bank_account_id = v_bank_id, provider_bank_name = v_bank_name,
           provider_last_four = v_last_four, bank_linked_at = now(), bank_verified_at = NULL,
           onboarding_status = CASE WHEN verified_at IS NULL THEN 'bank_linked' ELSE onboarding_status END
     WHERE id = rec.id;

  ELSIF v_event = 'bank_verified' THEN
    v_bank_id := trim(COALESCE(v_data->>'provider_bank_account_id', ''));
    IF rec.provider_bank_account_id IS NULL OR v_bank_id <> rec.provider_bank_account_id THEN
      RETURN jsonb_build_object('error', 'bank_mismatch');
    END IF;
    UPDATE public.payment_provider_methods
       SET verification_status = 'verified', updated_at = now()
     WHERE external_recipient_id = rec.id AND provider_bank_account_id = v_bank_id;
    UPDATE public.external_payment_recipients
       SET bank_verified_at = COALESCE(bank_verified_at, now()),
           onboarding_status = CASE WHEN verified_at IS NULL THEN 'bank_verified' ELSE onboarding_status END
     WHERE id = rec.id;

  ELSE
    RETURN jsonb_build_object('error', 'invalid_event');
  END IF;

  RETURN public.aws_public_payee_by_token(v_token);
END
$$;

REVOKE ALL ON FUNCTION public.aws_public_payee_record(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_payee_record(text, text, jsonb) TO checksops;

COMMENT ON FUNCTION public.aws_public_payee_record(text, text, jsonb) IS
  'SQL 113, SQL 138: records one payee setup step (tos_accepted, identity_submitted, bank_linked, bank_verified) through its link token; none once the payee is verified (already_verified). checksops only.';
