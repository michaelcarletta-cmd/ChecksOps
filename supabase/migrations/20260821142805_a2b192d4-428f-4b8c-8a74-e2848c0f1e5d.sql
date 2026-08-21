UPDATE public.check_intake_items
SET status = 'deposited', check_stage = 'deposited'
WHERE id = '8be16f4b-e28b-4183-ba81-9f5436054f32'
  AND deposited_at IS NOT NULL;