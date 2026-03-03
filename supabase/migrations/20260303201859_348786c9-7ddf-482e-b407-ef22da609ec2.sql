
-- Drop the existing foreign key constraint on client_portal_pins
ALTER TABLE public.client_portal_pins DROP CONSTRAINT IF EXISTS client_portal_pins_user_id_fkey;

-- Add foreign key to profiles instead of auth.users
ALTER TABLE public.client_portal_pins ADD CONSTRAINT client_portal_pins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
