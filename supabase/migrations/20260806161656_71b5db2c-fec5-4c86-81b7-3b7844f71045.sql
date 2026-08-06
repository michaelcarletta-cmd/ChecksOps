UPDATE public.tenants 
SET 
  moov_allowlisted = true, 
  moov_environment = 'sandbox', 
  payment_provider = 'moov' 
WHERE slug = 'freedom';

-- Ensure the user from the context (mcarletta@freedomadj.com) is an admin if they exist
DO $$ 
DECLARE 
  target_user_id UUID;
BEGIN
  SELECT id INTO target_user_id FROM auth.users WHERE email = 'mcarletta@freedomadj.com';
  
  IF target_user_id IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (target_user_id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
END $$;