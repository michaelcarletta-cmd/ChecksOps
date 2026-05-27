
CREATE OR REPLACE FUNCTION public.sync_tenant_user_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.app_role;
BEGIN
  v_role := CASE NEW.role::text
    WHEN 'admin' THEN 'admin'::public.app_role
    WHEN 'operator' THEN 'staff'::public.app_role
    WHEN 'viewer' THEN 'read_only'::public.app_role
    ELSE 'staff'::public.app_role
  END;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.user_id, v_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_tenant_user_role ON public.tenant_users;
CREATE TRIGGER trg_sync_tenant_user_role
AFTER INSERT OR UPDATE OF role ON public.tenant_users
FOR EACH ROW
EXECUTE FUNCTION public.sync_tenant_user_role();

INSERT INTO public.user_roles (user_id, role)
SELECT tu.user_id,
       CASE tu.role::text
         WHEN 'admin' THEN 'admin'::public.app_role
         WHEN 'operator' THEN 'staff'::public.app_role
         WHEN 'viewer' THEN 'read_only'::public.app_role
         ELSE 'staff'::public.app_role
       END
FROM public.tenant_users tu
ON CONFLICT (user_id, role) DO NOTHING;
