
DROP POLICY IF EXISTS "Public can submit intro requests to listed pros" ON public.homeowner_intro_requests;

CREATE OR REPLACE FUNCTION public.contractor_accepts_leads(_profile_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contractor_profiles
    WHERE id = _profile_id
      AND user_id = _user_id
      AND is_directory_listed = true
      AND directory_opt_in = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.contractor_accepts_leads(uuid, uuid) TO anon, authenticated;

CREATE POLICY "Public can submit intro requests to listed pros"
ON public.homeowner_intro_requests
FOR INSERT
TO anon, authenticated
WITH CHECK (public.contractor_accepts_leads(contractor_profile_id, contractor_user_id));

GRANT EXECUTE ON FUNCTION extensions.gen_random_bytes(integer) TO anon, authenticated;
