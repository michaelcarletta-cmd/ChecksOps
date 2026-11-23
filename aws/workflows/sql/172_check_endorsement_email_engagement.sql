-- SQL 172: a payee's endorsement request shows when the request email was opened and when a link in it was clicked,
-- from Resend's "opened" and "clicked" email events, next to Delivered. AWS only: nothing under supabase/migrations
-- changes.
--
-- Why (owner 2026-11-23): "Yes build opened and clicked": show Resend's opened and clicked events for a payee's
-- endorsement request email in ChecksOps, next to Delivered. SQL 170 (applied to production 2026-11-19) records the
-- latest request email's Resend id (check_endorsements.email_message_id) and its delivered, bounced and spam reports
-- through public.aws_endorsement_email_event, and the payee's opening of the signing page; it records neither of
-- Resend's engagement events. Resend reports "opened" from its tracking pixel and "clicked" from its link tracking; an
-- "opened" can be a mail client preloading images, so the API and website show it as Resend reports it, beside
-- Delivered and the link opened (SQL 170), not in place of them.
--
-- What this file does:
-- 1) Adds six columns to public.check_endorsements, the latest request email's engagement:
--      email_first_opened_at timestamptz, email_last_opened_at timestamptz
--                                      Resend reported the email opened (first and latest report);
--      email_open_count integer NOT NULL DEFAULT 0
--                                      how many opened reports;
--      email_first_clicked_at timestamptz, email_last_clicked_at timestamptz
--                                      Resend reported a link in the email clicked (first and latest report);
--      email_click_count integer NOT NULL DEFAULT 0
--                                      how many clicked reports.
--    The four times nullable with no default; the two counts 0 for every existing row (no event was recorded). No column
--    grant: the table's SELECT for checksops (aws/write-path/sql/33_tranche2_write_grants.sql) already covers new
--    columns, and the API writes them only through the function below.
-- 2) One function (plpgsql, VOLATILE, SECURITY DEFINER, search_path = public, row_security = off, owned by the applying
--    login like the other aws/workflows/sql DEFINER functions; EXECUTE revoked from PUBLIC, anon, authenticated and
--    service_role where they exist, granted to checksops only). The API calls it only after verifying Resend's signed
--    webhook, as it does for SQL 170's delivery reports.
--      public.aws_endorsement_email_engagement(p_email_id text, p_kind text, p_at timestamptz) RETURNS boolean: one
--      Resend engagement event. p_kind 'opened' or 'clicked' (trimmed, any case, as SQL 170 reads an event) sets, on the
--      endorsements whose email_message_id is that id (the id trimmed and cut to 200 characters, as
--      aws_endorsement_email_event finds them): the first time once (COALESCE), the latest time to the later of the
--      recorded one and p_at (GREATEST), and adds 1 to the count. p_at NULL is now(). Any other kind, or a NULL or blank
--      id, changes nothing and returns false. Returns whether an endorsement was updated (false for an email that is
--      not an endorsement's latest request).
--    It changes no other column: not status, signed_at, the token, updated_at or SQL 170's delivery columns.
--
-- A resend: SQL 170's aws_endorsement_email_sent (not changed here) stores the new email's id and clears only SQL 170's
-- four delivery columns; the engagement columns keep the earlier email's opens and clicks, and events for the earlier
-- email no longer match. Clearing them on a resend would mean replacing a SQL 170 function: a separate change, if wanted.
--
-- Accepted predecessor: SQL 170 applied (public.check_endorsements with id and email_message_id, and
-- public.aws_endorsement_email_event); then for each new column either absent or exactly the type, NOT NULL and default
-- above (a re-run). Refuses (55000):
--   sql172_prerequisite_missing     the table, its id or email_message_id column, aws_endorsement_email_event (SQL 170)
--                                   or the role checksops is missing;
--   sql172_definer_cannot_write     the applying login does not own public.check_endorsements without FORCE ROW LEVEL
--                                   SECURITY and is neither a superuser nor BYPASSRLS (a DEFINER filtered by RLS would
--                                   find no row and record nothing);
--   sql172_column_conflict          a new column already exists with another type, NOT NULL or default.
-- The release engine (release-sql-specs.mjs) additionally refuses before the file runs unless SQL 170 is in place as
-- pinned (its predecessor read), and when the function already exists with another definition.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION; a REVOKE or GRANT already in place is a no-op. When
-- every object is already current it notices sql172_already_current.
--
-- Not changed: no SQL 170 object (aws_endorsement_email_sent, aws_endorsement_email_event, aws_endorsement_link_opened,
-- their columns and index), no other column, constraint, index, trigger, function, policy, RLS setting or table grant;
-- no row is rewritten beyond the two counts' default; endorsement_requests is unchanged. Nothing records an engagement
-- event until the API (a later Lambda overlay) calls the function.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect, staging first.

DO $sql172_prereq$
DECLARE
  v_missing text[];
  v_conflict text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.check_endorsements', pg_catalog.to_regclass('public.check_endorsements')::oid),
      ('public.aws_endorsement_email_event(text, text, timestamp with time zone, text)',
       pg_catalog.to_regprocedure('public.aws_endorsement_email_event(text, text, timestamp with time zone, text)')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.check_endorsements.' || want.col ORDER BY want.col) INTO v_missing
    FROM (VALUES ('email_message_id'), ('id')) AS want(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.check_endorsements') AND a.attname = want.col AND a.attnum > 0
         AND NOT a.attisdropped
    );
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql172_prerequisite_missing: %', array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid = 'public.check_endorsements'::regclass
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql172_definer_cannot_write: the applying login must own public.check_endorsements (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;

  -- pg_attribute, not information_schema.columns: the latter lists only the columns the applying login holds a
  -- privilege on.
  SELECT string_agg(want.col || ' (' || pg_catalog.format_type(a.atttypid, a.atttypmod)
                    || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                    || COALESCE(' DEFAULT ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') || ')',
                    ', ' ORDER BY want.col)
    INTO v_conflict
  FROM (VALUES
    ('email_first_opened_at', 'timestamp with time zone', false, NULL::text),
    ('email_last_opened_at', 'timestamp with time zone', false, NULL),
    ('email_open_count', 'integer', true, '0'),
    ('email_first_clicked_at', 'timestamp with time zone', false, NULL),
    ('email_last_clicked_at', 'timestamp with time zone', false, NULL),
    ('email_click_count', 'integer', true, '0')
  ) AS want(col, typ, want_notnull, def)
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = 'public.check_endorsements'::regclass AND a.attname = want.col AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE pg_catalog.format_type(a.atttypid, a.atttypmod) IS DISTINCT FROM want.typ
     OR a.attnotnull IS DISTINCT FROM want.want_notnull
     OR pg_catalog.pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM want.def;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'sql172_column_conflict: public.check_endorsements already has %', v_conflict USING ERRCODE = '55000';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.check_endorsements'::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname IN ('email_first_opened_at', 'email_last_opened_at', 'email_open_count', 'email_first_clicked_at',
                           'email_last_clicked_at', 'email_click_count')) = 6
     AND pg_catalog.to_regprocedure('public.aws_endorsement_email_engagement(text, text, timestamp with time zone)') IS NOT NULL THEN
    RAISE NOTICE 'sql172_already_current';
  END IF;
END
$sql172_prereq$;

-- 1) The latest request email's engagement.
ALTER TABLE public.check_endorsements
  ADD COLUMN IF NOT EXISTS email_first_opened_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS email_last_opened_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS email_open_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_first_clicked_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS email_last_clicked_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS email_click_count integer NOT NULL DEFAULT 0;

-- 2) One Resend engagement event (opened or clicked) for a request email.
CREATE OR REPLACE FUNCTION public.aws_endorsement_email_engagement(p_email_id text, p_kind text, p_at timestamp with time zone)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_id text := left(btrim(COALESCE(p_email_id, '')), 200);
  v_kind text := lower(btrim(COALESCE(p_kind, '')));
  v_at timestamp with time zone := COALESCE(p_at, now());
  v_count integer;
BEGIN
  IF v_kind NOT IN ('opened', 'clicked') OR v_id = '' THEN
    RETURN false;
  END IF;
  IF v_kind = 'opened' THEN
    UPDATE public.check_endorsements e
       SET email_first_opened_at = COALESCE(e.email_first_opened_at, v_at),
           email_last_opened_at = GREATEST(COALESCE(e.email_last_opened_at, v_at), v_at),
           email_open_count = e.email_open_count + 1
     WHERE e.email_message_id = v_id;
  ELSE
    UPDATE public.check_endorsements e
       SET email_first_clicked_at = COALESCE(e.email_first_clicked_at, v_at),
           email_last_clicked_at = GREATEST(COALESCE(e.email_last_clicked_at, v_at), v_at),
           email_click_count = e.email_click_count + 1
     WHERE e.email_message_id = v_id;
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END
$$;

REVOKE ALL ON FUNCTION public.aws_endorsement_email_engagement(text, text, timestamp with time zone) FROM PUBLIC;

DO $sql172_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_endorsement_email_engagement(text, text, timestamp with time zone) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql172_revoke$;

GRANT EXECUTE ON FUNCTION public.aws_endorsement_email_engagement(text, text, timestamp with time zone) TO checksops;
