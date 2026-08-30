-- Only Mortgage Docs (library:mortgage:*) should auto-attach to Mortgage Desk requests.

-- 1) Clear the flag on any existing non-mortgage library docs
UPDATE public.tenant_documents
SET auto_share_mortgage_ops = false
WHERE doc_type LIKE 'library:%'
  AND doc_type NOT LIKE 'library:mortgage:%'
  AND auto_share_mortgage_ops = true;

-- 2) Harden the auto-share trigger to only include the mortgage category
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