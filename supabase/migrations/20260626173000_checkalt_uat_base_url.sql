-- Sets the confirmed CheckAlt (FinCapture) UAT base URL. Per CheckAlt's own
-- published endpoint list, all RDC API paths live under
-- https://uatapi.checkalt.com in UAT.
UPDATE public.checkalt_config
SET base_url = 'https://uatapi.checkalt.com'
WHERE singleton = true;
