ALTER TABLE public.checkalt_tenant_accounts
  ADD COLUMN IF NOT EXISTS auto_approve_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_approve_max_cents integer;