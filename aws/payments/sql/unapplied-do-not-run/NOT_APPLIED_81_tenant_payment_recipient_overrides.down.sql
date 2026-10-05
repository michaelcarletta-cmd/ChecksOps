-- ============================================================================
-- NOT SAFE TO APPLY / DESIGN ONLY
-- Reverse of NOT_APPLIED_81_tenant_payment_recipient_overrides.sql
-- Do not run unless a later reviewed apply workstream applied the up file.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS aws_write_tenant_payment_recipient_overrides ON public.tenant_payment_recipient_overrides;
DROP POLICY IF EXISTS aws_select_tenant_payment_recipient_overrides ON public.tenant_payment_recipient_overrides;
DROP TABLE IF EXISTS public.tenant_payment_recipient_overrides;

COMMIT;
