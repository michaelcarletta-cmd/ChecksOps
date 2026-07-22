CREATE TABLE IF NOT EXISTS public.check_deposit_image_backfill_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  front_result text,
  back_result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(check_id)
);
CREATE INDEX IF NOT EXISTS check_deposit_image_backfill_queue_pending_idx
  ON public.check_deposit_image_backfill_queue(status, created_at) WHERE status = 'pending';

GRANT SELECT ON public.check_deposit_image_backfill_queue TO authenticated;
GRANT ALL ON public.check_deposit_image_backfill_queue TO service_role;
ALTER TABLE public.check_deposit_image_backfill_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read backfill queue" ON public.check_deposit_image_backfill_queue
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.check_deposit_image_backfill_queue (check_id)
SELECT id FROM public.check_intake_items
WHERE check_stage IN ('ready_for_deposit','endorsing','review','deposited')
  AND (front_image_path IS NOT NULL OR back_image_path IS NOT NULL)
ON CONFLICT (check_id) DO NOTHING;