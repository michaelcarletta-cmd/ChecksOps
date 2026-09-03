-- Rewrite platform-owner helpers to use preserved application identity.
-- auth.users is empty in staging (0 rows), so the original email lookups always
-- returned false. Do not treat user_roles.admin/staff as platform-wide.
--
-- is_master_owner keys off the stable ChecksOps application UUID, not email.
-- Inbox remaps (e.g. tester EMAIL_OTP delivery) must not grant cross-tenant reads.

CREATE OR REPLACE FUNCTION public.is_master_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT auth.uid() = '7dbb3009-f059-4767-b5dc-1c5c72379330'::uuid;
$$;

COMMENT ON FUNCTION public.is_master_owner() IS
  'Platform master owner by stable application_user_id 7dbb3009-…. Email is not used.';

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
