-- Rewrite platform-owner helpers to use preserved application identity.
-- auth.users is empty in staging (0 rows), so the original email lookups always
-- returned false. Do not treat user_roles.admin/staff as platform-wide.
-- Emails come from restored profiles / identity_accounts, not Cognito.

CREATE OR REPLACE FUNCTION public.is_master_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.identity_accounts ia
    WHERE ia.application_user_id = auth.uid()
      AND lower(ia.email) = 'mcarletta@freedomadj.com'
  )
  OR EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND lower(p.email) = 'mcarletta@freedomadj.com'
  );
$$;

COMMENT ON FUNCTION public.is_master_owner() IS
  'Platform master owner from restored application email, not user_roles.admin and not auth.users.';

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.identity_accounts ia
    WHERE ia.application_user_id = auth.uid()
      AND lower(ia.email) = 'checksopsadmin@gmail.com'
  )
  OR EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND lower(p.email) = 'checksopsadmin@gmail.com'
  );
$$;

COMMENT ON FUNCTION public.is_platform_owner() IS
  'Platform owner from restored application email. No restored user currently matches.';
