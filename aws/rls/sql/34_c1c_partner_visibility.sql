-- Smallest live repair so an active shared_checks target can read the parent
-- check. Does not change ownership, write policies, or child tenant_id values.

CREATE OR REPLACE FUNCTION public.aws_is_active_shared_check_target(_check_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _check_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.shared_checks sc
       WHERE sc.check_id = _check_id
         AND sc.revoked_at IS NULL
         AND public.aws_can_access_tenant(sc.target_tenant_id)
     );
$$;

COMMENT ON FUNCTION public.aws_is_active_shared_check_target(uuid) IS
  'True when auth.uid() can act as target_tenant_id of an unrevoked shared_checks row for _check_id.';

CREATE OR REPLACE FUNCTION public.aws_can_access_check(_check_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _ok boolean := false;
BEGIN
  IF to_regprocedure('public.aws_can_access_check_non_partner(uuid)') IS NOT NULL THEN
    EXECUTE 'SELECT public.aws_can_access_check_non_partner($1)' INTO _ok USING _check_id;
  ELSE
    SELECT public.aws_is_cross_tenant_reader()
        OR EXISTS (
          SELECT 1
          FROM public.check_intake_items ci
          WHERE ci.id = _check_id
            AND public.aws_can_access_tenant(ci.tenant_id)
        )
    INTO _ok;
  END IF;
  RETURN COALESCE(_ok, false) OR public.aws_is_active_shared_check_target(_check_id);
END;
$$;

COMMENT ON FUNCTION public.aws_can_access_check(uuid) IS
  'SELECT/read helper. Owner/non-partner access plus active shared_checks target. Writes stay on aws_can_write_check.';

REVOKE ALL ON FUNCTION public.aws_is_active_shared_check_target(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_check(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_is_active_shared_check_target(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_access_check(uuid) TO checksops, authenticated;

DROP POLICY IF EXISTS aws_select_check_intake_items ON public.check_intake_items;
CREATE POLICY aws_select_check_intake_items ON public.check_intake_items
  FOR SELECT TO authenticated
  USING (
    public.aws_is_cross_tenant_reader()
    OR public.aws_can_access_tenant(tenant_id)
    OR public.aws_is_active_shared_check_target(id)
  );
