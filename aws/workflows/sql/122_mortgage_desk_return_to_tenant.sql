-- AWS: the Mortgage Desk returns its work to the tenant (SQL 122).
-- Forward migration on top of SQL 99 (Desk completion messages) and SQL 100
-- (Desk access as live). AWS only: nothing under supabase/migrations changes.
--
-- Why (owner, 2026-10-27): "Need to make sure when the mortgage desk is done
-- with their work, it gets sent back to the tenant, with all the proper notes
-- and documentation." Approved fix: Desk uploads and messages go through a
-- server path that checks the agent works that request; the tenant sees all
-- Desk notes and documents on the check; the tenant gets an email when the
-- work is returned.
--
-- On AWS a Mortgage Agent is not a member of the requesting tenant, so:
--   - check_messages inserts are refused (members only, SQL 90 / SQL 99 owner
--     decision: no agent policy on check_messages): the Desk's "update sent to
--     tenant" messages, its upload notices and its mid-work notes never
--     reached the tenant (mid-work notes only went to
--     mortgage_handling_requests.work_notes, which no tenant screen reads);
--   - check_files inserts are refused (resource 'check', members and the
--     platform owner only): documents the Desk uploads never appeared on the
--     tenant's check;
--   - the shipping / mail-to / check_sent_date columns of
--     mortgage_handling_requests are not writable by the agent (SQL 100:
--     authenticated has UPDATE on accepted_at, assigned_employee_id and
--     completed_at only), so the shipping card stayed empty;
--   - the "Mortgage company step complete" homeowner timeline row the Desk
--     posted on completion was refused (homeowner_ledger_events is tenant
--     scoped).
-- Same approach as SQL 99 and SQL 111: no new policy and no table grant;
-- SECURITY DEFINER functions that check the caller themselves, called by the
-- API (aws/functions/api/mortgage-desk-return.mjs) as the signed-in user.
--
-- What this file does (all functions SECURITY DEFINER, search_path = public,
-- owned by the applying login like the other aws/workflows/sql DEFINER
-- functions; like SQL 99 none sets row_security, so the triggers their
-- inserts fire, trg_mirror_check_message_to_homeowner_ledger and
-- trg_mirror_check_file_to_homeowner_ledger, keep running as they do today):
--
-- 0) Column public.mortgage_handling_requests.return_emailed_at timestamptz
--    (new, nullable, no default, no grant): when the "work returned" email of
--    this request was claimed. Written only by f); it makes the email go out
--    at most once per request.
-- a) public.aws_mortgage_desk_working_request(_request_id uuid, _statuses text[])
--    RETURNS public.mortgage_handling_requests (internal; EXECUTE: the owner
--    only). Locks the request FOR UPDATE and returns it when
--      - the caller (auth.uid()) is set, the request exists and has a check
--        (check_intake_item_id), its status is one of _statuses, and
--      - the caller is the platform owner (is_platform_owner()), or the
--        caller is the assigned agent (assigned_employee_id = auth.uid()) and
--        holds the mortgage_agent role (aws_is_mortgage_ops_agent(), SQL 100).
--    Otherwise raises 42501 (not_authorized, request_not_in_status,
--    not_assigned_to_you) or 22023 (request_has_no_check). A missing request
--    is not_authorized, so the answer never tells a caller that another
--    tenant's request exists. The tenant comes from the request row, never
--    from the caller.
-- b) public.aws_mortgage_desk_post_message(_request_id uuid, _body text)
--    RETURNS public.check_messages. a) with status in_progress; body trimmed,
--    1 to 5000 characters (the table's limit), else 22023 invalid_body.
--    Inserts one check_messages row on the request's check, sender_id =
--    auth.uid(), is_deleted false.
-- c) public.aws_mortgage_desk_attach_file(_request_id uuid, _file_name text,
--    _file_path text, _file_type text, _file_size bigint, _category text,
--    _description text) RETURNS public.check_files. a) with status
--    in_progress. The path must be exactly checks/<the request's check
--    id>/mortgage-ops/<one file name> (no further '/', no '..', at most 512
--    characters), the storage prefix the API signs the agent's upload for;
--    file name 1 to 255 characters; category one of mortgage_ops,
--    mortgage_ops_signature, mortgage_ops_shipping_label (default
--    mortgage_ops); size 0 to 25 MB (the upload limit) or null. Inserts one
--    check_files row (source 'mortgage_ops', uploaded_by = auth.uid()); an
--    existing row of the same check and path is returned instead (a retry
--    never duplicates it).
-- d) public.aws_mortgage_desk_update_shipping(_request_id uuid, _fields jsonb)
--    RETURNS public.mortgage_handling_requests. a) with status in_progress.
--    _fields is an object whose keys are among mail_to_name (200),
--    mail_to_address (1000), shipping_label_carrier (100),
--    shipping_label_tracking (200), shipping_label_name (255),
--    shipping_label_path, check_sent_date, check_received_back_date, each a
--    string or null (22023 field_not_allowed / invalid_field otherwise). A key
--    present sets the column (an empty string or null clears it; the dates
--    are cast to timestamptz); a key absent keeps it. shipping_label_path must
--    name a check_files row of the request's check with source 'mortgage_ops'
--    (attached through c first); setting it also sets
--    shipping_label_uploaded_at = now() and shipping_label_uploaded_by =
--    auth.uid(). updated_at = now(). No other column changes.
-- e) public.aws_mortgage_desk_completion_timeline(_request_id uuid) RETURNS
--    uuid. a) with status completed. When the request's claim (its claim_id,
--    else its check's) is known and no mortgage_update event of this request
--    exists yet (payload_json mortgage_request_id), inserts one
--    homeowner_ledger_events row: tenant_id of the request, the claim, the
--    check, event_type 'mortgage_update', actor_label 'Mortgage Desk',
--    payload_json {title 'Mortgage company step complete', note 'Our mortgage
--    team finished working with your mortgage company on this check.',
--    mortgage_company, mortgage_request_id}, created_by auth.uid(). Returns the
--    new id, or NULL when nothing was inserted. No amount.
-- f) public.aws_mortgage_desk_return_email_claim(_request_id uuid) RETURNS
--    jsonb. a) with status completed. When return_emailed_at is set:
--    {claimed: false, reason: 'already_sent'}. Otherwise the recipients are
--    the member who sent the check to the Desk (requested_by, when still a
--    tenant_users member, its identity_accounts email), else every member of
--    the request's tenant (at most 25), else the tenant's company_email (when
--    that column exists). None: {claimed: false, reason: 'no_recipient'} and
--    nothing is marked. Else sets return_emailed_at = now() and returns
--    {claimed: true, request_id, tenant_id, tenant_name, tenant_slug,
--    check_id, check_number, mortgage_company, completed_at, note (the text
--    after ' Notes: ' of the latest SQL 99 completed-work message on the
--    check, or null), documents [{file_name, category}] (the check's
--    check_files with source 'mortgage_ops'), recipients, recipient_source}.
--    The API sends the email in the same transaction and rolls it back (so
--    return_emailed_at is cleared again) when the send fails.
--
-- EXECUTE on b) to f): checksops only (the API login), revoked from PUBLIC.
--
-- Not changed: no policy, no RLS flag, no grant on a table; no existing
-- function, trigger, row or column. Agents still cannot insert into
-- check_messages, check_files or homeowner_ledger_events, or update
-- mortgage_handling_requests, directly. SQL 99's completion trigger is
-- unchanged and still posts the completed-work note and the return marker.
--
-- Refuses to run (55000 sql122_prerequisite_missing) without SQL 99 / SQL 100
-- (aws_is_mortgage_ops_agent()), is_platform_owner(), auth.uid(), role
-- checksops and the tables and columns it uses, and (55000
-- sql122_definer_cannot_write) unless the applying login owns
-- public.check_messages, public.check_files, public.mortgage_handling_requests
-- and public.homeowner_ledger_events without FORCE ROW LEVEL SECURITY (or is a
-- superuser or BYPASSRLS).
--
-- Numbering: SQL 122 (SQL 121 is reserved for another workstream).
--
-- Transactions: no BEGIN/COMMIT; the guarded SQL executor runs it inside one
-- transaction. Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a
-- read-only inspect, staging first.

DO $sql122_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('auth.uid()', to_regprocedure('auth.uid()')::oid),
      ('public.aws_is_mortgage_ops_agent() (SQL 100)', to_regprocedure('public.aws_is_mortgage_ops_agent()')::oid),
      ('public.is_platform_owner()', to_regprocedure('public.is_platform_owner()')::oid),
      ('public.check_messages', to_regclass('public.check_messages')::oid),
      ('public.check_files', to_regclass('public.check_files')::oid),
      ('public.check_intake_items', to_regclass('public.check_intake_items')::oid),
      ('public.mortgage_handling_requests', to_regclass('public.mortgage_handling_requests')::oid),
      ('public.homeowner_ledger_events', to_regclass('public.homeowner_ledger_events')::oid),
      ('public.tenants', to_regclass('public.tenants')::oid),
      ('public.tenant_users', to_regclass('public.tenant_users')::oid),
      ('public.identity_accounts', to_regclass('public.identity_accounts')::oid),
      ('role checksops', (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('check_messages', 'id'), ('check_messages', 'check_id'), ('check_messages', 'sender_id'),
        ('check_messages', 'body'), ('check_messages', 'is_deleted'), ('check_messages', 'created_at'),
        ('check_files', 'id'), ('check_files', 'check_intake_item_id'), ('check_files', 'file_name'),
        ('check_files', 'file_path'), ('check_files', 'file_type'), ('check_files', 'file_size'),
        ('check_files', 'category'), ('check_files', 'source'), ('check_files', 'uploaded_by'),
        ('check_files', 'description'), ('check_files', 'created_at'),
        ('check_intake_items', 'id'), ('check_intake_items', 'claim_id'),
        ('check_intake_items', 'check_number'),
        ('mortgage_handling_requests', 'id'), ('mortgage_handling_requests', 'tenant_id'),
        ('mortgage_handling_requests', 'claim_id'), ('mortgage_handling_requests', 'status'),
        ('mortgage_handling_requests', 'check_intake_item_id'),
        ('mortgage_handling_requests', 'assigned_employee_id'),
        ('mortgage_handling_requests', 'requested_by'),
        ('mortgage_handling_requests', 'mortgage_company'),
        ('mortgage_handling_requests', 'completed_at'),
        ('mortgage_handling_requests', 'updated_at'),
        ('mortgage_handling_requests', 'mail_to_name'),
        ('mortgage_handling_requests', 'mail_to_address'),
        ('mortgage_handling_requests', 'shipping_label_path'),
        ('mortgage_handling_requests', 'shipping_label_name'),
        ('mortgage_handling_requests', 'shipping_label_carrier'),
        ('mortgage_handling_requests', 'shipping_label_tracking'),
        ('mortgage_handling_requests', 'shipping_label_uploaded_at'),
        ('mortgage_handling_requests', 'shipping_label_uploaded_by'),
        ('mortgage_handling_requests', 'check_sent_date'),
        ('mortgage_handling_requests', 'check_received_back_date'),
        ('homeowner_ledger_events', 'tenant_id'), ('homeowner_ledger_events', 'claim_id'),
        ('homeowner_ledger_events', 'check_id'), ('homeowner_ledger_events', 'event_type'),
        ('homeowner_ledger_events', 'occurred_at'), ('homeowner_ledger_events', 'actor_label'),
        ('homeowner_ledger_events', 'payload_json'), ('homeowner_ledger_events', 'created_by'),
        ('tenants', 'id'), ('tenants', 'name'), ('tenants', 'slug'),
        ('tenant_users', 'tenant_id'), ('tenant_users', 'user_id'),
        ('identity_accounts', 'application_user_id'), ('identity_accounts', 'email')
    ) AS want(tbl, col)
    -- pg_attribute, not information_schema.columns: the latter lists only the
    -- columns the applying login holds a privilege on.
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = to_regclass('public.' || want.tbl)
         AND a.attname = want.col
         AND a.attnum > 0
         AND NOT a.attisdropped);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql122_prerequisite_missing: SQL 122 needs SQL 99, SQL 100 and the Mortgage Desk, check and identity tables; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN (
        'public.check_messages'::regclass,
        'public.check_files'::regclass,
        'public.mortgage_handling_requests'::regclass,
        'public.homeowner_ledger_events'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql122_definer_cannot_write: the applying login must own public.check_messages, public.check_files, public.mortgage_handling_requests and public.homeowner_ledger_events (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql122_prereq$;

-- 0) When the "work returned" email of a request was claimed.
ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN IF NOT EXISTS return_emailed_at timestamptz;
COMMENT ON COLUMN public.mortgage_handling_requests.return_emailed_at IS
  'SQL 122: when the Mortgage Desk "work returned" email to the tenant was claimed (aws_mortgage_desk_return_email_claim). At most one email per request.';

-- a) The request the caller may work on (internal helper).
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_working_request(_request_id uuid, _statuses text[])
RETURNS public.mortgage_handling_requests
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.mortgage_handling_requests%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_req FROM public.mortgage_handling_requests WHERE id = _request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.is_platform_owner(), false)
     AND (v_req.assigned_employee_id IS DISTINCT FROM v_uid
          OR NOT COALESCE(public.aws_is_mortgage_ops_agent(), false)) THEN
    RAISE EXCEPTION 'not_assigned_to_you' USING ERRCODE = '42501';
  END IF;
  IF v_req.status IS NULL OR NOT (v_req.status = ANY (COALESCE(_statuses, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'request_not_in_status' USING ERRCODE = '42501';
  END IF;
  IF v_req.check_intake_item_id IS NULL THEN
    RAISE EXCEPTION 'request_has_no_check' USING ERRCODE = '22023';
  END IF;
  RETURN v_req;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_working_request(uuid, text[]) FROM PUBLIC;
COMMENT ON FUNCTION public.aws_mortgage_desk_working_request(uuid, text[]) IS
  'SQL 122: the Mortgage Desk request (locked) when the caller is its assigned mortgage agent or the platform owner and its status is one of _statuses. Owner only.';

-- b) A Desk message on the request's check.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_post_message(_request_id uuid, _body text)
RETURNS public.check_messages
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_body text := btrim(COALESCE(_body, ''));
  v_row public.check_messages%ROWTYPE;
BEGIN
  v_req := public.aws_mortgage_desk_working_request(_request_id, ARRAY['in_progress']);
  IF length(v_body) = 0 OR length(v_body) > 5000 THEN
    RAISE EXCEPTION 'invalid_body' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.check_messages (check_id, sender_id, body, is_deleted, created_at)
  VALUES (v_req.check_intake_item_id, auth.uid(), v_body, false, clock_timestamp())
  RETURNING * INTO v_row;
  RETURN v_row;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_post_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_post_message(uuid, text) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_post_message(uuid, text) IS
  'SQL 122: the assigned mortgage agent (or the platform owner) posts a message on an in-progress Desk request''s check. checksops only.';

-- c) A Desk document on the request's check.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_attach_file(
  _request_id uuid,
  _file_name text,
  _file_path text,
  _file_type text,
  _file_size bigint,
  _category text,
  _description text
)
RETURNS public.check_files
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_prefix text;
  v_path text := btrim(COALESCE(_file_path, ''));
  v_name text := btrim(COALESCE(_file_name, ''));
  v_category text := COALESCE(NULLIF(btrim(COALESCE(_category, '')), ''), 'mortgage_ops');
  v_row public.check_files%ROWTYPE;
BEGIN
  v_req := public.aws_mortgage_desk_working_request(_request_id, ARRAY['in_progress']);
  v_prefix := 'checks/' || v_req.check_intake_item_id::text || '/mortgage-ops/';
  IF length(v_path) > 512
     OR left(v_path, length(v_prefix)) IS DISTINCT FROM v_prefix
     OR length(v_path) <= length(v_prefix)
     OR position('/' IN substr(v_path, length(v_prefix) + 1)) > 0
     OR position('..' IN v_path) > 0 THEN
    RAISE EXCEPTION 'invalid_file_path' USING ERRCODE = '22023';
  END IF;
  IF length(v_name) = 0 OR length(v_name) > 255 THEN
    RAISE EXCEPTION 'invalid_file_name' USING ERRCODE = '22023';
  END IF;
  IF v_category NOT IN ('mortgage_ops', 'mortgage_ops_signature', 'mortgage_ops_shipping_label') THEN
    RAISE EXCEPTION 'invalid_category' USING ERRCODE = '22023';
  END IF;
  IF _file_size IS NOT NULL AND (_file_size < 0 OR _file_size > 26214400) THEN
    RAISE EXCEPTION 'invalid_file_size' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.check_files f
   WHERE f.check_intake_item_id = v_req.check_intake_item_id
     AND f.file_path = v_path
   ORDER BY f.created_at
   LIMIT 1;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  INSERT INTO public.check_files (
    check_intake_item_id, file_name, file_path, file_type, file_size, category, source,
    uploaded_by, description
  ) VALUES (
    v_req.check_intake_item_id, v_name, v_path, left(NULLIF(btrim(COALESCE(_file_type, '')), ''), 120),
    _file_size, v_category, 'mortgage_ops', auth.uid(),
    left(NULLIF(btrim(COALESCE(_description, '')), ''), 1000)
  )
  RETURNING * INTO v_row;
  RETURN v_row;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_attach_file(uuid, text, text, text, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_attach_file(uuid, text, text, text, bigint, text, text) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_attach_file(uuid, text, text, text, bigint, text, text) IS
  'SQL 122: the assigned mortgage agent (or the platform owner) records a document uploaded under checks/<check>/mortgage-ops/ on an in-progress Desk request''s check (check_files, source mortgage_ops). checksops only.';

-- d) Shipping / mail-to / sent and received dates of the request.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_update_shipping(_request_id uuid, _fields jsonb)
RETURNS public.mortgage_handling_requests
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_row public.mortgage_handling_requests%ROWTYPE;
  v_key text;
  v_label text;
  v_max integer;
BEGIN
  v_req := public.aws_mortgage_desk_working_request(_request_id, ARRAY['in_progress']);
  IF _fields IS NULL OR jsonb_typeof(_fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(_fields) LOOP
    v_max := CASE v_key
      WHEN 'mail_to_name' THEN 200
      WHEN 'mail_to_address' THEN 1000
      WHEN 'shipping_label_carrier' THEN 100
      WHEN 'shipping_label_tracking' THEN 200
      WHEN 'shipping_label_name' THEN 255
      WHEN 'shipping_label_path' THEN 512
      WHEN 'check_sent_date' THEN 64
      WHEN 'check_received_back_date' THEN 64
      ELSE NULL
    END;
    IF v_max IS NULL THEN
      RAISE EXCEPTION 'field_not_allowed: %', v_key USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(_fields -> v_key) NOT IN ('string', 'null')
       OR length(COALESCE(_fields ->> v_key, '')) > v_max THEN
      RAISE EXCEPTION 'invalid_field: %', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_label := NULLIF(btrim(COALESCE(_fields ->> 'shipping_label_path', '')), '');
  IF v_label IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.check_files f
     WHERE f.check_intake_item_id = v_req.check_intake_item_id
       AND f.file_path = v_label
       AND f.source = 'mortgage_ops'
  ) THEN
    RAISE EXCEPTION 'label_not_attached' USING ERRCODE = '22023';
  END IF;

  UPDATE public.mortgage_handling_requests r
     SET mail_to_name = CASE WHEN _fields ? 'mail_to_name'
           THEN NULLIF(btrim(COALESCE(_fields ->> 'mail_to_name', '')), '') ELSE r.mail_to_name END,
         mail_to_address = CASE WHEN _fields ? 'mail_to_address'
           THEN NULLIF(btrim(COALESCE(_fields ->> 'mail_to_address', '')), '') ELSE r.mail_to_address END,
         shipping_label_carrier = CASE WHEN _fields ? 'shipping_label_carrier'
           THEN NULLIF(btrim(COALESCE(_fields ->> 'shipping_label_carrier', '')), '') ELSE r.shipping_label_carrier END,
         shipping_label_tracking = CASE WHEN _fields ? 'shipping_label_tracking'
           THEN NULLIF(btrim(COALESCE(_fields ->> 'shipping_label_tracking', '')), '') ELSE r.shipping_label_tracking END,
         shipping_label_name = CASE WHEN _fields ? 'shipping_label_name'
           THEN NULLIF(btrim(COALESCE(_fields ->> 'shipping_label_name', '')), '') ELSE r.shipping_label_name END,
         shipping_label_path = CASE WHEN _fields ? 'shipping_label_path' THEN v_label ELSE r.shipping_label_path END,
         shipping_label_uploaded_at = CASE WHEN v_label IS NOT NULL THEN now() ELSE r.shipping_label_uploaded_at END,
         shipping_label_uploaded_by = CASE WHEN v_label IS NOT NULL THEN auth.uid() ELSE r.shipping_label_uploaded_by END,
         check_sent_date = CASE WHEN _fields ? 'check_sent_date'
           THEN NULLIF(btrim(COALESCE(_fields ->> 'check_sent_date', '')), '')::timestamptz ELSE r.check_sent_date END,
         check_received_back_date = CASE WHEN _fields ? 'check_received_back_date'
           THEN NULLIF(btrim(COALESCE(_fields ->> 'check_received_back_date', '')), '')::timestamptz ELSE r.check_received_back_date END,
         updated_at = now()
   WHERE r.id = v_req.id
  RETURNING r.* INTO v_row;
  RETURN v_row;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_update_shipping(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_update_shipping(uuid, jsonb) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_update_shipping(uuid, jsonb) IS
  'SQL 122: the assigned mortgage agent (or the platform owner) sets the mail-to, shipping label and sent / received dates of an in-progress Desk request. checksops only.';

-- e) The homeowner timeline row of a completed request.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_completion_timeline(_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_claim uuid;
  v_id uuid;
BEGIN
  v_req := public.aws_mortgage_desk_working_request(_request_id, ARRAY['completed']);
  SELECT COALESCE(v_req.claim_id, ci.claim_id) INTO v_claim
    FROM public.check_intake_items ci
   WHERE ci.id = v_req.check_intake_item_id;
  v_claim := COALESCE(v_claim, v_req.claim_id);
  IF v_claim IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.homeowner_ledger_events e
     WHERE e.claim_id = v_claim
       AND e.event_type = 'mortgage_update'
       AND e.payload_json ->> 'mortgage_request_id' = v_req.id::text
  ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.homeowner_ledger_events (
    tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json, created_by
  ) VALUES (
    v_req.tenant_id, v_claim, v_req.check_intake_item_id, 'mortgage_update', now(), 'Mortgage Desk',
    jsonb_build_object(
      'title', 'Mortgage company step complete',
      'note', 'Our mortgage team finished working with your mortgage company on this check.',
      'mortgage_company', v_req.mortgage_company,
      'mortgage_request_id', v_req.id
    ),
    auth.uid()
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_completion_timeline(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_completion_timeline(uuid) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_completion_timeline(uuid) IS
  'SQL 122: once per completed Desk request, the "Mortgage company step complete" homeowner timeline row (mortgage_update, no amount), posted by its assigned agent or the platform owner. checksops only.';

-- f) Claim the "work returned" email of a completed request.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_return_email_claim(_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_to text[];
  v_source text;
  v_tenant jsonb;
  v_check_number text;
  v_completed text;
  v_note text;
  v_docs jsonb;
BEGIN
  v_req := public.aws_mortgage_desk_working_request(_request_id, ARRAY['completed']);
  IF v_req.return_emailed_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_sent', 'request_id', v_req.id);
  END IF;

  SELECT to_jsonb(t) INTO v_tenant FROM public.tenants t WHERE t.id = v_req.tenant_id;

  IF v_req.requested_by IS NOT NULL THEN
    SELECT array_agg(DISTINCT lower(btrim(ia.email))) INTO v_to
      FROM public.identity_accounts ia
     WHERE ia.application_user_id = v_req.requested_by
       AND position('@' IN COALESCE(ia.email, '')) > 1
       AND EXISTS (
         SELECT 1 FROM public.tenant_users tu
          WHERE tu.tenant_id = v_req.tenant_id AND tu.user_id = v_req.requested_by);
    v_source := 'requester';
  END IF;
  IF v_to IS NULL OR cardinality(v_to) = 0 THEN
    SELECT array_agg(s.email ORDER BY s.email) INTO v_to
      FROM (
        SELECT DISTINCT lower(btrim(ia.email)) AS email
          FROM public.tenant_users tu
          JOIN public.identity_accounts ia ON ia.application_user_id = tu.user_id
         WHERE tu.tenant_id = v_req.tenant_id
           AND position('@' IN COALESCE(ia.email, '')) > 1
         ORDER BY 1
         LIMIT 25
      ) s;
    v_source := 'members';
  END IF;
  IF (v_to IS NULL OR cardinality(v_to) = 0)
     AND position('@' IN COALESCE(v_tenant ->> 'company_email', '')) > 1 THEN
    v_to := ARRAY[lower(btrim(v_tenant ->> 'company_email'))];
    v_source := 'company_email';
  END IF;
  IF v_to IS NULL OR cardinality(v_to) = 0 THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'no_recipient', 'request_id', v_req.id);
  END IF;

  SELECT ci.check_number INTO v_check_number
    FROM public.check_intake_items ci WHERE ci.id = v_req.check_intake_item_id;

  SELECT m.body INTO v_completed
    FROM public.check_messages m
   WHERE m.check_id = v_req.check_intake_item_id
     AND m.is_deleted IS NOT TRUE
     AND left(m.body, length('✅ ChecksOps Mortgage Desk completed work with ')) = '✅ ChecksOps Mortgage Desk completed work with '
   ORDER BY m.created_at DESC
   LIMIT 1;
  IF v_completed IS NOT NULL AND position(' Notes: ' IN v_completed) > 0 THEN
    v_note := NULLIF(btrim(substr(v_completed, position(' Notes: ' IN v_completed) + length(' Notes: '))), '');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('file_name', f.file_name, 'category', f.category)
                            ORDER BY f.created_at), '[]'::jsonb)
    INTO v_docs
    FROM public.check_files f
   WHERE f.check_intake_item_id = v_req.check_intake_item_id
     AND f.source = 'mortgage_ops';

  UPDATE public.mortgage_handling_requests SET return_emailed_at = now() WHERE id = v_req.id;

  RETURN jsonb_build_object(
    'claimed', true,
    'request_id', v_req.id,
    'tenant_id', v_req.tenant_id,
    'tenant_name', v_tenant ->> 'name',
    'tenant_slug', v_tenant ->> 'slug',
    'check_id', v_req.check_intake_item_id,
    'check_number', v_check_number,
    'mortgage_company', v_req.mortgage_company,
    'completed_at', v_req.completed_at,
    'note', v_note,
    'documents', v_docs,
    'recipients', to_jsonb(v_to),
    'recipient_source', v_source
  );
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_return_email_claim(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_return_email_claim(uuid) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_return_email_claim(uuid) IS
  'SQL 122: once per completed Desk request, claims the "work returned" email (return_emailed_at) and returns its recipients and contents. Assigned agent or platform owner. checksops only.';
