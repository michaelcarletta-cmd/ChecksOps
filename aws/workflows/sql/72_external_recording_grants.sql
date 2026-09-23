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

-- New deposit batches have no items yet, so the existing
-- aws_write_deposit_batches WITH CHECK (items.batch_id = id) rejects INSERT.
-- Allow the authenticated actor to create a batch they own.
DROP POLICY IF EXISTS aws_write_deposit_batches_insert_creator ON public.deposit_batches;
CREATE POLICY aws_write_deposit_batches_insert_creator ON public.deposit_batches
  FOR INSERT TO authenticated
  WITH CHECK (
    public.aws_is_authenticated()
    AND created_by IS NOT NULL
    AND created_by = auth.uid()
  );
