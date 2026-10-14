-- Rollback for 76_tenant_partnership_invitee_consent.sql.
-- Restores the pre-76 behavior: no consent guard on tenant_partnerships, and
-- aws_connect_partner_by_code without the trusted-writer marker.
-- Idempotent: safe to re-run.

DROP TRIGGER IF EXISTS aws_tenant_partnership_consent_guard ON public.tenant_partnerships;
DROP FUNCTION IF EXISTS public.aws_tenant_partnership_consent_guard();

ALTER FUNCTION public.aws_connect_partner_by_code(text, uuid)
  RESET checksops.partnership_writer;

-- Restore the retired Supabase-era policies (definitions from
-- supabase/migrations/20260423123210 and 20260702190605).
DROP POLICY IF EXISTS "Inviter can create partnerships" ON public.tenant_partnerships;
CREATE POLICY "Inviter can create partnerships"
ON public.tenant_partnerships FOR INSERT TO authenticated
WITH CHECK (public.user_belongs_to_tenant(auth.uid(), inviter_tenant_id) AND created_by = auth.uid());
DROP POLICY IF EXISTS "Partners can update partnerships" ON public.tenant_partnerships;
CREATE POLICY "Partners can update partnerships"
ON public.tenant_partnerships FOR UPDATE TO authenticated
USING (
  public.user_belongs_to_tenant(auth.uid(), inviter_tenant_id)
  OR (invitee_tenant_id IS NOT NULL AND public.user_belongs_to_tenant(auth.uid(), invitee_tenant_id))
);
DROP POLICY IF EXISTS "Admins can create any partnership" ON public.tenant_partnerships;
CREATE POLICY "Admins can create any partnership"
ON public.tenant_partnerships FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "Admins can view any partnership" ON public.tenant_partnerships;
CREATE POLICY "Admins can view any partnership"
ON public.tenant_partnerships FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "Admins can update any partnership" ON public.tenant_partnerships;
CREATE POLICY "Admins can update any partnership"
ON public.tenant_partnerships FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));
