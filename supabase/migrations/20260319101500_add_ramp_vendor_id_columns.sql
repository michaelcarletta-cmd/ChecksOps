-- Add Ramp vendor IDs for payment integration
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS ramp_vendor_id text;

ALTER TABLE public.referrers
ADD COLUMN IF NOT EXISTS ramp_vendor_id text;

ALTER TABLE public.clients
ADD COLUMN IF NOT EXISTS ramp_vendor_id text;

-- Backfill from previous provider IDs so existing recipients stay connected
UPDATE public.profiles
SET ramp_vendor_id = stripe_account_id
WHERE ramp_vendor_id IS NULL
  AND stripe_account_id IS NOT NULL;

UPDATE public.referrers
SET ramp_vendor_id = stripe_account_id
WHERE ramp_vendor_id IS NULL
  AND stripe_account_id IS NOT NULL;

UPDATE public.clients
SET ramp_vendor_id = stripe_account_id
WHERE ramp_vendor_id IS NULL
  AND stripe_account_id IS NOT NULL;

COMMENT ON COLUMN public.profiles.ramp_vendor_id IS 'Ramp vendor ID used for outgoing claim payments';
COMMENT ON COLUMN public.referrers.ramp_vendor_id IS 'Ramp vendor ID used for outgoing claim payments';
COMMENT ON COLUMN public.clients.ramp_vendor_id IS 'Ramp vendor ID used for outgoing claim payments';
