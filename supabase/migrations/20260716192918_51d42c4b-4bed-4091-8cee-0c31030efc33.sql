
ALTER TABLE public.loss_draft_tracking
  ADD COLUMN IF NOT EXISTS endorsement_order integer,
  ADD COLUMN IF NOT EXISTS predecessor_loss_draft_id uuid REFERENCES public.loss_draft_tracking(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_loss_draft_tracking_predecessor
  ON public.loss_draft_tracking(predecessor_loss_draft_id);

COMMENT ON COLUMN public.loss_draft_tracking.endorsement_order IS
  'For checks with 2 mortgagees: 1 = send first, 2 = send after order-1 check returns endorsed. NULL = single-mortgagee check.';
COMMENT ON COLUMN public.loss_draft_tracking.predecessor_loss_draft_id IS
  'The loss draft that must return an endorsed check before this one can be sent out.';
