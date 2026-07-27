ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS payment_provider text,
  ADD COLUMN IF NOT EXISTS moov_account_id text,
  ADD COLUMN IF NOT EXISTS payment_status text,
  ADD COLUMN IF NOT EXISTS bank_connection_status text,
  ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS bank_last_four text,
  ADD COLUMN IF NOT EXISTS verification_status text,
  ADD COLUMN IF NOT EXISTS last_sync timestamptz;

COMMENT ON COLUMN public.tenants.payment_provider IS 'Provider-agnostic payment rail selector: actum | plaid | moov. NULL falls back to payment_rail.';
COMMENT ON COLUMN public.tenants.payment_status IS 'not_connected | pending_verification | verification_required | active | suspended';
COMMENT ON COLUMN public.tenants.bank_connection_status IS 'not_connected | pending | connected | failed';