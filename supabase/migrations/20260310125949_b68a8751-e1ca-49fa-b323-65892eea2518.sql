
-- Fix client file visibility when clients.user_id is null by allowing secure email-based fallback
-- 1) Claim file metadata access
DROP POLICY IF EXISTS "Users can view files for accessible claims" ON public.claim_files;

CREATE POLICY "Users can view files for accessible claims"
ON public.claim_files
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.claims
    WHERE claims.id = claim_files.claim_id
      AND (
        has_role(auth.uid(), 'admin'::app_role)
        OR has_role(auth.uid(), 'staff'::app_role)
        OR EXISTS (
          SELECT 1
          FROM public.clients
          WHERE clients.id = claims.client_id
            AND (
              clients.user_id = auth.uid()
              OR (
                clients.email IS NOT NULL
                AND lower(clients.email) = lower(auth.jwt() ->> 'email')
              )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM public.referrers
          WHERE referrers.id = claims.referrer_id
            AND referrers.user_id = auth.uid()
        )
        OR EXISTS (
          SELECT 1
          FROM public.claim_contractors
          WHERE claim_contractors.claim_id = claims.id
            AND claim_contractors.contractor_id = auth.uid()
        )
        OR EXISTS (
          SELECT 1
          FROM public.claim_staff
          WHERE claim_staff.claim_id = claims.id
            AND claim_staff.staff_id = auth.uid()
        )
      )
  )
);

-- 2) Storage object read access (actual file bytes)
DROP POLICY IF EXISTS "Clients can view claim files" ON storage.objects;

CREATE POLICY "Clients can view claim files"
ON storage.objects
FOR SELECT
USING (
  bucket_id = 'claim-files'
  AND auth.role() = 'authenticated'
  AND EXISTS (
    SELECT 1
    FROM public.clients c
    JOIN public.claims cl ON cl.client_id = c.id
    WHERE cl.id::text = (storage.foldername(objects.name))[1]
      AND (
        c.user_id = auth.uid()
        OR (
          c.email IS NOT NULL
          AND lower(c.email) = lower(auth.jwt() ->> 'email')
        )
      )
  )
);
