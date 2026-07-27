ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS actum_credits_only boolean NOT NULL DEFAULT false;

UPDATE public.tenants SET actum_credits_only = true WHERE actum_parent_id = 'A20260185';