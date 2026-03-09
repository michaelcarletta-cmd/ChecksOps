
-- Add parent_folder_id for subfolder support
ALTER TABLE public.claim_folders
ADD COLUMN parent_folder_id UUID REFERENCES public.claim_folders(id) ON DELETE CASCADE;

-- Index for subfolder queries
CREATE INDEX idx_claim_folders_parent ON claim_folders(parent_folder_id);

-- Allow clients and contractors to create subfolders
CREATE POLICY "Portal users can create subfolders" ON public.claim_folders
FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM claims
    WHERE claims.id = claim_folders.claim_id
    AND (
      EXISTS (SELECT 1 FROM clients WHERE clients.id = claims.client_id AND clients.user_id = auth.uid()) OR
      EXISTS (SELECT 1 FROM referrers WHERE referrers.id = claims.referrer_id AND referrers.user_id = auth.uid()) OR
      EXISTS (SELECT 1 FROM claim_contractors WHERE claim_contractors.claim_id = claims.id AND claim_contractors.contractor_id = auth.uid())
    )
  )
);

-- Allow clients and contractors to upload to storage bucket
DROP POLICY IF EXISTS "Portal users can upload to storage" ON storage.objects;
CREATE POLICY "Portal users can upload to storage" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'claim-files'
  AND (
    EXISTS (
      SELECT 1 FROM claims c
      WHERE (
        name LIKE c.id::text || '/%'
      )
      AND (
        EXISTS (SELECT 1 FROM clients WHERE clients.id = c.client_id AND clients.user_id = auth.uid()) OR
        EXISTS (SELECT 1 FROM referrers WHERE referrers.id = c.referrer_id AND referrers.user_id = auth.uid()) OR
        EXISTS (SELECT 1 FROM claim_contractors WHERE claim_contractors.claim_id = c.id AND claim_contractors.contractor_id = auth.uid())
      )
    )
  )
);
