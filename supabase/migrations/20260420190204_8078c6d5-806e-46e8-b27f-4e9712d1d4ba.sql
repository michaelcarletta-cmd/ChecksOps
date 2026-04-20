
-- Add columns for check-based triggers
ALTER TABLE public.task_automations
  ADD COLUMN IF NOT EXISTS trigger_check_field text,
  ADD COLUMN IF NOT EXISTS trigger_check_value text;

-- Create function to fire check status automations
CREATE OR REPLACE FUNCTION public.fire_check_status_automations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  auto RECORD;
  due_date_val date;
  changed_fields text[] := ARRAY[]::text[];
BEGIN
  -- Detect which check status fields changed
  IF OLD.endorsement_status IS DISTINCT FROM NEW.endorsement_status THEN
    changed_fields := array_append(changed_fields, 'endorsement_status');
  END IF;
  IF OLD.payment_direction_status IS DISTINCT FROM NEW.payment_direction_status THEN
    changed_fields := array_append(changed_fields, 'payment_direction_status');
  END IF;
  IF OLD.deposit_status IS DISTINCT FROM NEW.deposit_status THEN
    changed_fields := array_append(changed_fields, 'deposit_status');
  END IF;
  IF OLD.cleared_status IS DISTINCT FROM NEW.cleared_status THEN
    changed_fields := array_append(changed_fields, 'cleared_status');
  END IF;

  -- If nothing changed, exit
  IF array_length(changed_fields, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  -- Find matching automations
  FOR auto IN
    SELECT * FROM public.task_automations
    WHERE trigger_type = 'on_check_status_change'
      AND is_active = true
      AND trigger_check_field = ANY(changed_fields)
  LOOP
    -- Check if the new value matches
    IF (auto.trigger_check_field = 'endorsement_status' AND NEW.endorsement_status = auto.trigger_check_value)
    OR (auto.trigger_check_field = 'payment_direction_status' AND NEW.payment_direction_status = auto.trigger_check_value)
    OR (auto.trigger_check_field = 'deposit_status' AND NEW.deposit_status = auto.trigger_check_value)
    OR (auto.trigger_check_field = 'cleared_status' AND NEW.cleared_status = auto.trigger_check_value)
    THEN
      -- Calculate due date
      IF auto.due_date_offset IS NOT NULL AND auto.due_date_offset > 0 THEN
        due_date_val := CURRENT_DATE + auto.due_date_offset;
      ELSE
        due_date_val := NULL;
      END IF;

      -- Insert the task
      INSERT INTO public.tasks (
        title, description, claim_id, priority, priority_level, status, due_date
      ) VALUES (
        auto.title,
        auto.description,
        NEW.claim_id,
        COALESCE(auto.priority, 'medium'),
        COALESCE(auto.priority, 'medium'),
        'backlog',
        due_date_val
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- Attach trigger to claim_checks
DROP TRIGGER IF EXISTS trg_check_status_automations ON public.claim_checks;
CREATE TRIGGER trg_check_status_automations
  AFTER UPDATE ON public.claim_checks
  FOR EACH ROW
  EXECUTE FUNCTION public.fire_check_status_automations();
