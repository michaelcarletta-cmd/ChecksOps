
-- Restore the strict policy (defense in depth) now that we route through a definer function
DROP POLICY IF EXISTS "Public can submit intro requests to listed pros" ON public.homeowner_intro_requests;
CREATE POLICY "Public can submit intro requests to listed pros"
ON public.homeowner_intro_requests
FOR INSERT
TO anon, authenticated
WITH CHECK (public.contractor_accepts_leads(contractor_profile_id, contractor_user_id));

CREATE OR REPLACE FUNCTION public.submit_homeowner_intro_request(
  _contractor_profile_id uuid,
  _homeowner_name text,
  _homeowner_email text,
  _homeowner_phone text DEFAULT NULL,
  _property_zip text DEFAULT NULL,
  _loss_type text DEFAULT NULL,
  _message text DEFAULT NULL
) RETURNS TABLE(id uuid, access_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_id uuid;
  v_token text;
BEGIN
  IF length(coalesce(_homeowner_name,'')) < 2 THEN
    RAISE EXCEPTION 'homeowner_name required';
  END IF;
  IF _homeowner_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'valid homeowner_email required';
  END IF;

  SELECT cp.user_id INTO v_user_id
  FROM public.contractor_profiles cp
  WHERE cp.id = _contractor_profile_id
    AND cp.is_directory_listed = true
    AND cp.directory_opt_in = true;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'contractor not accepting leads';
  END IF;

  INSERT INTO public.homeowner_intro_requests (
    contractor_profile_id, contractor_user_id,
    homeowner_name, homeowner_email, homeowner_phone,
    property_zip, loss_type, message
  ) VALUES (
    _contractor_profile_id, v_user_id,
    _homeowner_name, lower(_homeowner_email), nullif(_homeowner_phone,''),
    nullif(_property_zip,''), nullif(_loss_type,''), nullif(_message,'')
  )
  RETURNING homeowner_intro_requests.id, homeowner_intro_requests.access_token
  INTO v_id, v_token;

  RETURN QUERY SELECT v_id, v_token;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_homeowner_intro_request(uuid, text, text, text, text, text, text) TO anon, authenticated;
