-- Narrow production grants for dedicated AWS workflow handlers.
-- GRANTs the application role `checksops` only.
-- Does NOT GRANT authenticated / browser-client access to financial tables.
-- Does not GRANT deposit_action, does not add tables to /data/write,
-- and does not enable Moov or CheckAlt.
-- Does not apply 64_financial_activation_grants.sql.

GRANT SELECT, INSERT, UPDATE
  ON TABLE public.deposit_items
  TO checksops;

GRANT SELECT, INSERT, UPDATE
  ON TABLE public.deposit_batches
  TO checksops;

GRANT SELECT, INSERT
  ON TABLE public.deposit_audit_log
  TO checksops;

GRANT SELECT, INSERT, UPDATE
  ON TABLE public.disbursement_batches
  TO checksops;

GRANT SELECT, INSERT, UPDATE
  ON TABLE public.disbursement_splits
  TO checksops;

GRANT UPDATE (amount, detected_claim_number)
  ON TABLE public.check_intake_items
  TO checksops;

-- New deposit batches have no items yet, so an items-only WITH CHECK
-- rejects INSERT. Recreate with a creator clause if the policy exists.
DROP POLICY IF EXISTS aws_write_deposit_batches_insert_creator ON public.deposit_batches;
DROP POLICY IF EXISTS aws_write_deposit_batches ON public.deposit_batches;
CREATE POLICY aws_write_deposit_batches ON public.deposit_batches
  FOR ALL TO authenticated
  USING (
    (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
    OR created_by = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.deposit_items di
      JOIN public.check_intake_items ci ON ci.id = di.check_id
      WHERE di.batch_id = deposit_batches.id
        AND public.aws_can_write_tenant(ci.tenant_id)
    )
  )
  WITH CHECK (
    (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
    OR created_by = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.deposit_items di
      JOIN public.check_intake_items ci ON ci.id = di.check_id
      WHERE di.batch_id = deposit_batches.id
        AND public.aws_can_write_tenant(ci.tenant_id)
    )
  );
