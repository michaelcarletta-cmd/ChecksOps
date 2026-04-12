
-- Update the trigger function to also handle sub_status_id changes
CREATE OR REPLACE FUNCTION public.trigger_status_change_automations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Fire status_change automations when status changes
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.automation_executions (automation_id, claim_id, trigger_data, status)
    SELECT 
      a.id,
      NEW.id,
      jsonb_build_object(
        'old_status', OLD.status,
        'new_status', NEW.status,
        'claim_number', NEW.claim_number
      ),
      'pending'
    FROM public.automations a
    WHERE a.is_active = true
      AND a.trigger_type = 'status_change'
      AND (
        a.trigger_config->>'status' IS NULL 
        OR a.trigger_config->>'status' = NEW.status
      );
  END IF;

  -- Fire sub_status_change automations when sub_status_id changes
  IF OLD.sub_status_id IS DISTINCT FROM NEW.sub_status_id AND NEW.sub_status_id IS NOT NULL THEN
    INSERT INTO public.automation_executions (automation_id, claim_id, trigger_data, status)
    SELECT 
      a.id,
      NEW.id,
      jsonb_build_object(
        'old_sub_status_id', OLD.sub_status_id,
        'new_sub_status_id', NEW.sub_status_id,
        'new_status', NEW.status,
        'claim_number', NEW.claim_number
      ),
      'pending'
    FROM public.automations a
    WHERE a.is_active = true
      AND a.trigger_type = 'sub_status_change'
      AND (
        a.trigger_config->>'sub_status_id' IS NULL 
        OR a.trigger_config->>'sub_status_id' = NEW.sub_status_id::text
      );
  END IF;
  
  RETURN NEW;
END;
$$;
