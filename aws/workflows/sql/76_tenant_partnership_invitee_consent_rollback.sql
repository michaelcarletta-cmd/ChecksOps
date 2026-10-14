-- Rollback for 76_tenant_partnership_invitee_consent.sql.
-- Removes the consent guard on tenant_partnerships and the trusted-writer
-- marker on aws_connect_partner_by_code.
-- Idempotent: safe to re-run.

DROP TRIGGER IF EXISTS aws_tenant_partnership_consent_guard ON public.tenant_partnerships;
DROP FUNCTION IF EXISTS public.aws_tenant_partnership_consent_guard();

ALTER FUNCTION public.aws_connect_partner_by_code(text, uuid)
  RESET checksops.partnership_writer;

-- The five retired Supabase-era policies are deliberately NOT re-created: AWS
-- drops every non-aws_* policy (aws/rls/sql/13_drop_dump_policies.sql), and the
-- three "Admins can ... any partnership" policies would grant cross-tenant access
-- the AWS database never had.
