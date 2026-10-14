-- Rollback for 76_tenant_partnership_invitee_consent.sql.
-- Restores the pre-76 behavior: no consent guard on tenant_partnerships, and
-- aws_connect_partner_by_code without the trusted-writer marker.
-- Idempotent: safe to re-run.

DROP TRIGGER IF EXISTS aws_tenant_partnership_consent_guard ON public.tenant_partnerships;
DROP FUNCTION IF EXISTS public.aws_tenant_partnership_consent_guard();

ALTER FUNCTION public.aws_connect_partner_by_code(text, uuid)
  RESET checksops.partnership_writer;
