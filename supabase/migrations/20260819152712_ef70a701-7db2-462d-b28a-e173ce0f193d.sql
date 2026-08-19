ALTER TABLE public.tenant_documents 
ADD COLUMN IF NOT EXISTS shared_with_homeowners BOOLEAN DEFAULT false;

GRANT SELECT, UPDATE ON public.tenant_documents TO authenticated;
GRANT ALL ON public.tenant_documents TO service_role;
