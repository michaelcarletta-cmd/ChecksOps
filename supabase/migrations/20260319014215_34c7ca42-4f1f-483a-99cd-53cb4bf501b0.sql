
UPDATE public.loss_draft_tracking 
SET check_intake_item_id = NULL 
WHERE id = '0f97bec9-9a3a-4a23-a13c-813b270613bc';

DELETE FROM public.check_intake_items 
WHERE id = 'fa18378c-8d17-4b8e-b1cf-63a29175d61b';
