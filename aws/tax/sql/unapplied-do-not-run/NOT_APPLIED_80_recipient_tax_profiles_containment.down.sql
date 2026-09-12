-- ============================================================================
-- NOT SAFE TO APPLY / DESIGN ONLY
-- Do not run this file. It is a design-only reversal of the unapplied
-- containment SQL. It is not a migration and must not be picked up by any
-- automatic runner. Do not weaken this script or restore broad member
-- access in live databases.
-- ============================================================================
-- Reversal for NOT_APPLIED_80_recipient_tax_profiles_containment.sql — DO NOT APPLY
-- unless separately authorized to roll back the unapplied containment design.
--
-- Restores the previous (over-broad) AWS policies. Does not recreate Lovable
-- "tenant members *" policies. Does not touch plaintext tin values.

BEGIN;

DROP POLICY IF EXISTS aws_select_recipient_tax_profiles ON public.recipient_tax_profiles;
DROP POLICY IF EXISTS aws_write_recipient_tax_profiles ON public.recipient_tax_profiles;

CREATE POLICY aws_select_recipient_tax_profiles ON public.recipient_tax_profiles
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id));

CREATE POLICY aws_write_recipient_tax_profiles ON public.recipient_tax_profiles
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

ALTER TABLE public.recipient_tax_profiles
  DROP COLUMN IF EXISTS tin_on_file,
  DROP COLUMN IF EXISTS tin_last_4,
  DROP COLUMN IF EXISTS tin_type,
  DROP COLUMN IF EXISTS tin_encrypted,
  DROP COLUMN IF EXISTS tin_key_id;

COMMIT;
