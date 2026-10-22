-- SQL 110: homeowner pre-claim links. A real Delete for "Recent Pre-claim links" (Manager >
-- Homeowner Uploads) and a narrow writer for the public (no-login) homeowner upload.
--
-- Why:
-- 1) The owner chose a permanent delete over hiding a pre-claim link. SQL 68
--    (68_staging_class_a_grants.sql) grants SELECT, INSERT and UPDATE on
--    public.homeowner_ledger_tokens to checksops, no DELETE, and the table's other grants came
--    from supabase migrations that the AWS copy restored without ACLs (--no-acl), so PostgreSQL
--    refuses a DELETE by checksops before any policy is evaluated.
-- 2) The public upload (aws/functions/api/homeowner.mjs handleHomeownerLedgerUpload) runs on a
--    session with no app identity (checksops: not BYPASSRLS, not the table owner). Its INSERT
--    into public.homeowner_ledger_check_uploads is refused by aws_write_homeowner_ledger_check_uploads
--    (FOR ALL TO authenticated, aws_can_write_tenant(tenant_id), aws/rls/sql/24), so a homeowner
--    upload through a pre-claim link cannot be stored. It needs one narrow SECURITY DEFINER
--    writer keyed by the link token, in the style of aws_public_homeowner_ledger_by_token (SQL 82).
--
-- What this file does:
-- a) GRANT DELETE ON public.homeowner_ledger_tokens TO checksops. Only DELETE, only checksops
--    (SQL 68 granted the other privileges to checksops alone; authenticated holds none on this
--    table in AWS, and checksops is a member of authenticated, so the RLS policies TO
--    authenticated apply to it). No PUBLIC, no anon. RLS stays the authorization boundary:
--    aws_write_homeowner_ledger_tokens (aws/rls/sql/24) is FOR ALL TO authenticated with
--    USING (aws_can_write_tenant(tenant_id)), so it already covers DELETE: a same-tenant
--    admin/staff identity (or platform owner) may delete, any other session deletes no row.
--    No policy is added or changed.
--    Foreign keys that reference homeowner_ledger_tokens(id) (supabase migrations
--    20260712113217 and 20260830125722): homeowner_ledger_check_uploads.token_id and
--    homeowner_deductible_payments.token_id, both ON DELETE SET NULL. Neither blocks nor
--    cascades: deleting a link that has uploads or deductible payments keeps those rows and
--    clears their token_id. The API deletes only links with no uploads attached; the database
--    does not enforce that.
-- b) public.aws_public_homeowner_ledger_upload(_token, _front_path, _back_path, _kind,
--    _amount_estimate, _homeowner_note) RETURNS jsonb (new, SECURITY DEFINER, VOLATILE,
--    search_path = public, owned by the applying login like the other aws/workflows/sql
--    DEFINER functions). EXECUTE: checksops only (revoked from PUBLIC), as SQL 82 grants
--    aws_public_homeowner_ledger_by_token. It:
--      - finds the homeowner_ledger_tokens row by the exact (trimmed) token, locked FOR UPDATE
--        so concurrent uploads on one link serialise; unknown or shorter than 8 characters ->
--        {"error":"not_found"}, revoked_at set -> {"error":"revoked"}, expires_at in the past ->
--        {"error":"expired"} (the columns and order of aws_public_homeowner_ledger_by_token);
--      - _kind 'check' or 'document' (NULL -> 'check'), otherwise {"error":"invalid_kind"};
--        _amount_estimate NULL or 0 .. 10000000, otherwise {"error":"invalid_amount"};
--        _homeowner_note trimmed, cut to 1000 characters, empty -> NULL;
--      - front path required and back path optional, each exactly
--        ledger/<coalesce(claim_id, id) of the token>/<digits>_front|_back.<jpg|jpeg|png|webp|heic|pdf>
--        (front for the front, back for the back) and no '..', otherwise {"error":"invalid_path"};
--      - 25 or more uploads on this token in the last 24 hours -> {"error":"rate_limited"};
--      - inserts one homeowner_ledger_check_uploads row: tenant_id, claim_id, token_id,
--        partner_code and assigned_to_user_id (= sent_by_user_id, as the Supabase
--        homeowner-ledger-upload function did) from the token, front_path, back_path,
--        amount_estimate, homeowner_note, status 'pending_review', created_at now(). The table
--        has no kind column: _kind is returned and recorded on the ledger event only;
--      - when the token has a claim (homeowner_ledger_events.claim_id is NOT NULL), appends one
--        homeowner_ledger_events row: event_type 'homeowner_check_upload' (the value the
--        event_type CHECK allows for a homeowner upload), amount = amount_estimate, actor_label
--        'Homeowner', payload_json {upload_id, kind};
--      - returns {ok: true, upload_id, tenant_id, claim_id, token_id, kind, sent_by_user_id:
--        coalesce(sent_by_user_id, created_by)}.
--
-- Not changed: no policy, no RLS flag, no table or column, no other grant; no existing function.
-- The function never touches a token other than the one named, never reads or changes another
-- tenant's rows and writes no money, check or claim row.
--
-- Refuses to run (55000 sql110_prerequisite_missing) without the three tables, the columns the
-- function uses and role checksops, and (55000 sql110_definer_cannot_write) unless the applying
-- login owns public.homeowner_ledger_tokens, public.homeowner_ledger_check_uploads and
-- public.homeowner_ledger_events without FORCE ROW LEVEL SECURITY (or is a superuser or
-- BYPASSRLS).
--
-- Transactions: no BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: GRANT of a held privilege is a no-op and the function is CREATE OR REPLACE.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect,
-- staging first.

DO $sql110_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.homeowner_ledger_tokens', to_regclass('public.homeowner_ledger_tokens')::oid),
      ('public.homeowner_ledger_check_uploads', to_regclass('public.homeowner_ledger_check_uploads')::oid),
      ('public.homeowner_ledger_events', to_regclass('public.homeowner_ledger_events')::oid),
      ('role checksops', (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('homeowner_ledger_tokens', 'id'), ('homeowner_ledger_tokens', 'token'),
        ('homeowner_ledger_tokens', 'tenant_id'), ('homeowner_ledger_tokens', 'claim_id'),
        ('homeowner_ledger_tokens', 'revoked_at'), ('homeowner_ledger_tokens', 'expires_at'),
        ('homeowner_ledger_tokens', 'partner_code'), ('homeowner_ledger_tokens', 'sent_by_user_id'),
        ('homeowner_ledger_tokens', 'created_by'),
        ('homeowner_ledger_check_uploads', 'id'), ('homeowner_ledger_check_uploads', 'tenant_id'),
        ('homeowner_ledger_check_uploads', 'claim_id'), ('homeowner_ledger_check_uploads', 'token_id'),
        ('homeowner_ledger_check_uploads', 'front_path'), ('homeowner_ledger_check_uploads', 'back_path'),
        ('homeowner_ledger_check_uploads', 'amount_estimate'), ('homeowner_ledger_check_uploads', 'homeowner_note'),
        ('homeowner_ledger_check_uploads', 'partner_code'), ('homeowner_ledger_check_uploads', 'assigned_to_user_id'),
        ('homeowner_ledger_check_uploads', 'status'), ('homeowner_ledger_check_uploads', 'created_at'),
        ('homeowner_ledger_events', 'tenant_id'), ('homeowner_ledger_events', 'claim_id'),
        ('homeowner_ledger_events', 'event_type'), ('homeowner_ledger_events', 'amount'),
        ('homeowner_ledger_events', 'actor_label'), ('homeowner_ledger_events', 'payload_json')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql110_prerequisite_missing: SQL 110 needs the homeowner ledger tables; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN ('public.homeowner_ledger_tokens'::regclass,
                    'public.homeowner_ledger_check_uploads'::regclass,
                    'public.homeowner_ledger_events'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql110_definer_cannot_write: the applying login must own public.homeowner_ledger_tokens, public.homeowner_ledger_check_uploads and public.homeowner_ledger_events (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql110_prereq$;

-- a) Delete a pre-claim link (RLS: aws_write_homeowner_ledger_tokens decides which rows).
GRANT DELETE ON TABLE public.homeowner_ledger_tokens TO checksops;

-- b) The public homeowner upload writer.
CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_upload(
  _token text,
  _front_path text,
  _back_path text,
  _kind text,
  _amount_estimate numeric,
  _homeowner_note text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  v_token text := trim(COALESCE(_token, ''));
  v_kind text := lower(trim(COALESCE(_kind, 'check')));
  v_note text := NULLIF(left(trim(COALESCE(_homeowner_note, '')), 1000), '');
  v_front text := _front_path;
  v_back text := NULLIF(_back_path, '');
  v_prefix text;
  v_recent integer;
  v_upload_id uuid;
BEGIN
  IF length(v_token) < 8 THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT * INTO tok
  FROM public.homeowner_ledger_tokens
  WHERE token = v_token
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF tok.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'revoked');
  END IF;
  IF tok.expires_at IS NOT NULL AND tok.expires_at < now() THEN
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  IF v_kind NOT IN ('check', 'document') THEN
    RETURN jsonb_build_object('error', 'invalid_kind');
  END IF;
  IF _amount_estimate IS NOT NULL AND (_amount_estimate < 0 OR _amount_estimate > 10000000) THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;

  v_prefix := 'ledger/' || COALESCE(tok.claim_id, tok.id)::text || '/';
  IF v_front IS NULL
     OR position('..' IN v_front) > 0
     OR left(v_front, length(v_prefix)) <> v_prefix
     OR substr(v_front, length(v_prefix) + 1) !~ '^[0-9]+_front\.(jpg|jpeg|png|webp|heic|pdf)$' THEN
    RETURN jsonb_build_object('error', 'invalid_path');
  END IF;
  IF v_back IS NOT NULL AND (
       position('..' IN v_back) > 0
       OR left(v_back, length(v_prefix)) <> v_prefix
       OR substr(v_back, length(v_prefix) + 1) !~ '^[0-9]+_back\.(jpg|jpeg|png|webp|heic|pdf)$') THEN
    RETURN jsonb_build_object('error', 'invalid_path');
  END IF;

  SELECT count(*)::integer INTO v_recent
  FROM public.homeowner_ledger_check_uploads u
  WHERE u.token_id = tok.id
    AND u.created_at > now() - interval '24 hours';
  IF v_recent >= 25 THEN
    RETURN jsonb_build_object('error', 'rate_limited');
  END IF;

  INSERT INTO public.homeowner_ledger_check_uploads (
    tenant_id, claim_id, token_id, front_path, back_path, amount_estimate, homeowner_note,
    partner_code, assigned_to_user_id, status, created_at
  ) VALUES (
    tok.tenant_id, tok.claim_id, tok.id, v_front, v_back, _amount_estimate, v_note,
    tok.partner_code, tok.sent_by_user_id, 'pending_review', now()
  )
  RETURNING id INTO v_upload_id;

  IF tok.claim_id IS NOT NULL THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, event_type, amount, actor_label, payload_json
    ) VALUES (
      tok.tenant_id, tok.claim_id, 'homeowner_check_upload', _amount_estimate, 'Homeowner',
      jsonb_build_object('upload_id', v_upload_id, 'kind', v_kind)
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'upload_id', v_upload_id,
    'tenant_id', tok.tenant_id,
    'claim_id', tok.claim_id,
    'token_id', tok.id,
    'kind', v_kind,
    'sent_by_user_id', COALESCE(tok.sent_by_user_id, tok.created_by)
  );
END
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_upload(text, text, text, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_upload(text, text, text, text, numeric, text) TO checksops;
COMMENT ON FUNCTION public.aws_public_homeowner_ledger_upload(text, text, text, text, numeric, text) IS
  'SQL 110: public homeowner upload through a pre-claim link token: one pending_review homeowner_ledger_check_uploads row (and a ledger event when the link has a claim). checksops only.';
