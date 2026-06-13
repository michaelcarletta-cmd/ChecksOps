
-- Add KYC + internal notes fields to tenants for master-owner management
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS kyc_notes TEXT,
  ADD COLUMN IF NOT EXISTS internal_notes TEXT;

DO $$ BEGIN
  ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_kyc_status_check
    CHECK (kyc_status IN ('pending','approved','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Security-definer check: is the current user the master platform owner?
CREATE OR REPLACE FUNCTION public.is_master_owner()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = auth.uid()
      AND lower(email) = 'mcarletta@freedomadj.com'
  );
$$;

-- Allow master owner full access to tenants (for the admin Tenant Management UI)
DROP POLICY IF EXISTS "Master owner can manage all tenants" ON public.tenants;
CREATE POLICY "Master owner can manage all tenants"
  ON public.tenants
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (public.is_master_owner())
  WITH CHECK (public.is_master_owner());
