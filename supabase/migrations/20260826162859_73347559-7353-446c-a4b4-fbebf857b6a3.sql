CREATE TABLE IF NOT EXISTS public.tenant_vetting_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  file_name text NOT NULL,
  file_path text NOT NULL,
  file_size_bytes bigint,
  content_type text,
  review_status text NOT NULL DEFAULT 'pending',
  review_notes text,
  expires_on date,
  uploaded_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_vetting_documents_tenant_idx ON public.tenant_vetting_documents(tenant_id, doc_type);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_vetting_documents TO authenticated;
GRANT ALL ON public.tenant_vetting_documents TO service_role;

ALTER TABLE public.tenant_vetting_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members read vetting documents"
ON public.tenant_vetting_documents FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role) OR public.is_tenant_member(auth.uid(), tenant_id));

CREATE POLICY "Tenant admins insert vetting documents"
ON public.tenant_vetting_documents FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role) OR public.is_tenant_admin(auth.uid(), tenant_id));

CREATE POLICY "Tenant admins update vetting documents"
ON public.tenant_vetting_documents FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role) OR public.is_tenant_admin(auth.uid(), tenant_id))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role) OR public.is_tenant_admin(auth.uid(), tenant_id));

CREATE POLICY "Tenant admins delete vetting documents"
ON public.tenant_vetting_documents FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role) OR public.is_tenant_admin(auth.uid(), tenant_id));

CREATE TRIGGER tenant_vetting_documents_updated_at
BEFORE UPDATE ON public.tenant_vetting_documents
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();