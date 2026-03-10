
-- Fix the client storage SELECT policy - it was matching against client name instead of object path
DROP POLICY IF EXISTS "Clients can view claim files" ON storage.objects;

CREATE POLICY "Clients can view claim files"
ON storage.objects
FOR SELECT
USING (
  bucket_id = 'claim-files'
  AND auth.role() = 'authenticated'
  AND EXISTS (
    SELECT 1
    FROM clients c
    JOIN claims cl ON cl.client_id = c.id
    WHERE c.user_id = auth.uid()
      AND cl.id::text = (storage.foldername(objects.name))[1]
  )
);

-- Also fix the client DELETE policy with same bug
DROP POLICY IF EXISTS "Clients can delete claim files" ON storage.objects;

CREATE POLICY "Clients can delete claim files"
ON storage.objects
FOR DELETE
USING (
  bucket_id = 'claim-files'
  AND auth.role() = 'authenticated'
  AND EXISTS (
    SELECT 1
    FROM clients c
    JOIN claims cl ON cl.client_id = c.id
    WHERE c.user_id = auth.uid()
      AND cl.id::text = (storage.foldername(objects.name))[1]
  )
);

-- Also fix the client UPDATE policy with same bug
DROP POLICY IF EXISTS "Clients can update claim files" ON storage.objects;

CREATE POLICY "Clients can update claim files"
ON storage.objects
FOR UPDATE
USING (
  bucket_id = 'claim-files'
  AND auth.role() = 'authenticated'
  AND EXISTS (
    SELECT 1
    FROM clients c
    JOIN claims cl ON cl.client_id = c.id
    WHERE c.user_id = auth.uid()
      AND cl.id::text = (storage.foldername(objects.name))[1]
  )
);
