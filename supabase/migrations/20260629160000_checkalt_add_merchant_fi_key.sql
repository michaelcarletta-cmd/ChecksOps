-- Add merchant and fi_key columns to checkalt_config.
-- merchant: required by Cloudflare WAF on all CheckAlt API requests (e.g. "lockbox5")
-- fi_key:  unique financial institution identifier assigned by CheckAlt,
--          required by deposit/process, deposit/item, and deposit/approve endpoints.

ALTER TABLE public.checkalt_config
  ADD COLUMN IF NOT EXISTS merchant text,
  ADD COLUMN IF NOT EXISTS fi_key text;

COMMENT ON COLUMN public.checkalt_config.merchant IS 'Cloudflare WAF merchant header value (e.g. lockbox5)';
COMMENT ON COLUMN public.checkalt_config.fi_key IS 'CheckAlt Financial Institution key (UUID assigned by CheckAlt)';
