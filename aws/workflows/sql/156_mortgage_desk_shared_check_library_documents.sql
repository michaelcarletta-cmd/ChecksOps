-- SQL 156: the Mortgage Desk sees the auto-shared library documents of every tenant on the check, not only the
-- tenant that sent the request.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: owner 2026-11-11: "if a tenant uploads a check and shares the check with a partner, both the tenant and that
-- partner's documents that are automatically shared with the mortgage team show up for the mortgage team. It should
-- not just be the tenant who uploaded the check. It should be everybody shared on that check." Today only the
-- requesting tenant's documents reach a request: share_library_docs_to_mortgage_request() (aws/rls/sql 29) copies
-- NEW.tenant_id's auto-shared library:mortgage:% documents when the request is created, and
-- aws_mortgage_agent_can_read_library_path (aws/rls/sql 29, SQL 124) lets an agent open a library file only when the
-- document's tenant is the request's tenant.
--
-- What this file does: two new functions, both SECURITY DEFINER, STABLE, search_path public, row_security off,
-- owned by the applying login, EXECUTE for checksops (the API login) and the owner only. Nothing existing is
-- replaced, and no table, column, policy, grant on a table, trigger or row changes. The tenants on a request's check
-- are the request's own tenant plus the source and target tenant of every shared_checks row for that check that is
-- not revoked (revoked_at IS NULL), read live: a partner who turns auto-share on later appears, and a partner whose
-- share is revoked disappears.
--
--   a) public.aws_mortgage_desk_shared_library_documents(_request_id uuid): the auto_share_mortgage_ops
--      library:mortgage:% tenant_documents of every tenant on the request's check (the request's own tenant first, then
--      by tenant name), at most 500 rows, with the tenant's name and whether it is the requesting tenant. It answers
--      the platform owner, or a signed-in mortgage agent while the request is open (requested, in_progress) or assigned
--      to them: the same rule aws_mortgage_agent_can_read_library_path uses. Anyone else is 42501 not_authorized; a
--      missing request is 42501 too.
--   b) public.aws_mortgage_agent_can_read_shared_library_path(_candidates text[], _rel text, _user_id uuid): true only
--      when the signed-in user is _user_id, holds the mortgage_agent role, and the path is an auto_share_mortgage_ops
--      library:mortgage:% tenant_documents file of a tenant on the check of a request open or assigned to them. The
--      storage signer consults it next to aws_mortgage_agent_can_read_library_path (an API change of its own).
--
-- Refuses to run (55000 sql156_prerequisite_missing) without the relations, columns, helper functions and roles it
-- uses, and (55000 sql156_definer_cannot_read) unless the applying login owns public.mortgage_handling_requests,
-- public.shared_checks, public.tenant_documents and public.tenants without FORCE ROW LEVEL SECURITY, or is a superuser
-- or BYPASSRLS.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change: staging first, then production, through the
-- guarded SQL path (AGENTS.md).

DO $sql156_prerequisites$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_rel text;
  v_col text[];
BEGIN
  FOREACH v_col SLICE 1 IN ARRAY ARRAY[
    ['public.mortgage_handling_requests', 'tenant_id'],
    ['public.mortgage_handling_requests', 'check_intake_item_id'],
    ['public.mortgage_handling_requests', 'status'],
    ['public.mortgage_handling_requests', 'assigned_employee_id'],
    ['public.shared_checks', 'check_id'],
    ['public.shared_checks', 'source_tenant_id'],
    ['public.shared_checks', 'target_tenant_id'],
    ['public.shared_checks', 'revoked_at'],
    ['public.tenant_documents', 'tenant_id'],
    ['public.tenant_documents', 'doc_type'],
    ['public.tenant_documents', 'file_name'],
    ['public.tenant_documents', 'file_path'],
    ['public.tenant_documents', 'mime_type'],
    ['public.tenant_documents', 'file_size'],
    ['public.tenant_documents', 'auto_share_mortgage_ops'],
    ['public.tenant_documents', 'created_at'],
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
    RAISE EXCEPTION 'sql156_prerequisite_missing: %', array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    FOREACH v_rel IN ARRAY ARRAY['public.mortgage_handling_requests', 'public.shared_checks', 'public.tenant_documents', 'public.tenants'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid = to_regclass(v_rel)
          AND c.relowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
          AND NOT c.relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'sql156_definer_cannot_read: %', v_rel USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END IF;
END
$sql156_prerequisites$;

-- a) The auto-shared library documents of every tenant on a Desk request's check.
CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_shared_library_documents(_request_id uuid)
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  requesting_tenant boolean,
  tenant_document_id uuid,
  doc_type text,
  file_name text,
  file_path text,
  mime_type text,
  file_size bigint,
  created_at timestamptz
)
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
     AND NOT (
       COALESCE(public.aws_is_mortgage_ops_agent(), false)
       AND (v_req.status IN ('requested', 'in_progress') OR v_req.assigned_employee_id = v_uid)
     ) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    WITH on_check AS (
      SELECT v_req.tenant_id AS tid
      UNION
      SELECT sc.source_tenant_id FROM public.shared_checks sc
       WHERE v_req.check_intake_item_id IS NOT NULL
         AND sc.check_id = v_req.check_intake_item_id
         AND sc.revoked_at IS NULL
      UNION
      SELECT sc.target_tenant_id FROM public.shared_checks sc
       WHERE v_req.check_intake_item_id IS NOT NULL
         AND sc.check_id = v_req.check_intake_item_id
         AND sc.revoked_at IS NULL
    )
    SELECT td.tenant_id, t.name, td.tenant_id = v_req.tenant_id, td.id, td.doc_type, td.file_name, td.file_path,
           td.mime_type, td.file_size, td.created_at
      FROM public.tenant_documents td
      JOIN on_check oc ON oc.tid = td.tenant_id
      LEFT JOIN public.tenants t ON t.id = td.tenant_id
     WHERE td.auto_share_mortgage_ops = true
       AND td.doc_type LIKE 'library:mortgage:%'
     ORDER BY (td.tenant_id = v_req.tenant_id) DESC, t.name, td.tenant_id, td.doc_type, td.created_at, td.id
     LIMIT 500;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_desk_shared_library_documents(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_shared_library_documents(uuid) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_desk_shared_library_documents(uuid) IS
  'SQL 156: the auto-shared library:mortgage:% tenant_documents of every tenant on a Desk request''s check (its own tenant and the source and target of every unrevoked shared_checks row), for the platform owner or a mortgage agent while the request is open or assigned to them. checksops only.';

-- b) A mortgage agent may open such a file.
CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_can_read_shared_library_path(
  _candidates text[],
  _rel text,
  _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT auth.uid() IS NOT NULL
     AND auth.uid() = _user_id
     AND public.has_role(_user_id, 'mortgage_agent'::public.app_role)
     AND NULLIF(btrim(_rel), '') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.tenant_documents td
       JOIN public.mortgage_handling_requests r
         ON (r.status IN ('requested', 'in_progress') OR r.assigned_employee_id = _user_id)
        AND (
              r.tenant_id = td.tenant_id
           OR EXISTS (
                SELECT 1 FROM public.shared_checks sc
                 WHERE r.check_intake_item_id IS NOT NULL
                   AND sc.check_id = r.check_intake_item_id
                   AND sc.revoked_at IS NULL
                   AND (sc.source_tenant_id = td.tenant_id OR sc.target_tenant_id = td.tenant_id)
              )
            )
       WHERE td.auto_share_mortgage_ops = true
         AND td.doc_type LIKE 'library:mortgage:%'
         AND (
              split_part(td.file_path, '?', 1) = _rel
           OR td.file_path = ANY(COALESCE(_candidates, ARRAY[]::text[]))
           OR split_part(td.file_path, '?', 1) = ANY(COALESCE(_candidates, ARRAY[]::text[]))
            )
     );
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_agent_can_read_shared_library_path(text[], text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_read_shared_library_path(text[], text, uuid) TO checksops;
COMMENT ON FUNCTION public.aws_mortgage_agent_can_read_shared_library_path(text[], text, uuid) IS
  'SQL 156: true when the signed-in mortgage agent _user_id may open this auto-shared library:mortgage:% tenant_documents file: its tenant is on the check (own tenant, or source / target of an unrevoked shared_checks row) of a Desk request open or assigned to them. checksops only.';
