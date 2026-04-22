
-- Add file_path and file_name columns to loss_draft_documents
ALTER TABLE public.loss_draft_documents
ADD COLUMN IF NOT EXISTS file_path text,
ADD COLUMN IF NOT EXISTS file_name text;

-- Create storage bucket for loss draft documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('loss-draft-documents', 'loss-draft-documents', false)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload loss draft documents
CREATE POLICY "Authenticated users can upload loss draft documents"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'loss-draft-documents');

-- Allow authenticated users to view loss draft documents
CREATE POLICY "Authenticated users can view loss draft documents"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'loss-draft-documents');

-- Allow authenticated users to delete loss draft documents
CREATE POLICY "Authenticated users can delete loss draft documents"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'loss-draft-documents');
