
CREATE POLICY "Public can read listed directory profiles"
ON public.contractor_profiles
FOR SELECT
TO anon
USING (is_directory_listed = true AND directory_opt_in = true);
