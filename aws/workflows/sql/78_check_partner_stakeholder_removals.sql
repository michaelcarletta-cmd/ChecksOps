-- Record that a check owner removed a partner from that check's stakeholders.
-- A partner tenant the check is shared with (public.shared_checks
-- target_tenant_id) is listed as a stakeholder of the check by default; one row
-- here means "partner_tenant_id is removed from check_intake_item_id's
-- stakeholders". tenant_id is the check owner's tenant.
-- check_partner_stakeholder_removals_share_fkey ties every row to a real share
-- of that check by that owner to that partner (shared_checks check_id,
-- source_tenant_id, target_tenant_id). Shares are revoked by setting
-- revoked_at, so a row stays valid after a revoke and goes with the share row.
-- POST /data/write (a later API change) inserts and deletes rows; no UPDATE:
-- a removal is only recorded or undone.
-- RLS mirrors public.check_stakeholders (aws_select_check_stakeholders and
-- aws_write_check_stakeholders): the owner's tenant reads, its writers write.
-- removed_by mirrors check_stakeholders.added_by (identity_accounts FK), set to
-- NULL if that identity is deleted.
CREATE TABLE public.check_partner_stakeholder_removals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_intake_item_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  partner_tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  removed_by uuid REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_partner_stakeholder_removals_unique UNIQUE (check_intake_item_id, tenant_id, partner_tenant_id),
  CONSTRAINT check_partner_stakeholder_removals_not_self CHECK (partner_tenant_id <> tenant_id),
  CONSTRAINT check_partner_stakeholder_removals_share_fkey FOREIGN KEY (check_intake_item_id, tenant_id, partner_tenant_id)
    REFERENCES public.shared_checks (check_id, source_tenant_id, target_tenant_id) ON DELETE CASCADE
);
CREATE INDEX check_partner_stakeholder_removals_tenant_id_idx
  ON public.check_partner_stakeholder_removals (tenant_id);
CREATE INDEX check_partner_stakeholder_removals_partner_tenant_id_idx
  ON public.check_partner_stakeholder_removals (partner_tenant_id);
ALTER TABLE public.check_partner_stakeholder_removals ENABLE ROW LEVEL SECURITY;
CREATE POLICY aws_select_check_partner_stakeholder_removals ON public.check_partner_stakeholder_removals
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id));
CREATE POLICY aws_write_check_partner_stakeholder_removals ON public.check_partner_stakeholder_removals
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));
REVOKE ALL ON TABLE public.check_partner_stakeholder_removals FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE public.check_partner_stakeholder_removals TO checksops, authenticated;
