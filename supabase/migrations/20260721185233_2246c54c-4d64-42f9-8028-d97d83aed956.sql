
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS back_image_original_path text,
  ADD COLUMN IF NOT EXISTS back_image_deposit_path text,
  ADD COLUMN IF NOT EXISTS endorsement_render_status text
    NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS endorsement_render_meta jsonb,
  ADD COLUMN IF NOT EXISTS endorsement_render_version integer NOT NULL DEFAULT 0;

-- Backfill: treat the current back_image_path as the "original" whenever it
-- doesn't already look like a previously-endorsed artifact. This lets the new
-- adjuster always render from a clean back image instead of double-endorsing.
UPDATE public.check_intake_items
   SET back_image_original_path = back_image_path
 WHERE back_image_original_path IS NULL
   AND back_image_path IS NOT NULL
   AND back_image_path !~* '_endorsed(_[0-9]+)?\.[a-z0-9]+$'
   AND back_image_path !~* '\.svg$';
