ALTER TABLE public.tenants ALTER COLUMN actum_credits_only SET DEFAULT true;
ALTER TABLE public.tenants ALTER COLUMN actum_credits_only SET NOT NULL;
UPDATE public.tenants SET actum_credits_only = true WHERE actum_credits_only IS DISTINCT FROM true;