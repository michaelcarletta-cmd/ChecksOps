-- SQL 170: a payee's endorsement request shows whether the email was delivered, bounced or marked as spam, and when the
-- payee opened the signing link. AWS only: nothing under supabase/migrations changes.
--
-- Why (owner 2026-11-19): "Is there anyway for tenants to see if an email has been delivered and opened? For this to
-- show up near the payee signature request", then, offered (1) the link opened, recorded when the payee opens the
-- endorsement page, and (2) delivered or bounced from Resend's delivery reports: "Yeah build 1 and 2". Today the
-- endorsement card shows only "Last sent <time>": check_endorsements.request_sent_at. The "delivered" the API stores
-- on endorsement_requests means only that Resend accepted the email, and nothing records an opened link. An "email
-- opened" tracking pixel is deliberately not used (Apple Mail preloads images, many clients block them, and it can
-- hurt deliverability); the opened link is the signal.
--
-- What this file does:
-- 1) Adds eight columns to public.check_endorsements, the latest request email's status and the link's use:
--      email_message_id text           Resend's id of the latest request email (the delivery reports name it);
--      email_delivered_at timestamptz  Resend reported it delivered to the recipient's mail server;
--      email_bounced_at timestamptz    Resend reported a bounce;
--      email_bounce_reason text        the bounce message Resend gave (at most 300 characters);
--      email_complained_at timestamptz the recipient marked it as spam;
--      link_first_opened_at timestamptz, link_last_opened_at timestamptz
--                                      the payee opened the endorsement page;
--      link_open_count integer NOT NULL DEFAULT 0
--                                      how many times.
--    All nullable with no default except link_open_count (0 for every existing row: no link was recorded opened). No
--    column grant: the table's SELECT for checksops (aws/write-path/sql/33_tranche2_write_grants.sql) already covers new
--    columns, and the API writes them only through the functions below.
-- 2) The partial index check_endorsements_email_message_id_idx on (email_message_id) WHERE email_message_id IS NOT
--    NULL, for the delivery report lookup.
-- 3) Three functions (plpgsql, VOLATILE, SECURITY DEFINER, search_path = public, row_security = off, owned by the
--    applying login like the other aws/workflows/sql DEFINER functions; EXECUTE revoked from PUBLIC, anon,
--    authenticated and service_role where they exist, granted to checksops only). The API calls them only after its own
--    checks: the tenant's send, Resend's signed delivery report, the payee's valid link.
--      a. public.aws_endorsement_email_sent(_endorsement_id uuid, _message_id text) RETURNS boolean: a request email was
--         sent: sets email_message_id to the id (first 200 characters) and clears the four email status columns, so a
--         resend starts a fresh status. A NULL or blank id changes nothing and returns false; otherwise returns whether
--         the endorsement exists.
--      b. public.aws_endorsement_email_event(_message_id text, _event text, _at timestamptz, _reason text) RETURNS
--         integer: one Resend delivery report: 'delivered', 'bounced' (with the reason, first 300 characters) or
--         'complained' sets its time (_at, or now() when NULL) on the endorsements whose email_message_id is that id,
--         keeping the first time when a report repeats. Any other event raises 22023 invalid_email_event. A NULL or
--         blank id matches nothing. Returns the number of endorsements updated (0 for an email that is not an
--         endorsement's latest request).
--      c. public.aws_endorsement_link_opened(_endorsement_id uuid) RETURNS integer: the payee opened the page: sets
--         link_first_opened_at (once), link_last_opened_at to now() and adds 1 to link_open_count. Returns the new
--         count, or NULL when no such endorsement.
--    None changes status, signed_at, the token or any other column; updated_at is left as it is (a status report is
--    not an edit of the request).
--
-- Accepted predecessor: public.check_endorsements with id, then for each new column either absent or exactly the type,
-- NOT NULL and default above (a re-run). Refuses (55000):
--   sql170_prerequisite_missing     the table, its id column or the role checksops is missing;
--   sql170_definer_cannot_write     the applying login does not own public.check_endorsements without FORCE ROW LEVEL
--                                   SECURITY and is neither a superuser nor BYPASSRLS (a DEFINER filtered by RLS would
--                                   find no row and record nothing);
--   sql170_column_conflict          a new column already exists with another type, NOT NULL or default.
-- The release engine (release-sql-specs.mjs) additionally refuses an existing function or index with another
-- definition before the file runs.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION; a REVOKE or GRANT
-- already in place is a no-op. When every object is already current it notices sql170_already_current.
--
-- Not changed: no other column, constraint, index, trigger, function, policy, RLS setting or table grant; no row is
-- rewritten beyond link_open_count's default; endorsement_requests is unchanged. Sending, signing and the endorsement
-- statuses behave as before until the API (a later Lambda overlay) calls the functions.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect, staging first.

DO $sql170_prereq$
DECLARE
  v_missing text[];
  v_conflict text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.check_endorsements', pg_catalog.to_regclass('public.check_endorsements')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = pg_catalog.to_regclass('public.check_endorsements') AND a.attname = 'id' AND a.attnum > 0
       AND NOT a.attisdropped
  ) THEN
    v_missing := ARRAY['column public.check_endorsements.id'];
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql170_prerequisite_missing: %', array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid = 'public.check_endorsements'::regclass
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql170_definer_cannot_write: the applying login must own public.check_endorsements (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
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
    ('email_message_id', 'text', false, NULL::text),
    ('email_delivered_at', 'timestamp with time zone', false, NULL),
    ('email_bounced_at', 'timestamp with time zone', false, NULL),
    ('email_bounce_reason', 'text', false, NULL),
    ('email_complained_at', 'timestamp with time zone', false, NULL),
    ('link_first_opened_at', 'timestamp with time zone', false, NULL),
    ('link_last_opened_at', 'timestamp with time zone', false, NULL),
    ('link_open_count', 'integer', true, '0')
  ) AS want(col, typ, want_notnull, def)
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = 'public.check_endorsements'::regclass AND a.attname = want.col AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE pg_catalog.format_type(a.atttypid, a.atttypmod) IS DISTINCT FROM want.typ
     OR a.attnotnull IS DISTINCT FROM want.want_notnull
     OR pg_catalog.pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM want.def;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'sql170_column_conflict: public.check_endorsements already has %', v_conflict USING ERRCODE = '55000';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.check_endorsements'::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname IN ('email_message_id', 'email_delivered_at', 'email_bounced_at', 'email_bounce_reason',
                           'email_complained_at', 'link_first_opened_at', 'link_last_opened_at', 'link_open_count')) = 8
     AND pg_catalog.to_regclass('public.check_endorsements_email_message_id_idx') IS NOT NULL
     AND pg_catalog.to_regprocedure('public.aws_endorsement_email_sent(uuid, text)') IS NOT NULL
     AND pg_catalog.to_regprocedure('public.aws_endorsement_email_event(text, text, timestamp with time zone, text)') IS NOT NULL
     AND pg_catalog.to_regprocedure('public.aws_endorsement_link_opened(uuid)') IS NOT NULL THEN
    RAISE NOTICE 'sql170_already_current';
  END IF;
END
$sql170_prereq$;

-- 1) The latest request email's status and the link's use.
ALTER TABLE public.check_endorsements
  ADD COLUMN IF NOT EXISTS email_message_id text,
  ADD COLUMN IF NOT EXISTS email_delivered_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS email_bounced_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS email_bounce_reason text,
  ADD COLUMN IF NOT EXISTS email_complained_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS link_first_opened_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS link_last_opened_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS link_open_count integer NOT NULL DEFAULT 0;

-- 2) The delivery report lookup.
CREATE INDEX IF NOT EXISTS check_endorsements_email_message_id_idx
  ON public.check_endorsements (email_message_id) WHERE email_message_id IS NOT NULL;

-- 3a) A request email was sent: remember its id and start a fresh status.
CREATE OR REPLACE FUNCTION public.aws_endorsement_email_sent(_endorsement_id uuid, _message_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_id text := left(btrim(COALESCE(_message_id, '')), 200);
BEGIN
  IF _endorsement_id IS NULL OR v_id = '' THEN
    RETURN false;
  END IF;
  UPDATE public.check_endorsements e
     SET email_message_id = v_id,
         email_delivered_at = NULL,
         email_bounced_at = NULL,
         email_bounce_reason = NULL,
         email_complained_at = NULL
   WHERE e.id = _endorsement_id;
  RETURN FOUND;
END
$$;

-- 3b) One Resend delivery report for a request email.
CREATE OR REPLACE FUNCTION public.aws_endorsement_email_event(_message_id text, _event text, _at timestamp with time zone, _reason text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_id text := left(btrim(COALESCE(_message_id, '')), 200);
  v_event text := lower(btrim(COALESCE(_event, '')));
  v_at timestamp with time zone := COALESCE(_at, now());
  v_count integer;
BEGIN
  IF v_event NOT IN ('delivered', 'bounced', 'complained') THEN
    RAISE EXCEPTION 'invalid_email_event' USING ERRCODE = '22023';
  END IF;
  IF v_id = '' THEN
    RETURN 0;
  END IF;
  IF v_event = 'delivered' THEN
    UPDATE public.check_endorsements e
       SET email_delivered_at = COALESCE(e.email_delivered_at, v_at)
     WHERE e.email_message_id = v_id;
  ELSIF v_event = 'bounced' THEN
    UPDATE public.check_endorsements e
       SET email_bounced_at = COALESCE(e.email_bounced_at, v_at),
           email_bounce_reason = COALESCE(e.email_bounce_reason, left(NULLIF(btrim(COALESCE(_reason, '')), ''), 300))
     WHERE e.email_message_id = v_id;
  ELSE
    UPDATE public.check_endorsements e
       SET email_complained_at = COALESCE(e.email_complained_at, v_at)
     WHERE e.email_message_id = v_id;
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- 3c) The payee opened the endorsement page.
CREATE OR REPLACE FUNCTION public.aws_endorsement_link_opened(_endorsement_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_count integer;
BEGIN
  IF _endorsement_id IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.check_endorsements e
     SET link_first_opened_at = COALESCE(e.link_first_opened_at, now()),
         link_last_opened_at = now(),
         link_open_count = e.link_open_count + 1
   WHERE e.id = _endorsement_id
  RETURNING e.link_open_count INTO v_count;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION public.aws_endorsement_email_sent(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_endorsement_email_event(text, text, timestamp with time zone, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_endorsement_link_opened(uuid) FROM PUBLIC;

DO $sql170_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_endorsement_email_sent(uuid, text) FROM %I', v_role);
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_endorsement_email_event(text, text, timestamp with time zone, text) FROM %I', v_role);
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_endorsement_link_opened(uuid) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql170_revoke$;

GRANT EXECUTE ON FUNCTION public.aws_endorsement_email_sent(uuid, text) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_endorsement_email_event(text, text, timestamp with time zone, text) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_endorsement_link_opened(uuid) TO checksops;
