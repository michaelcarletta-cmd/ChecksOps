CREATE POLICY "Mortgage agents can view active mortgage companies"
ON public.mortgage_companies
FOR SELECT
TO authenticated
USING (is_active = true AND has_role(auth.uid(), 'mortgage_agent'::app_role));