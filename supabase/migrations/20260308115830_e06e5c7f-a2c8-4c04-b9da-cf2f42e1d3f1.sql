
DROP POLICY IF EXISTS "Users can view inspections for their claims" ON public.inspections;

CREATE POLICY "Users can view inspections for their claims"
ON public.inspections
FOR SELECT
TO public
USING (
  EXISTS (
    SELECT 1
    FROM claims
    JOIN clients ON clients.id = claims.client_id
    WHERE claims.id = inspections.claim_id
      AND clients.user_id = auth.uid()
  )
);
