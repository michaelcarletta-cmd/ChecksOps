-- Platform-wide authorization follows the explicit platform-owner mailbox.
-- Tenant roles and legacy application UUIDs never grant cross-tenant access.
-- Identity is resolved server-side into request.app_user_id and preserved email
-- records; Cognito's untrusted email hint is not used for authorization.

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
      AND ia.status IN ('active', 'isolated_test')
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
  'Platform owner only when the resolved application identity belongs to checksopsadmin@gmail.com.';

-- Backward-compatible helper used by existing RLS policies. It intentionally
-- delegates to the same explicit platform-owner check and no longer recognizes
-- the legacy Freedom Adjustment application UUID.
CREATE OR REPLACE FUNCTION public.is_master_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.is_platform_owner();
$$;

COMMENT ON FUNCTION public.is_master_owner() IS
  'Compatibility alias for is_platform_owner(); no UUID-based bypass.';
