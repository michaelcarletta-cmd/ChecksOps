
CREATE POLICY "Guided users can upload to claim-files storage"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'claim-files'
  AND EXISTS (
    SELECT 1 FROM guided_claim_access gca
    JOIN claims c ON c.id = gca.claim_id
    WHERE gca.user_id = auth.uid()
      AND name LIKE (c.id::text || '/%')
  )
);
