CREATE TABLE public.check_files (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  check_intake_item_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT,
  file_size BIGINT,
  category TEXT NOT NULL DEFAULT 'other',
  source TEXT NOT NULL DEFAULT 'manual',
  signature_request_id UUID REFERENCES public.signature_requests(id) ON DELETE SET NULL,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_check_files_check_intake ON public.check_files(check_intake_item_id);
CREATE INDEX idx_check_files_signature_request ON public.check_files(signature_request_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.check_files TO authenticated;
GRANT ALL ON public.check_files TO service_role;

ALTER TABLE public.check_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view check files"
  ON public.check_files FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert check files"
  ON public.check_files FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update check files"
  ON public.check_files FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Uploader or admin can delete check files"
  ON public.check_files FOR DELETE TO authenticated
  USING (uploaded_by = auth.uid() OR public.has_role(auth.uid(), 'admin'));