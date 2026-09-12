-- Mortgage Ops document-library AWS parity overlay.
-- Idempotent. Do not apply from this PR; commit only.
--
-- Restores desk-agent read of attached library rows without granting general
-- tenant_documents or tenant-documents storage access.
-- Auto-share remains category-filtered to library:mortgage:%.
--
-- Lifecycle: new attachments only for requested/in_progress.
-- Assigned agents retain read of already-attached rows after close.
-- Turning auto_share_mortgage_ops off updates the flag only; existing join
-- rows are not deleted (Lovable). Revocation is a follow-up.
--
-- Path helper: PostgreSQL text cannot contain NUL, and AWS normalizePath
-- already rejects NUL before the database call. Do not evaluate CHR(0) or
-- any other NUL literal here.
--
-- INSERT: aws_can_insert_mortgage_library_document reads authoritative
-- mortgage_handling_requests and tenant_documents rows. Client category,
-- bucket, tenant, path, or role cannot override those rows.
--
-- Apply only after 11_access_helpers.sql, 20_write_helpers.sql, and
-- 24_complete_write_policies.sql (completeAuth). Immediate REVOKE ALL FROM
-- PUBLIC follows each SECURITY DEFINER CREATE so a later statement failure
-- cannot leave PUBLIC EXECUTE.
--
-- Grants: EXECUTE to checksops and authenticated. checksops is the AWS API
-- login role. PUBLIC is never left granted.
-- Table DML: SELECT + INSERT only for authenticated/checksops. UPDATE and
-- DELETE remain table-owner/definer operations (trigger, CASCADE, SET NULL).

CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_can_read_library_document(_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
     AND _id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.mortgage_request_library_documents d
       JOIN public.mortgage_handling_requests r
         ON r.id = d.request_id
        AND r.tenant_id = d.tenant_id
       JOIN public.tenant_documents td
         ON td.id = d.tenant_document_id
        AND td.tenant_id = d.tenant_id
       WHERE d.id = _id
         AND d.tenant_document_id IS NOT NULL
         AND td.doc_type LIKE 'library:mortgage:%'
         AND (
           r.status IN ('requested', 'in_progress')
           OR r.assigned_employee_id = auth.uid()
         )
     );
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_agent_can_read_library_document(uuid) FROM PUBLIC;

COMMENT ON FUNCTION public.aws_mortgage_agent_can_read_library_document(uuid) IS
  'True when auth.uid() is a mortgage_agent and _id is an attached library:mortgage:% document on an open desk request or a request assigned to the agent. Does not require tenant_users membership.';

CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_can_read_library_path(
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
       FROM public.mortgage_request_library_documents d
       JOIN public.mortgage_handling_requests r
         ON r.id = d.request_id
        AND r.tenant_id = d.tenant_id
       JOIN public.tenant_documents td
         ON td.id = d.tenant_document_id
        AND td.tenant_id = d.tenant_id
       WHERE d.tenant_document_id IS NOT NULL
         AND td.doc_type LIKE 'library:mortgage:%'
         AND (
              split_part(d.file_path, '?', 1) = _rel
           OR d.file_path = ANY(COALESCE(_candidates, ARRAY[]::text[]))
           OR split_part(d.file_path, '?', 1) = ANY(COALESCE(_candidates, ARRAY[]::text[]))
            )
         AND (
              r.status IN ('requested', 'in_progress')
           OR r.assigned_employee_id = _user_id
            )
     );
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_agent_can_read_library_path(text[], text, uuid) FROM PUBLIC;

COMMENT ON FUNCTION public.aws_mortgage_agent_can_read_library_path(text[], text, uuid) IS
  'Mortgage Ops storage sign: exact attached library:mortgage file_path (or query-stripped equal) on an open or assigned request. % and _ are ordinary filename characters. Ignores client tenant_id. PostgreSQL text cannot contain NUL; AWS normalizePath rejects NUL before this call.';

CREATE OR REPLACE FUNCTION public.aws_can_manage_mortgage_library(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND _tenant_id IS NOT NULL
     AND (
       public.aws_can_write_tenant(_tenant_id)
       OR EXISTS (
         SELECT 1
         FROM public.tenant_users tu
         WHERE tu.user_id = auth.uid()
           AND tu.tenant_id = _tenant_id
           AND tu.role::text IN ('admin', 'owner')
       )
     );
$$;
REVOKE ALL ON FUNCTION public.aws_can_manage_mortgage_library(uuid) FROM PUBLIC;

COMMENT ON FUNCTION public.aws_can_manage_mortgage_library(uuid) IS
  'Tenant owner/admin (tenant_users) or aws_can_write_tenant. Mortgage agents cannot backfill.';

CREATE OR REPLACE FUNCTION public.aws_can_insert_mortgage_library_document(
  _tenant_id uuid,
  _request_id uuid,
  _tenant_document_id uuid,
  _file_path text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _request_tenant uuid;
  _request_status text;
  _doc_tenant uuid;
  _doc_type text;
  _doc_auto_share boolean;
  _doc_file_path text;
BEGIN
  IF _user_id IS NULL THEN
    RETURN false;
  END IF;
  IF _tenant_id IS NULL OR _request_id IS NULL OR _tenant_document_id IS NULL THEN
    RETURN false;
  END IF;
  IF _file_path IS NULL OR btrim(_file_path) = '' THEN
    RETURN false;
  END IF;
  IF position('/../' in _file_path) > 0
     OR _file_path LIKE '../%'
     OR _file_path LIKE '%/..'
     OR _file_path = '..' THEN
    RETURN false;
  END IF;
  IF NOT public.aws_can_manage_mortgage_library(_tenant_id) THEN
    RETURN false;
  END IF;

  SELECT mr.tenant_id, mr.status
    INTO _request_tenant, _request_status
  FROM public.mortgage_handling_requests mr
  WHERE mr.id = _request_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF _request_tenant IS DISTINCT FROM _tenant_id THEN
    RETURN false;
  END IF;
  IF _request_status IS DISTINCT FROM 'requested'
     AND _request_status IS DISTINCT FROM 'in_progress' THEN
    RETURN false;
  END IF;

  SELECT td.tenant_id, td.doc_type, td.auto_share_mortgage_ops, td.file_path
    INTO _doc_tenant, _doc_type, _doc_auto_share, _doc_file_path
  FROM public.tenant_documents td
  WHERE td.id = _tenant_document_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF _doc_tenant IS DISTINCT FROM _tenant_id THEN
    RETURN false;
  END IF;
  IF _doc_auto_share IS DISTINCT FROM true THEN
    RETURN false;
  END IF;
  IF _doc_type IS NULL OR _doc_type NOT LIKE 'library:mortgage:%' THEN
    RETURN false;
  END IF;
  IF _file_path IS DISTINCT FROM _doc_file_path THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.aws_can_insert_mortgage_library_document(uuid, uuid, uuid, text) FROM PUBLIC;

COMMENT ON FUNCTION public.aws_can_insert_mortgage_library_document(uuid, uuid, uuid, text) IS
  'INSERT WITH CHECK for mortgage_request_library_documents. Requires authenticated tenant owner/admin, an open same-tenant request, and an auto-shared library:mortgage:% tenant document whose file_path matches exactly. Does not trust client category, bucket, tenant, path, or JWT role.';

GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_read_library_document(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_read_library_path(text[], text, uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_manage_mortgage_library(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_insert_mortgage_library_document(uuid, uuid, uuid, text) TO checksops, authenticated;

DROP POLICY IF EXISTS "read shared library docs" ON public.mortgage_request_library_documents;
DROP POLICY IF EXISTS "manage shared library docs" ON public.mortgage_request_library_documents;
DROP POLICY IF EXISTS "delete shared library docs" ON public.mortgage_request_library_documents;
DROP POLICY IF EXISTS aws_select_mortgage_request_library_documents ON public.mortgage_request_library_documents;
CREATE POLICY aws_select_mortgage_request_library_documents ON public.mortgage_request_library_documents
  FOR SELECT TO authenticated
  USING (
    public.aws_is_cross_tenant_reader()
    OR public.aws_can_access_tenant(tenant_id)
    OR public.aws_mortgage_agent_can_read_library_document(id)
  );

DROP POLICY IF EXISTS aws_write_mortgage_request_library_documents ON public.mortgage_request_library_documents;
CREATE POLICY aws_write_mortgage_request_library_documents ON public.mortgage_request_library_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    public.aws_can_insert_mortgage_library_document(
      tenant_id,
      request_id,
      tenant_document_id,
      file_path
    )
  );

REVOKE ALL ON TABLE public.mortgage_request_library_documents FROM PUBLIC;
REVOKE UPDATE, DELETE ON TABLE public.mortgage_request_library_documents FROM authenticated;
REVOKE UPDATE, DELETE ON TABLE public.mortgage_request_library_documents FROM checksops;
GRANT SELECT, INSERT ON TABLE public.mortgage_request_library_documents TO authenticated;
GRANT SELECT, INSERT ON TABLE public.mortgage_request_library_documents TO checksops;

-- Reaffirm category filter. Trigger body is unchanged from Lovable 2026-08-30.
CREATE OR REPLACE FUNCTION public.share_library_docs_to_mortgage_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.mortgage_request_library_documents
    (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path, mime_type, file_size)
  SELECT NEW.id, NEW.tenant_id, td.id, td.doc_type, td.file_name, td.file_path, td.mime_type, td.file_size
  FROM public.tenant_documents td
  WHERE td.tenant_id = NEW.tenant_id
    AND td.auto_share_mortgage_ops = true
    AND td.doc_type LIKE 'library:mortgage:%'
  ON CONFLICT (request_id, file_path) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.share_library_docs_to_mortgage_request() FROM PUBLIC;
