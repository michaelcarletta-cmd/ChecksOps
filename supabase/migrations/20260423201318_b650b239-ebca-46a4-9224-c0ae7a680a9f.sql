-- Expand allowed escrow_status values to include the post-mortgage flow states
ALTER TABLE public.loss_draft_tracking
  DROP CONSTRAINT IF EXISTS loss_draft_tracking_escrow_status_check;

ALTER TABLE public.loss_draft_tracking
  ADD CONSTRAINT loss_draft_tracking_escrow_status_check
  CHECK (escrow_status = ANY (ARRAY[
    'pending_send'::text,
    'sent_to_lender'::text,
    'received_by_lender'::text,
    'escrowed'::text,
    'check_received_back'::text,
    'endorsing'::text,
    'first_draw_requested'::text,
    'partial_release'::text,
    'final_release_complete'::text,
    'disputed'::text
  ]));