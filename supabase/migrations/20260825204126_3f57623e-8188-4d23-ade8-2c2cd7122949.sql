-- Helper: is this claim a self-guided intake claim? (security definer so guided users can link right after creating it)
CREATE OR REPLACE FUNCTION public.is_guided_claim(_claim_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.claims
    WHERE id = _claim_id AND is_guided_mode = true
  )
$$;

-- Guided users may only link themselves to claims created via the guided intake flow
DROP POLICY IF EXISTS "Guided users can link themselves" ON public.guided_claim_access;
CREATE POLICY "Guided users can link themselves"
ON public.guided_claim_access FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND public.is_guided_claim(claim_id)
);

-- Drop the open pending-invite enumeration policy (redemption uses lookup_tenant_by_partner_code RPC)
DROP POLICY IF EXISTS "Anyone can lookup pending invites" ON public.tenant_partnerships;