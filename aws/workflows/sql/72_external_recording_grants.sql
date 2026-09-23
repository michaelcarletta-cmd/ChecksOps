-- Narrow grants for dedicated AWS external deposit/payment recording.
-- Does not GRANT deposit_action, does not add these tables to /data/write,
-- and does not enable Moov or CheckAlt.

GRANT INSERT, UPDATE
  ON TABLE public.disbursement_batches
  TO checksops, authenticated;

GRANT INSERT, UPDATE
  ON TABLE public.disbursement_splits
  TO checksops, authenticated;

GRANT UPDATE (status, provider, batch_id, cleared_at, deposit_slip_number, bank_reference, updated_at)
  ON TABLE public.deposit_items
  TO checksops, authenticated;
