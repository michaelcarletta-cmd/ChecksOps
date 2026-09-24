-- Neutralize leftover new-tenant billing/provider defaults.
-- Does not rewrite Freedom or any existing tenant row.
-- Do not apply automatically from CI. Operator review required.

-- Historical DEFAULT 'moov' implied a configured rail even when payment_provider
-- was never chosen. Application INSERT already forces NULL; restore the column
-- default to match without touching existing rows.
ALTER TABLE public.tenants
  ALTER COLUMN payment_provider SET DEFAULT NULL;

-- $100/month was a historical NOT NULL default, not a signed customer price.
-- Platform owners set the commercial rate later. Existing rows keep their value.
ALTER TABLE public.tenants
  ALTER COLUMN monthly_rate_cents SET DEFAULT 0;

-- Actum-credits-only was forced true by a later migration. New tenants are not
-- on Actum; keep existing rows (including Freedom) unchanged.
ALTER TABLE public.tenants
  ALTER COLUMN actum_credits_only SET DEFAULT false;

COMMENT ON COLUMN public.tenants.payment_provider IS
  'Configured payment provider. NULL means not connected; do not infer Moov/Actum from this default.';

COMMENT ON COLUMN public.tenants.monthly_rate_cents IS
  'Platform-owner commercial maintenance rate in cents. New tenants start at 0 until priced.';

COMMENT ON COLUMN public.tenants.actum_credits_only IS
  'Legacy Actum flag. New tenants default false; existing rows are not rewritten.';
