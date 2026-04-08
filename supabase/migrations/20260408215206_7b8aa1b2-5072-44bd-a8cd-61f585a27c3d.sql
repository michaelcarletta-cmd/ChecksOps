
-- Add trigger_sub_status_id to task_automations
ALTER TABLE public.task_automations
ADD COLUMN trigger_sub_status_id UUID REFERENCES public.claim_sub_statuses(id) ON DELETE SET NULL;
