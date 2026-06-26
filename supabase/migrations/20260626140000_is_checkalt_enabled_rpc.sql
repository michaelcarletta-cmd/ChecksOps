-- Exposes only the CheckAlt enabled flag to any authenticated user, without
-- granting read access to the rest of checkalt_config (base_url, cached_jwt,
-- depositor_account_id, etc. stay admin-only). Lets the per-check "Deposit
-- with CheckAlt" button in Check Command Center decide whether to render
-- for non-admin staff, who cannot read checkalt_config directly under RLS.
CREATE OR REPLACE FUNCTION public.is_checkalt_enabled()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(default_enabled, false) FROM public.checkalt_config WHERE singleton = true LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.is_checkalt_enabled() TO authenticated;
