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

CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_can_read_library_document(_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
     AND EXISTS (
       SELECT 1
       FROM public.mortgage_request_library_documents d
       JOIN public.mortgage_handling_requests r
         ON r.id = d.request_id
        AND r.tenant_id = d.tenant_id
       WHERE d.id = _id
         AND (
           r.status IN ('requested', 'in_progress')
           OR r.assigned_employee_id = auth.uid()
         )
     );
$$;

COMMENT ON FUNCTION public.aws_mortgage_agent_can_read_library_document(uuid) IS
  'True when auth.uid() is a mortgage_agent and _id is attached to a Mortgage Desk request that is open or assigned to the agent. Does not require tenant_users membership.';

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
     AND EXISTS (
       SELECT 1
       FROM public.mortgage_request_library_documents d
       JOIN public.mortgage_handling_requests r
         ON r.id = d.request_id
        AND r.tenant_id = d.tenant_id
       WHERE (
              d.file_path = ANY(_candidates)
           OR split_part(d.file_path, '?', 1) LIKE '%' || COALESCE(_rel, '')
            )
         AND (
              r.status IN ('requested', 'in_progress')
           OR r.assigned_employee_id = _user_id
            )
     );
$$;

COMMENT ON FUNCTION public.aws_mortgage_agent_can_read_library_path(text[], text, uuid) IS
  'Mortgage Ops storage sign: attached library:mortgage file on an open or assigned request. Ignores client tenant_id. Does not grant tenant_documents or KYC/check-image/claim-file paths.';

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

COMMENT ON FUNCTION public.aws_can_manage_mortgage_library(uuid) IS
  'Tenant owner/admin (tenant_users) or aws_can_write_tenant. Mortgage agents cannot backfill.';

REVOKE ALL ON FUNCTION public.aws_mortgage_agent_can_read_library_document(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_mortgage_agent_can_read_library_path(text[], text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_manage_mortgage_library(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_read_library_document(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_read_library_path(text[], text, uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_manage_mortgage_library(uuid) TO checksops, authenticated;

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
  FOR ALL TO authenticated
  USING (public.aws_can_manage_mortgage_library(tenant_id))
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
