CREATE POLICY "Public can view active tenants by slug or domain"
ON public.tenants
FOR SELECT
TO anon, authenticated
USING (subscription_status = 'active');