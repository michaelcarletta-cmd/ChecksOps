-- SQL 158: Mortgage Desk oversight for Tenant Management (the platform owner): every tenant's Desk work by status with
-- how long it has been waiting, assigning a queued request to an agent, and private notes to the assigned agent.
-- AWS only: nothing under supabase/migrations changes.
--
-- Replaces SQL 157 (aws/workflows/sql/157_mortgage_desk_oversight_and_agent_notes.sql), which was never applied: its new
-- table revoked only PUBLIC and checksops, so it would keep any grant the database's default privileges give a new table
-- (a default grant to authenticated reproduced on PostgreSQL 16), the defect that rolled SQL 117's staging apply back
-- (run 40434533070, UNRELATED_MUTATION intended_state; SQL 118). SQL 158 is SQL 157 plus the revoke of every non-owner
-- grant on public.mortgage_desk_agent_notes (SQL 118's and SQL 152's loop); the table's columns, constraints and index,
-- every function and the function grants are SQL 157's. Owner 2026-11-12: "go with SQL 158".
--
-- Why: owner 2026-11-12: "Tenant Management desk view plus 'Message agent'": the platform owner sees all Mortgage Ops
-- Desk work for the tenants (queued, in progress, completed, plus the directory) and how long each item has been
-- sitting; "Message agent" emails the assigned agent AND writes a note on the request (owner chose "Both"). Owner
-- 2026-11-12 decisions: "Tenant management and the agent assigned can see the notes"; "If no agent then tenant
-- management can assign"; "Note is only visible to agent"; tenant management is the platform owner only; assigning a
-- queued request starts it (as the agent's own accept does).
--
-- What this file does:
--   1) A new table public.mortgage_desk_agent_notes (one row per note: request, author, the agent it was written to,
--      body, email outcome). ROW LEVEL SECURITY on, no policy, no table grant: only the functions below, which run as
--      the table owner, read or write it. The tenant never sees a note: it is not a check message.
--   2) Six new functions, all SECURITY DEFINER, search_path public, row_security off, owned by the applying login,
--      EXECUTE for checksops (the API login) and the owner only. Nothing existing is replaced.
--      a) aws_mortgage_desk_overview(_tenant_id uuid, _status text, _limit integer, _offset integer): Desk requests
--         (requested, in_progress, completed; one tenant or all), each with its tenant, assigned agent's name, when it
--         entered its current status, seconds in that status, turnaround once completed, its note count and the
--         total matching count. Platform owner only.
--      b) aws_mortgage_desk_assignable_agents(): active mortgage agents (the mortgage_agent role, not inactive in
--         mortgage_agent_accounts) with their name and how many requests they have in progress. Platform owner only.
--      c) aws_mortgage_desk_assign_agent(_request_id uuid, _agent_id uuid): a queued request (requested, unassigned)
--         becomes in_progress for that agent with accepted_at now(), the same row change the agent's own accept makes
--         (workflow-rpc.mjs accept_mortgage_handling_request), plus a mortgage_ops_request_audit row (action
--         'assign'). Returns what the API needs to email the agent. Platform owner only.
--      d) aws_mortgage_desk_add_agent_note(_request_id uuid, _body text): a note (1 to 2000 characters) to the agent
--         assigned to the request (in_progress or completed), at most 10 per request per hour. Returns what the API
--         needs to email the agent. Platform owner only.
--      e) aws_mortgage_desk_record_agent_note_email(_note_id uuid, _status text): the API records the email outcome
--         (sent, failed, skipped) of a note it just wrote. Platform owner only, once per note.
--      f) aws_mortgage_desk_agent_notes(_request_id uuid): the notes of a request, for the platform owner or the
--         agent it is assigned to (a mortgage agent signed in as assigned_employee_id). Nobody else.
--
-- Refuses to run (55000 sql158_prerequisite_missing) without the relations, columns, helper functions and roles it
-- uses, and (55000 sql158_definer_cannot_read) unless the applying login owns public.mortgage_handling_requests,
-- public.mortgage_ops_request_audit, public.mortgage_agent_accounts, public.identity_accounts, public.profiles,
-- public.user_roles and public.tenants without FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change: staging first, then production, through the
-- guarded SQL path (AGENTS.md).

DO $sql158_prerequisites$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_rel text;
  v_col text[];
BEGIN
  FOREACH v_col SLICE 1 IN ARRAY ARRAY[
    ['public.mortgage_handling_requests', 'id'],
    ['public.mortgage_handling_requests', 'tenant_id'],
    ['public.mortgage_handling_requests', 'status'],
    ['public.mortgage_handling_requests', 'assigned_employee_id'],
    ['public.mortgage_handling_requests', 'mortgage_company'],
    ['public.mortgage_handling_requests', 'mortgage_servicer'],
    ['public.mortgage_handling_requests', 'loan_number'],
    ['public.mortgage_handling_requests', 'claim_number'],
    ['public.mortgage_handling_requests', 'homeowner_name'],
    ['public.mortgage_handling_requests', 'created_at'],
    ['public.mortgage_handling_requests', 'accepted_at'],
    ['public.mortgage_handling_requests', 'completed_at'],
    ['public.mortgage_handling_requests', 'updated_at'],
    ['public.mortgage_ops_request_audit', 'mortgage_request_id'],
    ['public.mortgage_ops_request_audit', 'actor_id'],
    ['public.mortgage_ops_request_audit', 'action'],
    ['public.mortgage_ops_request_audit', 'reason'],
    ['public.mortgage_ops_request_audit', 'from_status'],
    ['public.mortgage_ops_request_audit', 'to_status'],
    ['public.mortgage_ops_request_audit', 'payload'],
    ['public.mortgage_agent_accounts', 'application_user_id'],
    ['public.mortgage_agent_accounts', 'status'],
    ['public.identity_accounts', 'application_user_id'],
    ['public.identity_accounts', 'email'],
    ['public.profiles', 'id'],
    ['public.profiles', 'email'],
    ['public.profiles', 'full_name'],
    ['public.user_roles', 'user_id'],
    ['public.user_roles', 'role'],
    ['public.tenants', 'id'],
    ['public.tenants', 'name']
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(v_col[1]) AND a.attname = v_col[2] AND NOT a.attisdropped
    ) THEN
      v_missing := array_append(v_missing, v_col[1] || '.' || v_col[2]);
    END IF;
  END LOOP;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    v_missing := array_append(v_missing, 'auth.uid()');
  END IF;
  IF to_regprocedure('public.is_platform_owner()') IS NULL THEN
    v_missing := array_append(v_missing, 'public.is_platform_owner()');
  END IF;
  IF to_regprocedure('public.aws_is_mortgage_ops_agent()') IS NULL THEN
    v_missing := array_append(v_missing, 'public.aws_is_mortgage_ops_agent()');
  END IF;
  IF to_regprocedure('public.has_role(uuid, public.app_role)') IS NULL THEN
    v_missing := array_append(v_missing, 'public.has_role(uuid, public.app_role)');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops') THEN
    v_missing := array_append(v_missing, 'role checksops');
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'sql158_prerequisite_missing: %', array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    FOREACH v_rel IN ARRAY ARRAY['public.mortgage_handling_requests', 'public.mortgage_ops_request_audit', 'public.mortgage_agent_accounts',
                                 'public.identity_accounts', 'public.profiles', 'public.user_roles', 'public.tenants'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid = to_regclass(v_rel)
          AND c.relowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
          AND NOT c.relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'sql158_definer_cannot_read: %', v_rel USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END IF;
END
$sql158_prerequisites$;

-- 1) Private notes to the assigned agent. No policy and no grant: only the SECURITY DEFINER functions below touch it.
CREATE TABLE IF NOT EXISTS public.mortgage_desk_agent_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.mortgage_handling_requests(id) ON DELETE CASCADE,
  author_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  body text NOT NULL CONSTRAINT mortgage_desk_agent_notes_body_length CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  email_status text NOT NULL DEFAULT 'pending'
    CONSTRAINT mortgage_desk_agent_notes_email_status CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped')),
  emailed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mortgage_desk_agent_notes_request_idx
  ON public.mortgage_desk_agent_notes (request_id, created_at DESC);
ALTER TABLE public.mortgage_desk_agent_notes ENABLE ROW LEVEL SECURITY;
-- No grant to anyone but the owner, whatever the database's default privileges gave the new table (SQL 118, SQL 152).
DO $sql158_table_acl$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT a.grantee
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = 'public.mortgage_desk_agent_notes'::regclass
      AND a.grantee <> c.relowner
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE 'REVOKE ALL ON TABLE public.mortgage_desk_agent_notes FROM PUBLIC';
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE public.mortgage_desk_agent_notes FROM %I', pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END
$sql158_table_acl$;
COMMENT ON TABLE public.mortgage_desk_agent_notes IS
  'SQL 158: notes from Tenant Management (the platform owner) to the Mortgage Desk agent assigned to a request. Seen only by the platform owner and that agent, through aws_mortgage_desk_agent_notes(uuid); never on the check thread. RLS on, no policy, no grant.';

-- a) Every tenant's Desk work by status, with how long it has been waiting.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_overview(
  _tenant_id uuid DEFAULT NULL,
  _status text DEFAULT NULL,
  _limit integer DEFAULT 200,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  request_id uuid,
  tenant_id uuid,
  tenant_name text,
  status text,
  mortgage_company text,
  loan_number text,
  claim_number text,
  homeowner_name text,
  assigned_agent_id uuid,
  assigned_agent_name text,
  created_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  status_since timestamptz,
  seconds_in_status bigint,
  turnaround_seconds bigint,
  note_count integer,
  last_note_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF _status IS NOT NULL AND _status NOT IN ('requested', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH base AS (
      SELECT r.*,
             CASE r.status
               WHEN 'requested' THEN r.created_at
               WHEN 'in_progress' THEN COALESCE(r.accepted_at, r.created_at)
               ELSE COALESCE(r.completed_at, r.accepted_at, r.created_at)
             END AS since
        FROM public.mortgage_handling_requests r
       WHERE r.status IN ('requested', 'in_progress', 'completed')
         AND (_status IS NULL OR r.status = _status)
         AND (_tenant_id IS NULL OR r.tenant_id = _tenant_id)
    )
    SELECT b.id, b.tenant_id, t.name, b.status, COALESCE(b.mortgage_company, b.mortgage_servicer), b.loan_number,
           b.claim_number, b.homeowner_name, b.assigned_employee_id,
           NULLIF(btrim(COALESCE(p.full_name, '')), ''),
           b.created_at, b.accepted_at, b.completed_at, b.since,
           floor(extract(epoch FROM (now() - b.since)))::bigint,
           CASE WHEN b.status = 'completed' AND b.completed_at IS NOT NULL
                THEN floor(extract(epoch FROM (b.completed_at - b.created_at)))::bigint END,
           COALESCE(n.cnt, 0)::integer, n.last_at,
           count(*) OVER ()
      FROM base b
      LEFT JOIN public.tenants t ON t.id = b.tenant_id
      LEFT JOIN public.profiles p ON p.id = b.assigned_employee_id
      LEFT JOIN LATERAL (
        SELECT count(*) AS cnt, max(an.created_at) AS last_at
          FROM public.mortgage_desk_agent_notes an WHERE an.request_id = b.id
      ) n ON true
     ORDER BY CASE b.status WHEN 'requested' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
              CASE WHEN b.status = 'completed' THEN b.since END DESC NULLS LAST,
              b.since ASC, b.id
     LIMIT LEAST(GREATEST(COALESCE(_limit, 200), 1), 500)
    OFFSET GREATEST(COALESCE(_offset, 0), 0);
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_overview(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_overview(uuid, text, integer, integer) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_overview(uuid, text, integer, integer) IS
  'SQL 158: Mortgage Desk requests (requested, in_progress, completed; one tenant or all), queued oldest first, then in progress oldest first, then completed newest first, with the assigned agent''s name, seconds in the current status, turnaround once completed, note count and the total count. Platform owner only. checksops only.';

-- b) Active mortgage agents a queued request can be assigned to.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_assignable_agents()
RETURNS TABLE (agent_id uuid, agent_name text, in_progress_count integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.user_id, NULLIF(btrim(COALESCE(p.full_name, '')), ''),
           (SELECT count(*)::integer FROM public.mortgage_handling_requests r
             WHERE r.assigned_employee_id = a.user_id AND r.status = 'in_progress')
      FROM (SELECT DISTINCT ur.user_id FROM public.user_roles ur WHERE ur.role = 'mortgage_agent'::public.app_role) a
      LEFT JOIN public.profiles p ON p.id = a.user_id
     WHERE NOT EXISTS (
       SELECT 1 FROM public.mortgage_agent_accounts m
        WHERE m.application_user_id = a.user_id AND m.status <> 'active')
     ORDER BY 2 NULLS LAST, 1;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_assignable_agents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_assignable_agents() TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_assignable_agents() IS
  'SQL 158: active mortgage agents (mortgage_agent role, not inactive in mortgage_agent_accounts) with their name and in-progress count, for assigning a queued Desk request. Platform owner only. checksops only.';

-- c) Assign a queued request to an agent: it starts, as the agent's own accept would.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_assign_agent(_request_id uuid, _agent_id uuid)
RETURNS TABLE (request_id uuid, agent_id uuid, agent_name text, agent_email text, accepted_at timestamptz,
               tenant_name text, mortgage_company text, loan_number text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
BEGIN
  IF NOT COALESCE(public.is_platform_owner(), false) OR _request_id IS NULL OR _agent_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_role(_agent_id, 'mortgage_agent'::public.app_role)
     OR EXISTS (SELECT 1 FROM public.mortgage_agent_accounts m WHERE m.application_user_id = _agent_id AND m.status <> 'active') THEN
    RAISE EXCEPTION 'agent_not_assignable' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_req FROM public.mortgage_handling_requests r WHERE r.id = _request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'requested' OR v_req.assigned_employee_id IS NOT NULL THEN
    RAISE EXCEPTION 'already_taken' USING ERRCODE = '55000';
  END IF;
  UPDATE public.mortgage_handling_requests r
     SET assigned_employee_id = _agent_id,
         status = 'in_progress',
         accepted_at = COALESCE(r.accepted_at, now()),
         updated_at = now()
   WHERE r.id = _request_id
  RETURNING * INTO v_req;
  INSERT INTO public.mortgage_ops_request_audit (mortgage_request_id, actor_id, action, reason, from_status, to_status, payload)
  VALUES (_request_id, auth.uid(), 'assign', 'Assigned by Tenant Management', 'requested', 'in_progress',
          jsonb_build_object('agent_id', _agent_id, 'source', 'sql158'));
  RETURN QUERY
    SELECT v_req.id, _agent_id, NULLIF(btrim(COALESCE(p.full_name, '')), ''), COALESCE(ia.email, p.email),
           v_req.accepted_at, t.name, COALESCE(v_req.mortgage_company, v_req.mortgage_servicer), v_req.loan_number
      FROM (SELECT 1) one
      LEFT JOIN public.profiles p ON p.id = _agent_id
      LEFT JOIN public.identity_accounts ia ON ia.application_user_id = _agent_id
      LEFT JOIN public.tenants t ON t.id = v_req.tenant_id;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_assign_agent(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_assign_agent(uuid, uuid) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_assign_agent(uuid, uuid) IS
  'SQL 158: Tenant Management (the platform owner) assigns a queued (requested, unassigned) Desk request to an active mortgage agent: in_progress, accepted_at now(), as the agent''s accept does, plus a mortgage_ops_request_audit row (action assign). Returns the agent''s email for the API''s notice. checksops only.';

-- d) A private note to the agent assigned to the request.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_add_agent_note(_request_id uuid, _body text)
RETURNS TABLE (note_id uuid, request_id uuid, agent_id uuid, agent_name text, agent_email text, created_at timestamptz,
               tenant_name text, mortgage_company text, loan_number text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_body text := btrim(COALESCE(_body, ''));
  v_note public.mortgage_desk_agent_notes%ROWTYPE;
BEGIN
  IF NOT COALESCE(public.is_platform_owner(), false) OR _request_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF length(v_body) < 1 OR length(v_body) > 2000 THEN
    RAISE EXCEPTION 'invalid_body' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_req FROM public.mortgage_handling_requests r WHERE r.id = _request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.assigned_employee_id IS NULL OR v_req.status NOT IN ('in_progress', 'completed') THEN
    RAISE EXCEPTION 'no_assigned_agent' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM public.mortgage_desk_agent_notes an
       WHERE an.request_id = _request_id AND an.created_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.mortgage_desk_agent_notes (request_id, author_id, agent_id, body)
  VALUES (_request_id, auth.uid(), v_req.assigned_employee_id, v_body)
  RETURNING * INTO v_note;
  RETURN QUERY
    SELECT v_note.id, _request_id, v_note.agent_id, NULLIF(btrim(COALESCE(p.full_name, '')), ''), COALESCE(ia.email, p.email),
           v_note.created_at, t.name, COALESCE(v_req.mortgage_company, v_req.mortgage_servicer), v_req.loan_number
      FROM (SELECT 1) one
      LEFT JOIN public.profiles p ON p.id = v_note.agent_id
      LEFT JOIN public.identity_accounts ia ON ia.application_user_id = v_note.agent_id
      LEFT JOIN public.tenants t ON t.id = v_req.tenant_id;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_add_agent_note(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_add_agent_note(uuid, text) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_add_agent_note(uuid, text) IS
  'SQL 158: Tenant Management (the platform owner) writes a private note (1 to 2000 characters, at most 10 per request per hour) to the agent assigned to an in-progress or completed Desk request. Returns the agent''s email for the API''s email. checksops only.';

-- e) The API records the email outcome of a note it just wrote (once).
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_record_agent_note_email(_note_id uuid, _status text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF NOT COALESCE(public.is_platform_owner(), false) OR _note_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF _status IS NULL OR _status NOT IN ('sent', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.mortgage_desk_agent_notes an
     SET email_status = _status,
         emailed_at = CASE WHEN _status = 'sent' THEN now() ELSE an.emailed_at END
   WHERE an.id = _note_id AND an.email_status = 'pending';
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_record_agent_note_email(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_record_agent_note_email(uuid, text) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_record_agent_note_email(uuid, text) IS
  'SQL 158: records the email outcome (sent, failed, skipped) of a pending agent note, once. Platform owner only. checksops only.';

-- f) The notes of a request: the platform owner, or the agent it is assigned to. Nobody else.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_agent_notes(_request_id uuid)
RETURNS TABLE (note_id uuid, request_id uuid, author_id uuid, agent_id uuid, body text, email_status text,
               emailed_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.mortgage_handling_requests%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_req FROM public.mortgage_handling_requests r WHERE r.id = _request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.is_platform_owner(), false)
     AND NOT (COALESCE(public.aws_is_mortgage_ops_agent(), false) AND v_req.assigned_employee_id = v_uid) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT an.id, an.request_id, an.author_id, an.agent_id, an.body, an.email_status, an.emailed_at, an.created_at
      FROM public.mortgage_desk_agent_notes an
     WHERE an.request_id = _request_id
     ORDER BY an.created_at DESC, an.id
     LIMIT 200;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_agent_notes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_agent_notes(uuid) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_agent_notes(uuid) IS
  'SQL 158: the private Tenant Management notes of a Desk request, newest first, for the platform owner or the mortgage agent the request is assigned to. checksops only.';
