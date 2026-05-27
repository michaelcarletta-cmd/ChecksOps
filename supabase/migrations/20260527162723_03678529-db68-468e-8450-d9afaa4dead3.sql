INSERT INTO public.user_roles (user_id, role)
SELECT tu.user_id, 'staff'::app_role
FROM public.tenant_users tu
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles ur WHERE ur.user_id = tu.user_id
)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  user_role text;
  approval_status_val text;
BEGIN
  user_role := NEW.raw_user_meta_data->>'role';

  IF user_role = 'staff' THEN
    approval_status_val := 'pending';
  ELSE
    approval_status_val := 'approved';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, approval_status)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name', approval_status_val);

  IF user_role IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, user_role::app_role)
    ON CONFLICT DO NOTHING;
  ELSIF NEW.raw_user_meta_data->>'tenant_id' IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'staff'::app_role)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;