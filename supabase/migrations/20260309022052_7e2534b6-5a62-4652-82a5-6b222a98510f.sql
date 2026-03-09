-- Add storage policy to allow clients to upload files to claims they're associated with
CREATE POLICY "Clients can upload claim files"
ON storage.objects
FOR INSERT
WITH CHECK (
  bucket_id = 'claim-files'
  AND auth.role() = 'authenticated'
  AND EXISTS (
    SELECT 1 FROM clients c
    JOIN claims cl ON cl.client_id = c.id
    WHERE c.user_id = auth.uid()
    AND cl.id::text = (storage.foldername(name))[1]
  )
);

-- Also allow clients to view files in their claims (if not already covered)
CREATE POLICY "Clients can view claim files"
ON storage.objects
FOR SELECT
USING (
  bucket_id = 'claim-files'
  AND auth.role() = 'authenticated'
  AND EXISTS (
    SELECT 1 FROM clients c
    JOIN claims cl ON cl.client_id = c.id
    WHERE c.user_id = auth.uid()
    AND cl.id::text = (storage.foldername(name))[1]
  )
);

-- Allow clients to update/delete their own uploaded files
CREATE POLICY "Clients can update claim files"
ON storage.objects
FOR UPDATE
USING (
  bucket_id = 'claim-files'
  AND auth.role() = 'authenticated'
  AND EXISTS (
    SELECT 1 FROM clients c
    JOIN claims cl ON cl.client_id = c.id
    WHERE c.user_id = auth.uid()
    AND cl.id::text = (storage.foldername(name))[1]
  )
);

CREATE POLICY "Clients can delete claim files"
ON storage.objects
FOR DELETE
USING (
  bucket_id = 'claim-files'
  AND auth.role() = 'authenticated'
  AND EXISTS (
    SELECT 1 FROM clients c
    JOIN claims cl ON cl.client_id = c.id
    WHERE c.user_id = auth.uid()
    AND cl.id::text = (storage.foldername(name))[1]
  )
);