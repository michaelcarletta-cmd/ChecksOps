-- Create trigger function for inspection sync to JobNimbus
CREATE OR REPLACE FUNCTION public.queue_jobnimbus_inspection_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only queue if the claim is linked to a JobNimbus job
  IF EXISTS (
    SELECT 1 FROM claims WHERE id = NEW.claim_id AND jobnimbus_job_id IS NOT NULL
  ) THEN
    INSERT INTO jobnimbus_sync_queue (claim_id, sync_type, status, payload)
    VALUES (
      NEW.claim_id,
      'inspection',
      'pending',
      jsonb_build_object(
        'data', jsonb_build_object(
          'inspection_id', NEW.id,
          'inspection_date', NEW.inspection_date,
          'inspection_time', NEW.inspection_time,
          'inspection_type', COALESCE(NEW.inspection_type, 'General'),
          'inspector_name', NEW.inspector_name,
          'notes', NEW.notes,
          'status', NEW.status
        )
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Create trigger on inspections table for INSERT and UPDATE
DROP TRIGGER IF EXISTS trigger_jobnimbus_inspection_sync ON inspections;
CREATE TRIGGER trigger_jobnimbus_inspection_sync
  AFTER INSERT OR UPDATE ON inspections
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_jobnimbus_inspection_sync();