-- Narrow SECURITY DEFINER helper for hire-mortgage-agent cross-identity writes.
--
-- Purpose:
-- - Allow an authorized system admin (user_roles.admin) or platform owner
--   (is_master_owner / is_platform_owner) to provision the target user's
--   `profiles` row and grant exactly the `mortgage_agent` app role.
--
-- Constraints:
-- - Does not accept arbitrary role input.
-- - Does not grant admin/staff/other roles.
-- - Does not provide generic profile mutation beyond id/email/full_name + timestamps.
-- - Authorization is validated inside this function using auth.uid() (request.app_user_id).
--
-- This is required because AWS staging RLS blocks direct cross-identity writes
-- to profiles/user_roles for non-platform-owner admins.

CREATE OR REPLACE FUNCTION public.aws_hire_mortgage_agent_provision(
  _application_user_id uuid,
  _email text,
  _full_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _caller uuid;
  _is_admin boolean;
  _is_master boolean;
  _normalized_email text;
  _normalized_name text;
  _role_exists boolean;
BEGIN
  _caller := auth.uid();
  IF _caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  _is_master := COALESCE(public.is_master_owner(), false);
  _is_admin := EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = _caller
      AND ur.role = 'admin'::public.app_role
  );
  IF NOT (_is_master OR _is_admin) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  IF _application_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_required_field', 'field', 'application_user_id');
  END IF;
  _normalized_email := lower(trim(coalesce(_email, '')));
  _normalized_name := trim(coalesce(_full_name, ''));
  IF _normalized_email = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_required_field', 'field', 'email');
  END IF;
  IF _normalized_name = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_required_field', 'field', 'full_name');
  END IF;

  -- Fail closed if the target already holds privileged roles.
  IF EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = _application_user_id
      AND ur.role IN ('admin'::public.app_role, 'staff'::public.app_role)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'role_conflict');
  END IF;

  INSERT INTO public.profiles (id, email, full_name, created_at, updated_at)
  VALUES (_application_user_id, _normalized_email, _normalized_name, now(), now())
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        updated_at = now();

  INSERT INTO public.user_roles (user_id, role)
  VALUES (_application_user_id, 'mortgage_agent'::public.app_role)
  ON CONFLICT DO NOTHING;

  _role_exists := EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = _application_user_id
      AND ur.role = 'mortgage_agent'::public.app_role
  );

  RETURN jsonb_build_object(
    'ok', true,
    'application_user_id', _application_user_id::text,
    'email', _normalized_email,
    'full_name', _normalized_name,
    'mortgage_agent_granted', _role_exists
  );
END;
$$;

COMMENT ON FUNCTION public.aws_hire_mortgage_agent_provision(uuid, text, text) IS
  'SECURITY DEFINER: hire-mortgage-agent only. Upserts profiles(id,email,full_name) and grants exactly user_roles.mortgage_agent. Validates caller is platform owner or user_roles.admin.';

REVOKE ALL ON FUNCTION public.aws_hire_mortgage_agent_provision(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_hire_mortgage_agent_provision(uuid, text, text) TO checksops;

