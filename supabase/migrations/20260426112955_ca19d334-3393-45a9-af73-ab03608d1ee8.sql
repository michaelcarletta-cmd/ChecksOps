-- Add per-tenant pass-through pricing and maintenance subscription tracking
ALTER TABLE public.tenant_credit_balances
  ADD COLUMN IF NOT EXISTS usd_per_credit NUMERIC(10, 6) NOT NULL DEFAULT 0.015,
  ADD COLUMN IF NOT EXISTS maintenance_subscription_status TEXT,
  ADD COLUMN IF NOT EXISTS maintenance_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS maintenance_price_id TEXT,
  ADD COLUMN IF NOT EXISTS maintenance_current_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

COMMENT ON COLUMN public.tenant_credit_balances.usd_per_credit IS 'Pass-through cost per credit in USD. Default 0.015 = ~1.5 cents per check (covers raw AI model cost + Stripe fees, no markup).';
COMMENT ON COLUMN public.tenant_credit_balances.maintenance_subscription_status IS 'Stripe subscription status for the system maintenance fee (active, past_due, canceled, etc). Separate from credits.';