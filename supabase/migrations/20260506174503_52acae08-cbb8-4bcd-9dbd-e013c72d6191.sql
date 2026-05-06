
INSERT INTO storage.buckets (id, name, public)
VALUES ('tenant-documents', 'tenant-documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.tenant_documents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('w9', 'license', 'insurance')),
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size BIGINT,
  uploaded_by UUID,
  notes TEXT,
  expires_at DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_documents_tenant ON public.tenant_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_documents_type ON public.tenant_documents(tenant_id, doc_type);

ALTER TABLE public.tenant_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members view documents"
  ON public.tenant_documents FOR SELECT
  USING (public.is_tenant_member(auth.uid(), tenant_id));

CREATE POLICY "Tenant admins manage documents"
  ON public.tenant_documents FOR ALL
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.is_tenant_admin(auth.uid(), tenant_id)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR public.is_tenant_admin(auth.uid(), tenant_id)
  );

CREATE TRIGGER trg_tenant_documents_updated_at
  BEFORE UPDATE ON public.tenant_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Tenant members read tenant-documents"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'tenant-documents'
    AND public.is_tenant_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "Tenant admins write tenant-documents"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'tenant-documents'
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.is_tenant_admin(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  );

CREATE POLICY "Tenant admins update tenant-documents"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'tenant-documents'
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.is_tenant_admin(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  );

CREATE POLICY "Tenant admins delete tenant-documents"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'tenant-documents'
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.is_tenant_admin(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  );
