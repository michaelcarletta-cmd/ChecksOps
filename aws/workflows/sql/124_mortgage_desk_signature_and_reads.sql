-- AWS: the Mortgage Desk sends a check's document for signature, reads the
-- check's thread, files and signature requests, and posts homeowner timeline
-- updates (SQL 124). Forward migration on top of SQL 122 (the Desk returns its
-- work to the tenant). AWS only: nothing under supabase/migrations changes.
--
-- Why (owner, 2026-10-28): the Desk works a check it is assigned to without
-- being a member of the requesting tenant, so the tenant-scoped reads and
-- the e-sign create path (esign.mjs requireSignatureActor: tenant_users
-- members only) refuse it. Owner's answers:
--   - who signs: the insured and/or the tenant (the contractor company that
--     owns the check), so signer_type is only policyholder (the insured; a
--     co-insured is a second policyholder, as SQL 83 counts them) or
--     contractor (the type the tenant flow, SignatureRequests.tsx, offers for
--     the contractor company), up to 4 signers;
--   - which files: any file can be uploaded or sent, but the document sent
--     must be a check_files row of that check, so it is always on the check.
--     Every way a file reaches the check is a check_files row: the Desk's
--     uploads (SQL 122 aws_mortgage_desk_attach_file, any file type), the
--     tenant's and contractor's check files, and Document Library documents
--     the API copies to checks/<check>/mortgage-ops/<name> and registers
--     through that same SQL 122 function (category mortgage_ops), so this
--     file adds no attach path. The document sent must be a .pdf or .docx,
--     the two types the tenant e-sign flow accepts (SignatureRequests.tsx
--     upload: "Please upload a PDF or DOCX file");
--   - the email sender name is ChecksOps (an API concern, nothing here);
--   - the tenant sees the Desk's signature requests as any other request of
--     the check.
-- Defaults kept for v1: the assigned agent may READ while the request is
-- in_progress or completed; no Desk resend, void or delete; timeline updates
-- are not mirrored to the tenant thread.
--
-- Same approach as SQL 99, SQL 111 and SQL 122: no new table, column,
-- trigger, policy, RLS change or table grant; SECURITY DEFINER functions that
-- check the caller themselves, called by the API as the signed-in user.
--
-- What this file does (all functions SECURITY DEFINER, search_path = public,
-- owned by the applying login like the other aws/workflows/sql DEFINER
-- functions; like SQL 99 and SQL 122 none sets row_security, so the triggers
-- their writes fire, trg_mirror_signature_request_to_homeowner_ledger
-- ("Document sent for signature" once sent_at is set),
-- assign_case_on_signature_requests and assign_case_on_ledger_events, keep
-- running as they do today):
--
-- a) public.aws_mortgage_desk_readable_request(_request_id uuid) RETURNS
--    public.mortgage_handling_requests (internal; EXECUTE: the owner only).
--    STABLE. The same rule as SQL 122's aws_mortgage_desk_working_request
--    (the caller is set, the request exists and has a check, and the caller is
--    the platform owner or the assigned agent holding mortgage_agent), with
--    the statuses fixed to in_progress and completed and no row lock. Raises
--    42501 not_authorized / not_assigned_to_you / request_not_in_status or
--    22023 request_has_no_check, in the same order as SQL 122.
-- b) public.aws_mortgage_desk_messages(_request_id uuid) RETURNS TABLE (id,
--    sender_id, body, created_at, from_desk). a); the check's check_messages
--    that are not deleted, the newest 500, returned oldest first. from_desk:
--    the sender is the request's assigned agent, holds mortgage_agent
--    (has_role) or is the platform owner (aws_is_platform_owner_user, SQL 90).
-- c) public.aws_mortgage_desk_check_files(_request_id uuid) RETURNS TABLE (id,
--    file_name, file_path, file_type, file_size, category, description,
--    source, created_at, signature_request_id). a); every check_files row of
--    the check, oldest first.
-- d) public.aws_mortgage_desk_signature_requests(_request_id uuid) RETURNS
--    jsonb. a); an array of the check's signature_requests (id,
--    document_name, document_path, status, created_at, sent_at,
--    final_pdf_path, created_by), newest first, each with signers[] (id,
--    signer_name, signer_email, signer_type, signing_order, status,
--    signed_at, viewed_at, delivery_status) in signing order. Never
--    access_token, token_hash or expires_at.
-- e) public.aws_mortgage_desk_can_read_path(_candidates text[], _rel text)
--    RETURNS boolean. STABLE; never raises. The storage-sign check for the
--    Desk, modeled on aws_mortgage_agent_can_read_library_path (aws/rls/sql
--    29): true only when the caller passes a) for some request whose check X
--    has the path (_rel, or one of _candidates; a stored path compared with
--    its query string stripped) as a check_files.file_path, as a
--    signature_requests.document_path or final_pdf_path of a request on X, or
--    when the path is exactly checks/<X>/mortgage-ops/<one name> (no further
--    '/', no '..'; SQL 122's upload prefix).
-- f) public.aws_mortgage_desk_create_signature_request(_request_id uuid,
--    _document_name text, _document_path text, _document_type text,
--    _field_data jsonb, _signers jsonb, _expires_at timestamptz) RETURNS
--    jsonb. SQL 122's working gate with status in_progress. Checks:
--      - _document_path (trimmed): at most 512 characters, no '..', ends in
--        .pdf or .docx (any case), and equal to the query-stripped file_path of a
--        check_files row of the request's check; else 42501
--        document_not_on_check;
--      - _document_name trimmed, 1 to 255 characters (22023
--        invalid_document_name); _document_type empty / null, or one of
--        contract, check_endorsement, payment_authorization,
--        work_authorization, proof_of_loss, lien_waiver (the seeded
--        signature_document_presets and detectDocumentType values; 22023
--        invalid_document_type);
--      - _signers: an array of 1 to 4 objects with only the keys signer_name
--        (1 to 200), signer_email (at most 254, ^[^@\s]+@[^@\s]+\.[^@\s]+$),
--        signer_type (policyholder or contractor, default policyholder; a
--        subset of the signature_signers valid_signer_type set),
--        signing_order (an integer 1 to 4,
--        default its position, unique) and access_token (exactly 64
--        lowercase hex characters, minted by the API as esign.mjs
--        generateRawToken does; unique); else 22023 invalid_signers /
--        invalid_signer: <n>;
--      - _field_data: null (an empty array) or an array of at most 200
--        objects, each with type signature, date, text or checkbox (the
--        FieldPlacementEditor set), signerIndex (default 0) an integer below
--        the signer count, page (default 1) an integer of at least 1, and x,
--        y, width, height numbers when present; else 22023
--        invalid_field_data: <n>;
--      - _expires_at later than now() and at most 30 days ahead (22023
--        invalid_expires_at).
--    Writes, as esign.mjs createSignatureRequestRows and
--    runSendSignatureRequest do: one signature_requests row (claim_id = the
--    request's claim, else its check's; check_intake_item_id;
--    document_name; document_path; document_type; field_data; status
--    'draft'; created_by auth.uid()); one signature_signers row per signer
--    (status 'pending', access_token, token_hash = hex sha256 of the token's
--    UTF-8 bytes (esign.mjs hashToken), expires_at); one signature_fields row
--    per field (the columns and defaults of esign.mjs: signer_index,
--    field_type, label, page, x, y, width 33, height 6, required unless
--    false, placeholder, checkbox_label; the field's id when it is a uuid);
--    check_files.signature_request_id on the check's rows of that path (as
--    linkCheckFileToRequest); one esign_event_logs row (stage
--    mortgage_desk_request_created, payload {source 'mortgage_desk',
--    mortgage_request_id}). Returns {signature_request_id, signers [{id,
--    signer_name, signer_email}]} (no token).
-- g) public.aws_mortgage_desk_record_signature_delivery(_request_id uuid,
--    _signature_request_id uuid, _results jsonb) RETURNS jsonb. SQL 122's
--    working gate with status in_progress. The signature request (locked)
--    must be on the request's check (42501 signature_request_not_on_check),
--    created by the caller or the caller is the platform owner (42501
--    not_your_signature_request), status 'draft' with sent_at null (42501
--    signature_request_not_draft). _results is an array with exactly one
--    object per signer of that request ({signer_id, success boolean,
--    message_id, error}; 22023 invalid_results otherwise). Sets, exactly as
--    esign.mjs runSendSignatureRequest does after its sends: per signer
--    delivery_status 'sent', email_sent_at now(), email_provider_message_id,
--    or delivery_status 'failed', delivery_error (at most 300 characters);
--    then the request's status 'pending' (or 'failed' when every send
--    failed), delivery_mode 'aws_ses_or_sink', sent_at now() (null when every
--    send failed), last_error ('All emails failed', 'Some emails failed' or
--    null), last_attempted_at now(), provider_status (emails_sent,
--    emails_failed or emails_partially_failed); one esign_event_logs row
--    (stage mortgage_desk_delivery_recorded). Returns {signature_request_id,
--    status, provider_status, sent, failed, total}.
-- h) public.aws_mortgage_desk_post_timeline(_request_id uuid, _kind text,
--    _note text) RETURNS uuid. SQL 122's working gate with status
--    in_progress. _kind mortgage_followup or mortgage_update (22023
--    invalid_kind); _note trimmed, 1 to 2000 characters (22023 invalid_note);
--    the request's claim (its claim_id, else its check's), else 22023
--    request_has_no_claim. Inserts one homeowner_ledger_events row: tenant_id
--    of the request, the claim, the check, event_type _kind, occurred_at
--    now(), actor_label as MortgageOpsRequestDetail.tsx postMortgageUpdate
--    builds it ('Called <mortgage company>' / 'Called mortgage company' for a
--    follow-up, 'Mortgage Ops update' otherwise), payload_json {note,
--    mortgage_company, desk_request_id, source 'mortgage_desk'}, created_by
--    auth.uid(). The payload never carries mortgage_request_id: SQL 122's
--    aws_mortgage_desk_completion_timeline skips its completion row when a
--    mortgage_update event with that key exists. Returns the new id.
--
-- EXECUTE on b) to h): checksops only (the API login), revoked from PUBLIC.
-- a) is the owner's only.
--
-- Not changed: no table, column, trigger, policy, RLS flag or grant on a
-- table; no existing function (SQL 122's functions are called, not
-- replaced), row or column. Agents still cannot read check_messages,
-- check_files or signature_requests, or write signature_requests,
-- signature_signers, signature_fields, esign_event_logs, check_files or
-- homeowner_ledger_events, directly. No resend, void or delete path for the
-- Desk; the existing tenant e-sign paths are unchanged.
--
-- Refuses to run (55000 sql124_prerequisite_missing) without SQL 122
-- (aws_mortgage_desk_working_request(uuid, text[])), SQL 100
-- (aws_is_mortgage_ops_agent()), SQL 90 (aws_is_platform_owner_user(uuid)),
-- is_platform_owner(), has_role(uuid, app_role), auth.uid(), sha256(bytea),
-- role checksops and the tables and columns it uses, and (55000
-- sql124_definer_cannot_write) unless the applying login owns
-- public.check_messages, public.check_files, public.mortgage_handling_requests,
-- public.homeowner_ledger_events, public.signature_requests,
-- public.signature_signers, public.signature_fields and public.esign_event_logs
-- without FORCE ROW LEVEL SECURITY (or is a superuser or BYPASSRLS).
--
-- Numbering: SQL 124 (after SQL 123).
--
-- Transactions: no BEGIN/COMMIT; the guarded SQL executor runs it inside one
-- transaction. Idempotent: CREATE OR REPLACE.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a
-- read-only inspect, staging first.

DO $sql124_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('auth.uid()', to_regprocedure('auth.uid()')::oid),
      ('public.aws_mortgage_desk_working_request(uuid, text[]) (SQL 122)', to_regprocedure('public.aws_mortgage_desk_working_request(uuid, text[])')::oid),
      ('public.aws_is_mortgage_ops_agent() (SQL 100)', to_regprocedure('public.aws_is_mortgage_ops_agent()')::oid),
      ('public.aws_is_platform_owner_user(uuid) (SQL 90)', to_regprocedure('public.aws_is_platform_owner_user(uuid)')::oid),
      ('public.is_platform_owner()', to_regprocedure('public.is_platform_owner()')::oid),
      ('type public.app_role', to_regtype('public.app_role')::oid),
      ('public.has_role(uuid, public.app_role)', to_regprocedure('public.has_role(uuid, public.app_role)')::oid),
      ('pg_catalog.sha256(bytea)', to_regprocedure('pg_catalog.sha256(bytea)')::oid),
      ('public.check_messages', to_regclass('public.check_messages')::oid),
      ('public.check_files', to_regclass('public.check_files')::oid),
      ('public.check_intake_items', to_regclass('public.check_intake_items')::oid),
      ('public.mortgage_handling_requests', to_regclass('public.mortgage_handling_requests')::oid),
      ('public.homeowner_ledger_events', to_regclass('public.homeowner_ledger_events')::oid),
      ('public.signature_requests', to_regclass('public.signature_requests')::oid),
      ('public.signature_signers', to_regclass('public.signature_signers')::oid),
      ('public.signature_fields', to_regclass('public.signature_fields')::oid),
      ('public.esign_event_logs', to_regclass('public.esign_event_logs')::oid),
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
        ('check_files', 'category'), ('check_files', 'description'), ('check_files', 'source'),
        ('check_files', 'created_at'), ('check_files', 'signature_request_id'),
        ('check_intake_items', 'id'), ('check_intake_items', 'claim_id'),
        ('mortgage_handling_requests', 'id'), ('mortgage_handling_requests', 'tenant_id'),
        ('mortgage_handling_requests', 'claim_id'), ('mortgage_handling_requests', 'status'),
        ('mortgage_handling_requests', 'check_intake_item_id'),
        ('mortgage_handling_requests', 'assigned_employee_id'),
        ('mortgage_handling_requests', 'mortgage_company'),
        ('homeowner_ledger_events', 'id'),
        ('homeowner_ledger_events', 'tenant_id'), ('homeowner_ledger_events', 'claim_id'),
        ('homeowner_ledger_events', 'check_id'), ('homeowner_ledger_events', 'event_type'),
        ('homeowner_ledger_events', 'occurred_at'), ('homeowner_ledger_events', 'actor_label'),
        ('homeowner_ledger_events', 'payload_json'), ('homeowner_ledger_events', 'created_by'),
        ('signature_requests', 'id'), ('signature_requests', 'claim_id'),
        ('signature_requests', 'check_intake_item_id'), ('signature_requests', 'document_name'),
        ('signature_requests', 'document_path'), ('signature_requests', 'document_type'),
        ('signature_requests', 'field_data'), ('signature_requests', 'status'),
        ('signature_requests', 'created_at'), ('signature_requests', 'created_by'),
        ('signature_requests', 'sent_at'), ('signature_requests', 'final_pdf_path'),
        ('signature_requests', 'delivery_mode'), ('signature_requests', 'provider_status'),
        ('signature_requests', 'last_error'), ('signature_requests', 'last_attempted_at'),
        ('signature_signers', 'id'), ('signature_signers', 'signature_request_id'),
        ('signature_signers', 'signer_name'), ('signature_signers', 'signer_email'),
        ('signature_signers', 'signer_type'), ('signature_signers', 'signing_order'),
        ('signature_signers', 'status'), ('signature_signers', 'signed_at'),
        ('signature_signers', 'viewed_at'), ('signature_signers', 'access_token'),
        ('signature_signers', 'token_hash'), ('signature_signers', 'expires_at'),
        ('signature_signers', 'delivery_status'), ('signature_signers', 'delivery_error'),
        ('signature_signers', 'email_sent_at'), ('signature_signers', 'email_provider_message_id'),
        ('signature_signers', 'created_at'),
        ('signature_fields', 'id'), ('signature_fields', 'signature_request_id'),
        ('signature_fields', 'signer_index'), ('signature_fields', 'field_type'),
        ('signature_fields', 'label'), ('signature_fields', 'page'), ('signature_fields', 'x'),
        ('signature_fields', 'y'), ('signature_fields', 'width'), ('signature_fields', 'height'),
        ('signature_fields', 'required'), ('signature_fields', 'placeholder'),
        ('signature_fields', 'checkbox_label'),
        ('esign_event_logs', 'request_id'), ('esign_event_logs', 'signer_id'),
        ('esign_event_logs', 'claim_id'), ('esign_event_logs', 'stage'),
        ('esign_event_logs', 'status'), ('esign_event_logs', 'message'),
        ('esign_event_logs', 'payload')
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
    RAISE EXCEPTION 'sql124_prerequisite_missing: SQL 124 needs SQL 90, SQL 100, SQL 122 and the Mortgage Desk, check and e-sign tables; missing %',
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
        'public.homeowner_ledger_events'::regclass,
        'public.signature_requests'::regclass,
        'public.signature_signers'::regclass,
        'public.signature_fields'::regclass,
        'public.esign_event_logs'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql124_definer_cannot_write: the applying login must own public.check_messages, public.check_files, public.mortgage_handling_requests, public.homeowner_ledger_events, public.signature_requests, public.signature_signers, public.signature_fields and public.esign_event_logs (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql124_prereq$;

-- a) The request the caller may read (internal helper).
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_readable_request(_request_id uuid)
RETURNS public.mortgage_handling_requests
LANGUAGE plpgsql
STABLE
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
  SELECT * INTO v_req FROM public.mortgage_handling_requests WHERE id = _request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.is_platform_owner(), false)
     AND (v_req.assigned_employee_id IS DISTINCT FROM v_uid
          OR NOT COALESCE(public.aws_is_mortgage_ops_agent(), false)) THEN
    RAISE EXCEPTION 'not_assigned_to_you' USING ERRCODE = '42501';
  END IF;
  IF v_req.status IS NULL OR v_req.status NOT IN ('in_progress', 'completed') THEN
    RAISE EXCEPTION 'request_not_in_status' USING ERRCODE = '42501';
  END IF;
  IF v_req.check_intake_item_id IS NULL THEN
    RAISE EXCEPTION 'request_has_no_check' USING ERRCODE = '22023';
  END IF;
  RETURN v_req;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_readable_request(uuid) FROM PUBLIC;
COMMENT ON FUNCTION public.aws_mortgage_desk_readable_request(uuid) IS
  'SQL 124: the Mortgage Desk request (not locked) when the caller is its assigned mortgage agent or the platform owner and its status is in_progress or completed. Owner only.';

-- b) The check's thread, as the Desk reads it.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_messages(_request_id uuid)
RETURNS TABLE (id uuid, sender_id uuid, body text, created_at timestamptz, from_desk boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
BEGIN
  v_req := public.aws_mortgage_desk_readable_request(_request_id);
  RETURN QUERY
    SELECT m.id, m.sender_id, m.body, m.created_at,
           COALESCE(
             m.sender_id = v_req.assigned_employee_id
             OR COALESCE(public.has_role(m.sender_id, 'mortgage_agent'::public.app_role), false)
             OR COALESCE(public.aws_is_platform_owner_user(m.sender_id), false),
             false)
      FROM (
        SELECT cm.id, cm.sender_id, cm.body, cm.created_at
          FROM public.check_messages cm
         WHERE cm.check_id = v_req.check_intake_item_id
           AND cm.is_deleted IS NOT TRUE
         ORDER BY cm.created_at DESC, cm.id DESC
         LIMIT 500
      ) m
     ORDER BY m.created_at, m.id;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_messages(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_messages(uuid) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_messages(uuid) IS
  'SQL 124: the newest 500 messages (oldest first, not deleted) of an in-progress or completed Desk request''s check, each marked from_desk, for its assigned mortgage agent or the platform owner. checksops only.';

-- c) The check's files, as the Desk reads them.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_check_files(_request_id uuid)
RETURNS TABLE (
  id uuid,
  file_name text,
  file_path text,
  file_type text,
  file_size bigint,
  category text,
  description text,
  source text,
  created_at timestamptz,
  signature_request_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
BEGIN
  v_req := public.aws_mortgage_desk_readable_request(_request_id);
  RETURN QUERY
    SELECT f.id, f.file_name, f.file_path, f.file_type, f.file_size, f.category, f.description,
           f.source, f.created_at, f.signature_request_id
      FROM public.check_files f
     WHERE f.check_intake_item_id = v_req.check_intake_item_id
     ORDER BY f.created_at, f.id;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_check_files(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_check_files(uuid) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_check_files(uuid) IS
  'SQL 124: every check_files row of an in-progress or completed Desk request''s check, for its assigned mortgage agent or the platform owner. checksops only.';

-- d) The check's signature requests and their signers (no token columns).
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_signature_requests(_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_out jsonb;
BEGIN
  v_req := public.aws_mortgage_desk_readable_request(_request_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', sr.id,
           'document_name', sr.document_name,
           'document_path', sr.document_path,
           'status', sr.status,
           'created_at', sr.created_at,
           'sent_at', sr.sent_at,
           'final_pdf_path', sr.final_pdf_path,
           'created_by', sr.created_by,
           'signers', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', s.id,
                      'signer_name', s.signer_name,
                      'signer_email', s.signer_email,
                      'signer_type', s.signer_type,
                      'signing_order', s.signing_order,
                      'status', s.status,
                      'signed_at', s.signed_at,
                      'viewed_at', s.viewed_at,
                      'delivery_status', s.delivery_status
                    ) ORDER BY s.signing_order, s.created_at, s.id)
               FROM public.signature_signers s
              WHERE s.signature_request_id = sr.id
           ), '[]'::jsonb)
         ) ORDER BY sr.created_at DESC, sr.id), '[]'::jsonb)
    INTO v_out
    FROM public.signature_requests sr
   WHERE sr.check_intake_item_id = v_req.check_intake_item_id;
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_signature_requests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_signature_requests(uuid) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_signature_requests(uuid) IS
  'SQL 124: the signature requests of an in-progress or completed Desk request''s check with their signers (never access_token, token_hash or expires_at), for its assigned mortgage agent or the platform owner. checksops only.';

-- e) May the caller sign a storage read of this path (never raises).
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_can_read_path(_candidates text[], _rel text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND NULLIF(btrim(COALESCE(_rel, '')), '') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.mortgage_handling_requests r
       WHERE r.check_intake_item_id IS NOT NULL
         AND r.status IN ('in_progress', 'completed')
         AND (
              COALESCE(public.is_platform_owner(), false)
           OR (r.assigned_employee_id = auth.uid()
               AND COALESCE(public.aws_is_mortgage_ops_agent(), false))
             )
         AND (
              EXISTS (
                SELECT 1 FROM public.check_files f
                 WHERE f.check_intake_item_id = r.check_intake_item_id
                   AND (
                        split_part(f.file_path, '?', 1) = _rel
                     OR f.file_path = ANY(COALESCE(_candidates, ARRAY[]::text[]))
                     OR split_part(f.file_path, '?', 1) = ANY(COALESCE(_candidates, ARRAY[]::text[]))
                       ))
           OR EXISTS (
                SELECT 1
                  FROM public.signature_requests sr
                  CROSS JOIN LATERAL (VALUES (sr.document_path), (sr.final_pdf_path)) AS p(path)
                 WHERE sr.check_intake_item_id = r.check_intake_item_id
                   AND p.path IS NOT NULL
                   AND (
                        split_part(p.path, '?', 1) = _rel
                     OR p.path = ANY(COALESCE(_candidates, ARRAY[]::text[]))
                     OR split_part(p.path, '?', 1) = ANY(COALESCE(_candidates, ARRAY[]::text[]))
                       ))
           OR EXISTS (
                SELECT 1
                  FROM unnest(array_append(COALESCE(_candidates, ARRAY[]::text[]), _rel)) AS c(path)
                 WHERE c.path IS NOT NULL
                   AND length(c.path) <= 512
                   AND left(c.path, length('checks/' || r.check_intake_item_id::text || '/mortgage-ops/'))
                       = 'checks/' || r.check_intake_item_id::text || '/mortgage-ops/'
                   AND length(c.path) > length('checks/' || r.check_intake_item_id::text || '/mortgage-ops/')
                   AND position('/' IN substr(c.path, length('checks/' || r.check_intake_item_id::text || '/mortgage-ops/') + 1)) = 0
                   AND position('..' IN c.path) = 0)
             )
     );
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_can_read_path(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_can_read_path(text[], text) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_can_read_path(text[], text) IS
  'SQL 124: Mortgage Desk storage sign. True when the caller (assigned mortgage agent or platform owner) has an in-progress or completed Desk request whose check holds the path as a check file (query-stripped), a signature request document or final PDF, or is checks/<check>/mortgage-ops/<name>. Exact matches only. checksops only.';

-- f) A Desk signature request on a document of the request's check.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_create_signature_request(
  _request_id uuid,
  _document_name text,
  _document_path text,
  _document_type text,
  _field_data jsonb,
  _signers jsonb,
  _expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_path text := btrim(COALESCE(_document_path, ''));
  v_name text := btrim(COALESCE(_document_name, ''));
  v_type text := NULLIF(btrim(COALESCE(_document_type, '')), '');
  v_fields jsonb := COALESCE(_field_data, '[]'::jsonb);
  v_claim uuid;
  v_count integer;
  v_signer jsonb;
  v_field jsonb;
  v_key text;
  v_i integer;
  v_order integer;
  v_orders integer[] := ARRAY[]::integer[];
  v_tokens text[] := ARRAY[]::text[];
  v_sig_id uuid := gen_random_uuid();
  v_out_signers jsonb;
BEGIN
  v_req := public.aws_mortgage_desk_working_request(_request_id, ARRAY['in_progress']);

  IF length(v_path) = 0
     OR length(v_path) > 512
     OR position('..' IN v_path) > 0
     OR NOT (lower(v_path) LIKE '%.pdf' OR lower(v_path) LIKE '%.docx')
     OR NOT EXISTS (
       SELECT 1 FROM public.check_files f
        WHERE f.check_intake_item_id = v_req.check_intake_item_id
          AND split_part(f.file_path, '?', 1) = v_path) THEN
    RAISE EXCEPTION 'document_not_on_check' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) = 0 OR length(v_name) > 255 THEN
    RAISE EXCEPTION 'invalid_document_name' USING ERRCODE = '22023';
  END IF;
  IF v_type IS NOT NULL AND v_type NOT IN (
       'contract', 'check_endorsement', 'payment_authorization', 'work_authorization',
       'proof_of_loss', 'lien_waiver') THEN
    RAISE EXCEPTION 'invalid_document_type' USING ERRCODE = '22023';
  END IF;

  -- Signers.
  IF _signers IS NULL OR jsonb_typeof(_signers) IS DISTINCT FROM 'array'
     OR jsonb_array_length(_signers) < 1 OR jsonb_array_length(_signers) > 4 THEN
    RAISE EXCEPTION 'invalid_signers' USING ERRCODE = '22023';
  END IF;
  v_count := jsonb_array_length(_signers);
  FOR v_i IN 0 .. v_count - 1 LOOP
    v_signer := _signers -> v_i;
    IF jsonb_typeof(v_signer) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'invalid_signer: %', v_i + 1 USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_signer) LOOP
      IF v_key NOT IN ('signer_name', 'signer_email', 'signer_type', 'signing_order', 'access_token') THEN
        RAISE EXCEPTION 'invalid_signer: %', v_i + 1 USING ERRCODE = '22023';
      END IF;
    END LOOP;
    IF jsonb_typeof(v_signer -> 'signer_name') IS DISTINCT FROM 'string'
       OR length(btrim(v_signer ->> 'signer_name')) NOT BETWEEN 1 AND 200
       OR jsonb_typeof(v_signer -> 'signer_email') IS DISTINCT FROM 'string'
       OR length(btrim(v_signer ->> 'signer_email')) > 254
       OR btrim(v_signer ->> 'signer_email') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       OR (jsonb_typeof(v_signer -> 'signer_type') IS NOT NULL
           AND jsonb_typeof(v_signer -> 'signer_type') <> 'null'
           AND (jsonb_typeof(v_signer -> 'signer_type') <> 'string'
                OR (v_signer ->> 'signer_type') NOT IN ('policyholder', 'contractor')))
       OR jsonb_typeof(v_signer -> 'access_token') IS DISTINCT FROM 'string'
       OR (v_signer ->> 'access_token') !~ '^[0-9a-f]{64}$'
       OR (v_signer ->> 'access_token') = ANY (v_tokens) THEN
      RAISE EXCEPTION 'invalid_signer: %', v_i + 1 USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_signer -> 'signing_order') IS NULL OR jsonb_typeof(v_signer -> 'signing_order') = 'null' THEN
      v_order := v_i + 1;
    ELSIF jsonb_typeof(v_signer -> 'signing_order') = 'number'
          AND (v_signer ->> 'signing_order')::numeric IN (1, 2, 3, 4) THEN
      v_order := (v_signer ->> 'signing_order')::numeric::integer;
    ELSE
      RAISE EXCEPTION 'invalid_signer: %', v_i + 1 USING ERRCODE = '22023';
    END IF;
    IF v_order = ANY (v_orders) THEN
      RAISE EXCEPTION 'invalid_signer: %', v_i + 1 USING ERRCODE = '22023';
    END IF;
    v_orders := v_orders || v_order;
    v_tokens := v_tokens || (v_signer ->> 'access_token');
  END LOOP;

  -- Fields.
  IF jsonb_typeof(v_fields) IS DISTINCT FROM 'array' OR jsonb_array_length(v_fields) > 200 THEN
    RAISE EXCEPTION 'invalid_field_data' USING ERRCODE = '22023';
  END IF;
  FOR v_i IN 0 .. jsonb_array_length(v_fields) - 1 LOOP
    v_field := v_fields -> v_i;
    IF jsonb_typeof(v_field) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_field -> 'type') IS DISTINCT FROM 'string'
       OR (v_field ->> 'type') NOT IN ('signature', 'date', 'text', 'checkbox')
       OR (jsonb_typeof(v_field -> 'signerIndex') IS NOT NULL AND jsonb_typeof(v_field -> 'signerIndex') <> 'null'
           AND (jsonb_typeof(v_field -> 'signerIndex') <> 'number'
                OR (v_field ->> 'signerIndex')::numeric <> trunc((v_field ->> 'signerIndex')::numeric)
                OR (v_field ->> 'signerIndex')::numeric < 0
                OR (v_field ->> 'signerIndex')::numeric >= v_count))
       OR (jsonb_typeof(v_field -> 'page') IS NOT NULL AND jsonb_typeof(v_field -> 'page') <> 'null'
           AND (jsonb_typeof(v_field -> 'page') <> 'number'
                OR (v_field ->> 'page')::numeric <> trunc((v_field ->> 'page')::numeric)
                OR (v_field ->> 'page')::numeric < 1
                OR (v_field ->> 'page')::numeric > 10000)) THEN
      RAISE EXCEPTION 'invalid_field_data: %', v_i + 1 USING ERRCODE = '22023';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['x', 'y', 'width', 'height'] LOOP
      IF jsonb_typeof(v_field -> v_key) IS NOT NULL AND jsonb_typeof(v_field -> v_key) NOT IN ('number', 'null') THEN
        RAISE EXCEPTION 'invalid_field_data: %', v_i + 1 USING ERRCODE = '22023';
      END IF;
    END LOOP;
    FOREACH v_key IN ARRAY ARRAY['label', 'placeholder', 'checkboxLabel'] LOOP
      IF jsonb_typeof(v_field -> v_key) IS NOT NULL AND jsonb_typeof(v_field -> v_key) NOT IN ('string', 'null') THEN
        RAISE EXCEPTION 'invalid_field_data: %', v_i + 1 USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;

  IF _expires_at IS NULL OR _expires_at <= now() OR _expires_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'invalid_expires_at' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(v_req.claim_id, ci.claim_id) INTO v_claim
    FROM public.check_intake_items ci
   WHERE ci.id = v_req.check_intake_item_id;
  v_claim := COALESCE(v_claim, v_req.claim_id);

  INSERT INTO public.signature_requests (
    id, claim_id, check_intake_item_id, document_name, document_path, document_type,
    field_data, status, created_by
  ) VALUES (
    v_sig_id, v_claim, v_req.check_intake_item_id, v_name, v_path, v_type,
    v_fields, 'draft', auth.uid()
  );

  INSERT INTO public.signature_signers (
    signature_request_id, signer_name, signer_email, signer_type, signing_order, status,
    access_token, token_hash, expires_at
  )
  SELECT v_sig_id,
         btrim(s.value ->> 'signer_name'),
         btrim(s.value ->> 'signer_email'),
         COALESCE(s.value ->> 'signer_type', 'policyholder'),
         COALESCE((s.value ->> 'signing_order')::numeric::integer, s.ordinality::integer),
         'pending',
         s.value ->> 'access_token',
         encode(sha256(convert_to(s.value ->> 'access_token', 'UTF8')), 'hex'),
         _expires_at
    FROM jsonb_array_elements(_signers) WITH ORDINALITY AS s(value, ordinality)
   ORDER BY s.ordinality;

  INSERT INTO public.signature_fields (
    id, signature_request_id, signer_index, field_type, label, page, x, y, width, height,
    required, placeholder, checkbox_label
  )
  SELECT CASE WHEN (f.value ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              THEN (f.value ->> 'id')::uuid ELSE gen_random_uuid() END,
         v_sig_id,
         COALESCE((f.value ->> 'signerIndex')::numeric::integer, 0),
         f.value ->> 'type',
         NULLIF(f.value ->> 'label', ''),
         COALESCE((f.value ->> 'page')::numeric::integer, 1),
         COALESCE((f.value ->> 'x')::numeric, 0),
         COALESCE((f.value ->> 'y')::numeric, 0),
         COALESCE((f.value ->> 'width')::numeric, 33),
         COALESCE((f.value ->> 'height')::numeric, 6),
         (f.value -> 'required') IS DISTINCT FROM 'false'::jsonb,
         NULLIF(f.value ->> 'placeholder', ''),
         NULLIF(f.value ->> 'checkboxLabel', '')
    FROM jsonb_array_elements(v_fields) WITH ORDINALITY AS f(value, ordinality)
   ORDER BY f.ordinality;

  UPDATE public.check_files f
     SET signature_request_id = v_sig_id
   WHERE f.check_intake_item_id = v_req.check_intake_item_id
     AND split_part(f.file_path, '?', 1) = v_path;

  INSERT INTO public.esign_event_logs (request_id, signer_id, claim_id, stage, status, message, payload)
  VALUES (
    v_sig_id, NULL, v_claim, 'mortgage_desk_request_created', 'ok',
    'Mortgage Desk signature request created',
    jsonb_build_object('source', 'mortgage_desk', 'mortgage_request_id', v_req.id,
                       'application_user_id', auth.uid())
  );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', s.id, 'signer_name', s.signer_name, 'signer_email', s.signer_email)
         ORDER BY s.signing_order, s.id), '[]'::jsonb)
    INTO v_out_signers
    FROM public.signature_signers s
   WHERE s.signature_request_id = v_sig_id;

  RETURN jsonb_build_object('signature_request_id', v_sig_id, 'signers', v_out_signers);
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_create_signature_request(uuid, text, text, text, jsonb, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_create_signature_request(uuid, text, text, text, jsonb, jsonb, timestamptz) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_create_signature_request(uuid, text, text, text, jsonb, jsonb, timestamptz) IS
  'SQL 124: the assigned mortgage agent (or the platform owner) creates a draft signature request (1 to 4 insured or contractor signers, API-minted tokens) on a PDF or DOCX already on an in-progress Desk request''s check. checksops only.';

-- g) Record the API's email sends of a Desk signature request.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_record_signature_delivery(
  _request_id uuid,
  _signature_request_id uuid,
  _results jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_sig public.signature_requests%ROWTYPE;
  v_total integer;
  v_sent integer;
  v_failed integer;
  v_all_failed boolean;
  v_status text;
  v_provider_status text;
BEGIN
  v_req := public.aws_mortgage_desk_working_request(_request_id, ARRAY['in_progress']);

  SELECT * INTO v_sig
    FROM public.signature_requests sr
   WHERE sr.id = _signature_request_id
     AND sr.check_intake_item_id = v_req.check_intake_item_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'signature_request_not_on_check' USING ERRCODE = '42501';
  END IF;
  IF v_sig.created_by IS DISTINCT FROM auth.uid() AND NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_your_signature_request' USING ERRCODE = '42501';
  END IF;
  IF v_sig.status IS DISTINCT FROM 'draft' OR v_sig.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'signature_request_not_draft' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.signature_signers s WHERE s.signature_request_id = v_sig.id FOR UPDATE;
  SELECT count(*)::integer INTO v_total FROM public.signature_signers s WHERE s.signature_request_id = v_sig.id;

  -- Exactly one result per signer of this request.
  IF _results IS NULL OR jsonb_typeof(_results) IS DISTINCT FROM 'array'
     OR jsonb_array_length(_results) <> v_total
     OR v_total = 0
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(_results) r(value)
        WHERE jsonb_typeof(r.value) IS DISTINCT FROM 'object'
           OR jsonb_typeof(r.value -> 'signer_id') IS DISTINCT FROM 'string'
           OR (r.value ->> 'signer_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(r.value -> 'success') IS DISTINCT FROM 'boolean'
           OR (jsonb_typeof(r.value -> 'message_id') IS NOT NULL AND jsonb_typeof(r.value -> 'message_id') NOT IN ('string', 'null'))
           OR (jsonb_typeof(r.value -> 'error') IS NOT NULL AND jsonb_typeof(r.value -> 'error') NOT IN ('string', 'null')))
     OR (SELECT count(DISTINCT s.id)
           FROM jsonb_array_elements(_results) r(value)
           JOIN public.signature_signers s
             ON s.id = (r.value ->> 'signer_id')::uuid
            AND s.signature_request_id = v_sig.id) <> v_total THEN
    RAISE EXCEPTION 'invalid_results' USING ERRCODE = '22023';
  END IF;

  UPDATE public.signature_signers s
     SET delivery_status = 'sent',
         email_sent_at = now(),
         email_provider_message_id = left(NULLIF(r.value ->> 'message_id', ''), 300)
    FROM jsonb_array_elements(_results) r(value)
   WHERE s.signature_request_id = v_sig.id
     AND s.id = (r.value ->> 'signer_id')::uuid
     AND (r.value -> 'success') = 'true'::jsonb;

  UPDATE public.signature_signers s
     SET delivery_status = 'failed',
         delivery_error = left(COALESCE(NULLIF(btrim(COALESCE(r.value ->> 'error', '')), ''), 'Email delivery failed'), 300)
    FROM jsonb_array_elements(_results) r(value)
   WHERE s.signature_request_id = v_sig.id
     AND s.id = (r.value ->> 'signer_id')::uuid
     AND (r.value -> 'success') = 'false'::jsonb;

  SELECT count(*) FILTER (WHERE (r.value -> 'success') = 'true'::jsonb)::integer,
         count(*) FILTER (WHERE (r.value -> 'success') = 'false'::jsonb)::integer
    INTO v_sent, v_failed
    FROM jsonb_array_elements(_results) r(value);
  v_all_failed := v_sent = 0;
  v_status := CASE WHEN v_all_failed THEN 'failed' ELSE 'pending' END;
  v_provider_status := CASE
    WHEN v_failed = 0 THEN 'emails_sent'
    WHEN v_all_failed THEN 'emails_failed'
    ELSE 'emails_partially_failed'
  END;

  UPDATE public.signature_requests
     SET status = v_status,
         delivery_mode = 'aws_ses_or_sink',
         sent_at = CASE WHEN v_all_failed THEN NULL ELSE now() END,
         last_error = CASE WHEN v_all_failed THEN 'All emails failed'
                           WHEN v_failed > 0 THEN 'Some emails failed'
                           ELSE NULL END,
         last_attempted_at = now(),
         provider_status = v_provider_status
   WHERE id = v_sig.id;

  INSERT INTO public.esign_event_logs (request_id, signer_id, claim_id, stage, status, message, payload)
  VALUES (
    v_sig.id, NULL, v_sig.claim_id, 'mortgage_desk_delivery_recorded',
    CASE WHEN v_all_failed THEN 'error' ELSE 'ok' END,
    CASE WHEN v_all_failed THEN 'All emails failed'
         WHEN v_failed > 0 THEN 'Some emails failed'
         ELSE 'Emails sent' END,
    jsonb_build_object('source', 'mortgage_desk', 'mortgage_request_id', v_req.id,
                       'application_user_id', auth.uid(),
                       'sent', v_sent, 'failed', v_failed, 'total', v_total)
  );

  RETURN jsonb_build_object(
    'signature_request_id', v_sig.id,
    'status', v_status,
    'provider_status', v_provider_status,
    'sent', v_sent,
    'failed', v_failed,
    'total', v_total
  );
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_record_signature_delivery(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_record_signature_delivery(uuid, uuid, jsonb) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_record_signature_delivery(uuid, uuid, jsonb) IS
  'SQL 124: once per Desk signature request (still a draft), records the API''s per-signer email results and moves the request to pending (or failed), as esign.mjs does after its sends. Its creator or the platform owner, on an in-progress Desk request. checksops only.';

-- h) A Desk update on the homeowner timeline.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_post_timeline(_request_id uuid, _kind text, _note text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_kind text := btrim(COALESCE(_kind, ''));
  v_note text := btrim(COALESCE(_note, ''));
  v_claim uuid;
  v_id uuid;
BEGIN
  v_req := public.aws_mortgage_desk_working_request(_request_id, ARRAY['in_progress']);
  IF v_kind NOT IN ('mortgage_followup', 'mortgage_update') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF length(v_note) = 0 OR length(v_note) > 2000 THEN
    RAISE EXCEPTION 'invalid_note' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(v_req.claim_id, ci.claim_id) INTO v_claim
    FROM public.check_intake_items ci
   WHERE ci.id = v_req.check_intake_item_id;
  v_claim := COALESCE(v_claim, v_req.claim_id);
  IF v_claim IS NULL THEN
    RAISE EXCEPTION 'request_has_no_claim' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.homeowner_ledger_events (
    tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json, created_by
  ) VALUES (
    v_req.tenant_id, v_claim, v_req.check_intake_item_id, v_kind, now(),
    CASE WHEN v_kind = 'mortgage_followup'
         THEN 'Called ' || COALESCE(NULLIF(v_req.mortgage_company, ''), 'mortgage company')
         ELSE 'Mortgage Ops update' END,
    jsonb_build_object(
      'note', v_note,
      'mortgage_company', v_req.mortgage_company,
      'desk_request_id', v_req.id,
      'source', 'mortgage_desk'
    ),
    auth.uid()
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_post_timeline(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_post_timeline(uuid, text, text) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_post_timeline(uuid, text, text) IS
  'SQL 124: the assigned mortgage agent (or the platform owner) posts a follow-up or update (mortgage_followup / mortgage_update, payload desk_request_id, never mortgage_request_id) on the homeowner timeline of an in-progress Desk request. checksops only.';
