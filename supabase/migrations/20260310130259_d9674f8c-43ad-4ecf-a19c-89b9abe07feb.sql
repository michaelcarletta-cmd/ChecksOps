
-- Replace broken storage read policy with correct client identity matching
DROP POLICY IF EXISTS "Users can view files for accessible claims" ON storage.objects;

CREATE POLICY "Users can view files for accessible claims"
ON storage.objects
FOR SELECT
USING (
  bucket_id = 'claim-files'
  AND (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'staff'::app_role)
    OR EXISTS (
      SELECT 1
      FROM public.claim_files cf
      JOIN public.claims c ON c.id = cf.claim_id
      JOIN public.clients cl ON cl.id = c.client_id
      WHERE cf.file_path = objects.name
        AND (
          cl.user_id = auth.uid()
          OR (
            cl.email IS NOT NULL
            AND lower(cl.email) = lower(auth.jwt() ->> 'email')
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.claim_files cf
      JOIN public.claim_contractors cc ON cc.claim_id = cf.claim_id
      WHERE cf.file_path = objects.name
        AND cc.contractor_id = auth.uid()
    )
  )
);
