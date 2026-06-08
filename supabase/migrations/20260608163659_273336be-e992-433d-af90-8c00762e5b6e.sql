ALTER TABLE public.actum_transactions ADD COLUMN auth_code TEXT;
ALTER TABLE public.actum_transactions ADD COLUMN response_reason TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.actum_transactions TO authenticated;
GRANT ALL ON public.actum_transactions TO service_role;