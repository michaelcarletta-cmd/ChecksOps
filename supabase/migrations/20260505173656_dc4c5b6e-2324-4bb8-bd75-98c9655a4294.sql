CREATE POLICY "No direct access to tenant partner code aliases"
ON public.tenant_partner_code_aliases
AS RESTRICTIVE
FOR ALL
TO public
USING (false)
WITH CHECK (false);