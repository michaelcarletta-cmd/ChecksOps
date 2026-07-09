
DROP POLICY IF EXISTS "Public can submit intro requests to listed pros" ON public.homeowner_intro_requests;
CREATE POLICY "Public can submit intro requests to listed pros"
ON public.homeowner_intro_requests
FOR INSERT
TO anon, authenticated
WITH CHECK (true);
