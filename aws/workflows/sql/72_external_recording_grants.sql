-- Narrow grants for dedicated AWS external deposit/payment recording.
-- Also unblocks SAFE_DEPOSIT_ACTIONS prepare_deposit / assign_provider,
-- which insert the same deposit_items / deposit_batches rows.
-- Does not GRANT deposit_action, does not add these tables to /data/write,
-- and does not enable Moov or CheckAlt. Does not apply 64_financial_activation_grants.sql.

GRANT SELECT, INSERT, UPDATE
  ON TABLE public.deposit_items
  TO checksops, authenticated;

GRANT SELECT, INSERT, UPDATE
  ON TABLE public.deposit_batches
  TO checksops, authenticated;

GRANT SELECT, INSERT
  ON TABLE public.deposit_audit_log
  TO checksops, authenticated;

GRANT SELECT, INSERT, UPDATE
  ON TABLE public.disbursement_batches
  TO checksops, authenticated;

GRANT SELECT, INSERT, UPDATE
  ON TABLE public.disbursement_splits
  TO checksops, authenticated;

-- New deposit batches have no items yet, so the existing ALL policy
-- WITH CHECK (items.batch_id = id) rejects INSERT. Recreate it with a
-- creator clause. The handler also savepoints this insert so recording
-- can complete without a batch if RLS still refuses.
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
