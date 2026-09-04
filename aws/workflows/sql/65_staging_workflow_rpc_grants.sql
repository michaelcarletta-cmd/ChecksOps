-- AWS staging: allow loss_draft_audit_log writes for check-scoped drafts.
-- Production policy only allowed aws_can_write_claim(claim_id), which denies
-- drafts whose claim_id is null (common for check-intake loss drafts).
-- Keeps tenant/check write helpers; does not broaden cross-tenant access.

DROP POLICY IF EXISTS aws_write_loss_draft_audit_log ON public.loss_draft_audit_log;

CREATE POLICY aws_write_loss_draft_audit_log ON public.loss_draft_audit_log
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.loss_draft_tracking ldt
      WHERE ldt.id = loss_draft_audit_log.loss_draft_id
        AND (
          public.aws_can_write_claim(ldt.claim_id)
          OR (
            ldt.check_intake_item_id IS NOT NULL
            AND public.aws_can_write_check(ldt.check_intake_item_id)
          )
          OR public.aws_can_write_tenant((
            SELECT ci.tenant_id
            FROM public.check_intake_items ci
            WHERE ci.id = ldt.check_intake_item_id
          ))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.loss_draft_tracking ldt
      WHERE ldt.id = loss_draft_audit_log.loss_draft_id
        AND (
          public.aws_can_write_claim(ldt.claim_id)
          OR (
            ldt.check_intake_item_id IS NOT NULL
            AND public.aws_can_write_check(ldt.check_intake_item_id)
          )
          OR public.aws_can_write_tenant((
            SELECT ci.tenant_id
            FROM public.check_intake_items ci
            WHERE ci.id = ldt.check_intake_item_id
          ))
        )
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.loss_draft_audit_log TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.audit_logs TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_sessions TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.role_version_tracker TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.homeowner_intro_requests TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.check_cases TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contractor_profiles TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mortgage_companies TO checksops;
