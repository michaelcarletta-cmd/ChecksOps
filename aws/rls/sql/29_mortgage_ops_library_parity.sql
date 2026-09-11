-- Mortgage Ops document-library AWS parity overlay.
-- Idempotent. Do not apply from this PR; commit only.
--
-- Restores desk-agent read of attached library rows without granting general
-- tenant_documents or tenant-documents storage access.
-- Auto-share remains category-filtered to library:mortgage:%.
--
-- Lifecycle (this PR): new attachments only for requested/in_progress.
-- Assigned agents retain read of already-attached rows after close.
-- Turning auto_share_mortgage_ops off updates the flag only; existing join
-- rows are not deleted (Lovable). Revocation is a follow-up.
--
-- Apply only after 11_access_helpers.sql, 20_write_helpers.sql, and
-- 24_complete_write_policies.sql (completeAuth). Immediate REVOKE ALL FROM
-- PUBLIC follows each SECURITY DEFINER CREATE so a later statement failure
-- cannot leave PUBLIC EXECUTE.
--
-- Grants: EXECUTE to checksops and authenticated. checksops is the AWS API
-- login role. PUBLIC is never left granted.

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
     AND position(CHR(0) in _rel) = 0
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
  'Mortgage Ops storage sign: exact attached library:mortgage file_path (or query-stripped equal) on an open or assigned request. % and _ are ordinary filename characters. Ignores client tenant_id.';

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

GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_read_library_document(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_read_library_path(text[], text, uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_manage_mortgage_library(uuid) TO checksops, authenticated;

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
  WITH CHECK (public.aws_can_manage_mortgage_library(tenant_id));

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
