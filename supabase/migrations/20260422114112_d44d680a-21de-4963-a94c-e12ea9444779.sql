
-- Allow any authenticated user to create a guided-mode claim
CREATE POLICY "Guided users can create guided claims"
ON public.claims
FOR INSERT
TO authenticated
WITH CHECK (is_guided_mode = true);

-- Allow authenticated users to link themselves to a claim
CREATE POLICY "Guided users can link themselves"
ON public.guided_claim_access
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- Allow guided users to add adjusters to their linked claims
CREATE POLICY "Guided users can add adjusters to linked claims"
ON public.claim_adjusters
FOR INSERT
TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM guided_claim_access gca
  WHERE gca.claim_id = claim_adjusters.claim_id
    AND gca.user_id = auth.uid()
));
