-- Strict tenant_users membership for ordinary company check movement.
-- Platform admin role escape removed. Existing override RPC body is unchanged.
-- No privilege or row-level-security changes.

CREATE OR REPLACE FUNCTION public.user_can_move_tenant_checks(_user_id uuid, _tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.user_belongs_to_tenant(_user_id, _tenant_id)
$$;
