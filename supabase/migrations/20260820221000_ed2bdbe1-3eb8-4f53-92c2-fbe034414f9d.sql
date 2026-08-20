ALTER TABLE public.moov_invoices
  ADD COLUMN IF NOT EXISTS public_token uuid UNIQUE DEFAULT gen_random_uuid();

UPDATE public.moov_invoices
   SET public_token = gen_random_uuid()
 WHERE public_token IS NULL;

ALTER TABLE public.moov_invoices
  ALTER COLUMN public_token SET DEFAULT gen_random_uuid();

GRANT SELECT, UPDATE ON public.moov_invoices TO authenticated;
GRANT ALL ON public.moov_invoices TO service_role;
