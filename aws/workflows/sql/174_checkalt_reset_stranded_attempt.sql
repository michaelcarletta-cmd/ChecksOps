-- SQL 174: put back one Check Alt deposit attempt that was stranded before any request reached Check Alt, so the
-- next Deposit press claims it normally. AWS only: nothing under supabase/migrations changes.
--
-- Why (owner 2026-11-24, "start step 3": clear the one stranded CheckAlt deposit attempt):
--   - Before PR 2068, checkalt-submit.mjs ran markHttpAttempted (aws/functions/api/providers/production/
--     checkalt-idempotency.mjs) before the Check Alt sign-in. On 2026-11-24 at 19:58 UTC the sign-in answered 504
--     ("CheckAlt auth failed [504]", CloudWatch 19:58:54 UTC), so no POST /fincapture/deposit/process was sent, but
--     the attempt row was already marked: status 'submitting', provider_http_attempted_at set, last_status_payload
--     {"phase": "submitting", "provider_http_attempted": true}, no checkalt_reference. The owner confirmed in the Check
--     Alt portal that no deposit went through. PR 2068 (live in production) now signs in first.
--   - The API treats such a row as "may have reached the provider" (rowHasProviderHttpAttempt: the column, the
--     payload flag or a reference) and answers reconciliation_required on every later press, so the check cannot be
--     deposited.
--   - A read-only production inspect (PR 2067, checkalt-deposit-state-inspect) found exactly one such row of 92:
--     status 'submitting', checkalt_reference NULL, provider_http_attempted_at set, created / attempted / updated in
--     the minute 2026-11-24 19:58 UTC, failure_class NULL, last_error NULL, phase 'submitting'; its check is not
--     deposited and has no other checkalt_deposits row.
--
-- What this file does:
-- 1) A new function public.aws_checkalt_reset_stranded_attempt(p_window_start timestamptz, p_window_end timestamptz)
--    RETURNS integer (plpgsql, VOLATILE, SECURITY DEFINER, search_path = public, pg_temp, row_security = off; owned by
--    the applying login; EXECUTE revoked from PUBLIC, anon, authenticated, service_role and checksops where they
--    exist: only the owner, the guarded admin path, can run it). It names no deposit, check, tenant, user or amount.
--    A stranded attempt in the window [p_window_start, p_window_end) (at most one hour) is a checkalt_deposits row
--    with ALL of:
--      checkalt_reference IS NULL; status = 'submitting'; provider_http_attempted_at and created_at in the window;
--      failure_class IS NULL; last_error IS NULL; last_status_payload->>'phase' = 'submitting'; its check
--      (check_intake_items) exists with deposited_at IS NULL; the check has no other checkalt_deposits row.
--    It locks the matching rows and counts them:
--      more than 1  RAISE 55000 sql174_ambiguous_stranded_attempts (the transaction rolls back; nothing changes);
--      0            returns 0 and changes nothing (a NOTICE says whether a row of the window is already reset:
--                   status 'queued', provider_http_attempted_at NULL, last_status_payload has stranded_reset);
--      exactly 1    sets that row back to the state insertQueuedDeposit leaves: status 'queued',
--                   provider_http_attempted_at NULL, last_status_payload merged with {"phase": "queued_before_http",
--                   "provider_http_attempted": false, "stranded_reset": {"reason": "pre_provider_sign_in_504",
--                   "migration": "174", "at": now()}}, updated_at now(); returns 1. checkalt_reference stays NULL;
--                   amount, amount_cents, idempotency_key, tenant_id, check_intake_item_id, submitted_by and every
--                   other column are untouched. The update re-checks the whole rule; anything but one row raises
--                   sql174_ambiguous_stranded_attempts.
--    After the reset, rowHasProviderHttpAttempt and shouldReconcileInsteadOfPost are false for the row, and
--    markHttpAttempted's WHERE (provider_http_attempted_at IS NULL, checkalt_reference IS NULL, status queued) claims
--    it on the next Deposit press with the same amount (the idempotency key).
-- 2) Calls it once for the minute 2026-11-24 19:58 UTC: [2026-11-24 19:58:00+00, 2026-11-24 19:59:00+00).
--
-- Triggers: the four AFTER INSERT OR UPDATE OF status triggers on checkalt_deposits (SQL 120's billing event, SQL
-- 121's cash-job payment, SQL 123's check status, SQL 152's failed-deposit fee) act only when a deposit becomes
-- submitted / cleared or rejected / error / duplicate / returned; for submitting -> queued each returns without a
-- write.
--
-- Not changed: no table, column, constraint, index, trigger, policy or grant; check_intake_items is only read. No
-- other checkalt_deposits row.
--
-- Refuses (55000):
--   sql174_prerequisite_missing         public.checkalt_deposits, public.check_intake_items or a column the function
--                                       reads or writes is missing;
--   sql174_definer_cannot_read          the applying login does not own checkalt_deposits and check_intake_items
--                                       without FORCE ROW LEVEL SECURITY and is neither a superuser nor BYPASSRLS;
--   sql174_ambiguous_stranded_attempts  more than one row matches the rule (from the function).
--   22023 sql174_invalid_window          a NULL, empty, reversed or longer-than-one-hour window (from the function).
-- The release engine (release-sql-specs.mjs) additionally requires, before the file runs, exactly one stranded
-- attempt in the window on production and none on staging (checkalt_stranded_attempt_in_window).
-- Idempotent: CREATE OR REPLACE FUNCTION, the REVOKEs; a second call finds no stranded row and returns 0.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect, staging first.

DO $sql174_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.checkalt_deposits', pg_catalog.to_regclass('public.checkalt_deposits')::oid),
      ('public.check_intake_items', pg_catalog.to_regclass('public.check_intake_items')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    -- pg_attribute, not information_schema.columns: the latter lists only the columns the applying login holds a
    -- privilege on.
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('check_intake_items', 'deposited_at'), ('check_intake_items', 'id'),
      ('checkalt_deposits', 'check_intake_item_id'), ('checkalt_deposits', 'checkalt_reference'),
      ('checkalt_deposits', 'created_at'), ('checkalt_deposits', 'failure_class'), ('checkalt_deposits', 'id'),
      ('checkalt_deposits', 'last_error'), ('checkalt_deposits', 'last_status_payload'),
      ('checkalt_deposits', 'provider_http_attempted_at'), ('checkalt_deposits', 'status'),
      ('checkalt_deposits', 'updated_at')) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.' || want.tbl) AND a.attname = want.col AND a.attnum > 0
         AND NOT a.attisdropped
    );
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql174_prerequisite_missing: %', array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN ('public.checkalt_deposits'::regclass, 'public.check_intake_items'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql174_definer_cannot_read: the applying login must own public.checkalt_deposits and public.check_intake_items (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql174_prereq$;

-- 1) The reset of one stranded attempt -----------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_checkalt_reset_stranded_attempt(p_window_start timestamptz, p_window_end timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  v_matches integer;
  v_reset integer;
  v_already integer;
BEGIN
  IF p_window_start IS NULL OR p_window_end IS NULL OR p_window_end <= p_window_start
     OR p_window_end - p_window_start > interval '1 hour' THEN
    RAISE EXCEPTION 'sql174_invalid_window: the window must be non-empty and at most one hour' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_matches
    FROM (
      SELECT d.id
        FROM public.checkalt_deposits d
        JOIN public.check_intake_items c ON c.id = d.check_intake_item_id
       WHERE d.checkalt_reference IS NULL
         AND d.status = 'submitting'
         AND d.provider_http_attempted_at >= p_window_start AND d.provider_http_attempted_at < p_window_end
         AND d.created_at >= p_window_start AND d.created_at < p_window_end
         AND d.failure_class IS NULL
         AND d.last_error IS NULL
         AND d.last_status_payload->>'phase' = 'submitting'
         AND c.deposited_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.checkalt_deposits o
            WHERE o.check_intake_item_id = d.check_intake_item_id AND o.id <> d.id)
       FOR UPDATE OF d
    ) AS stranded;

  IF v_matches > 1 THEN
    RAISE EXCEPTION 'sql174_ambiguous_stranded_attempts: % rows match; nothing changed', v_matches USING ERRCODE = '55000';
  END IF;

  IF v_matches = 0 THEN
    SELECT count(*) INTO v_already
      FROM public.checkalt_deposits d
     WHERE d.status = 'queued'
       AND d.provider_http_attempted_at IS NULL
       AND d.checkalt_reference IS NULL
       AND d.created_at >= p_window_start AND d.created_at < p_window_end
       AND d.last_status_payload ? 'stranded_reset';
    IF v_already > 0 THEN
      RAISE NOTICE 'sql174_already_reset: % row(s) of the window already reset; nothing changed', v_already;
    ELSE
      RAISE NOTICE 'sql174_no_stranded_attempt: no stranded attempt in the window; nothing changed';
    END IF;
    RETURN 0;
  END IF;

  UPDATE public.checkalt_deposits d
     SET status = 'queued',
         provider_http_attempted_at = NULL,
         last_status_payload = COALESCE(d.last_status_payload, '{}'::jsonb)
           || '{"phase": "queued_before_http", "provider_http_attempted": false}'::jsonb
           || jsonb_build_object('stranded_reset', jsonb_build_object(
                'reason', 'pre_provider_sign_in_504', 'migration', '174', 'at', now())),
         updated_at = now()
   WHERE d.checkalt_reference IS NULL
     AND d.status = 'submitting'
     AND d.provider_http_attempted_at >= p_window_start AND d.provider_http_attempted_at < p_window_end
     AND d.created_at >= p_window_start AND d.created_at < p_window_end
     AND d.failure_class IS NULL
     AND d.last_error IS NULL
     AND d.last_status_payload->>'phase' = 'submitting'
     AND EXISTS (
       SELECT 1 FROM public.check_intake_items c
        WHERE c.id = d.check_intake_item_id AND c.deposited_at IS NULL)
     AND NOT EXISTS (
       SELECT 1 FROM public.checkalt_deposits o
        WHERE o.check_intake_item_id = d.check_intake_item_id AND o.id <> d.id);
  GET DIAGNOSTICS v_reset = ROW_COUNT;
  IF v_reset <> 1 THEN
    RAISE EXCEPTION 'sql174_ambiguous_stranded_attempts: % rows updated; nothing changed', v_reset USING ERRCODE = '55000';
  END IF;
  RETURN 1;
END
$$;
REVOKE ALL ON FUNCTION public.aws_checkalt_reset_stranded_attempt(timestamptz, timestamptz) FROM PUBLIC;
DO $sql174_revoke$
DECLARE
  v_grantee text;
BEGIN
  FOREACH v_grantee IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'checksops'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_grantee) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.aws_checkalt_reset_stranded_attempt(timestamptz, timestamptz) FROM %I', v_grantee);
    END IF;
  END LOOP;
END
$sql174_revoke$;
COMMENT ON FUNCTION public.aws_checkalt_reset_stranded_attempt(timestamptz, timestamptz) IS
  'SQL 174: puts the one Check Alt deposit attempt stranded in the window before any provider request (status submitting, attempted, no reference, no error, check not deposited, its only deposit row) back to queued; 0 when none, raises when more than one. Owner only.';

-- 2) Once: the attempt stranded on 2026-11-24 at 19:58 UTC ------------------------------
DO $sql174_reset$
DECLARE
  v_reset integer;
BEGIN
  v_reset := public.aws_checkalt_reset_stranded_attempt('2026-11-24 19:58:00+00'::timestamptz, '2026-11-24 19:59:00+00'::timestamptz);
  RAISE NOTICE 'SQL 174: % stranded Check Alt deposit attempt(s) put back to queued', v_reset;
END
$sql174_reset$;
