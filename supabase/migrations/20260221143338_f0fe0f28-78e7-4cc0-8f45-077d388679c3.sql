
-- 1. Add org_id to claims for proper org scoping
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS org_id UUID;

-- Backfill org_id from client -> user_id -> org_members
UPDATE public.claims c
SET org_id = om.org_id
FROM public.clients cl
JOIN public.org_members om ON om.user_id = cl.user_id
WHERE c.client_id = cl.id
  AND c.org_id IS NULL;

-- Index for fast org-scoped queries
CREATE INDEX IF NOT EXISTS idx_claims_org_id ON public.claims (org_id);

-- Auto-set org_id on new claims via trigger (uses auth.uid())
CREATE OR REPLACE FUNCTION public.set_claim_org_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    SELECT org_id INTO NEW.org_id
    FROM public.org_members
    WHERE user_id = auth.uid()
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_claim_org_id_trigger ON public.claims;
CREATE TRIGGER set_claim_org_id_trigger
  BEFORE INSERT ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.set_claim_org_id();

-- 2. Add provider_message_id and send_status to emails for audit trail
ALTER TABLE public.emails ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE public.emails ADD COLUMN IF NOT EXISTS send_status TEXT DEFAULT 'sent';
