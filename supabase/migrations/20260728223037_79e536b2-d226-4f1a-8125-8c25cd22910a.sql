
ALTER TABLE public.tenant_documents
  ADD COLUMN IF NOT EXISTS auto_share_mortgage_ops boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.mortgage_request_library_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.mortgage_handling_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  tenant_document_id uuid REFERENCES public.tenant_documents(id) ON DELETE SET NULL,
  doc_type text,
  file_name text NOT NULL,
  file_path text NOT NULL,
  bucket text NOT NULL DEFAULT 'tenant-documents',
  mime_type text,
  file_size bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, file_path)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mortgage_request_library_documents TO authenticated;
GRANT ALL ON public.mortgage_request_library_documents TO service_role;

ALTER TABLE public.mortgage_request_library_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read shared library docs"
ON public.mortgage_request_library_documents
FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'mortgage_agent'::app_role)
  OR tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid())
);

CREATE POLICY "manage shared library docs"
ON public.mortgage_request_library_documents
FOR INSERT TO authenticated
WITH CHECK (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'mortgage_agent'::app_role)
  OR tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid())
);

CREATE POLICY "delete shared library docs"
ON public.mortgage_request_library_documents
FOR DELETE TO authenticated
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'mortgage_agent'::app_role)
  OR tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid())
);

CREATE TRIGGER set_mortgage_request_library_documents_updated_at
BEFORE UPDATE ON public.mortgage_request_library_documents
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

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
  ON CONFLICT (request_id, file_path) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_share_library_docs_to_mortgage_request ON public.mortgage_handling_requests;
CREATE TRIGGER trg_share_library_docs_to_mortgage_request
AFTER INSERT ON public.mortgage_handling_requests
FOR EACH ROW EXECUTE FUNCTION public.share_library_docs_to_mortgage_request();

CREATE POLICY "Mortgage ops read shared tenant-documents"
ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'tenant-documents'
  AND (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'mortgage_agent'::app_role))
  AND EXISTS (
    SELECT 1 FROM public.mortgage_request_library_documents d
    WHERE d.file_path = storage.objects.name
  )
);
