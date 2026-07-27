ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS payment_rail text NOT NULL DEFAULT 'actum';

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_payment_rail_check;

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_payment_rail_check
  CHECK (payment_rail IN ('actum', 'plaid'));

COMMENT ON COLUMN public.tenants.payment_rail IS
  'Active money-movement + bank-verification rail for this tenant. "actum" = Actum disbursement + Authentecheck verification (current). "plaid" = Plaid Transfer + Plaid Link (future). Controls UI visibility of all Actum surfaces.';