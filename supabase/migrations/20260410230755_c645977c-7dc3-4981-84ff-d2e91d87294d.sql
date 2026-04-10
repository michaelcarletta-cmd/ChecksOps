
CREATE OR REPLACE FUNCTION public.queue_claim_update_to_jobnimbus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only queue if the claim has a jobnimbus_job_id (i.e. it's linked)
  IF EXISTS (
    SELECT 1 FROM claims WHERE id = NEW.claim_id AND jobnimbus_job_id IS NOT NULL
  ) THEN
    INSERT INTO jobnimbus_sync_queue (claim_id, sync_type, status, payload)
    VALUES (
      NEW.claim_id,
      'note',
      'pending',
      jsonb_build_object('data', jsonb_build_object(
        'content', NEW.content,
        'update_type', NEW.update_type,
        'created_at', NEW.created_at
      ))
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_note_to_jobnimbus ON claim_updates;

CREATE TRIGGER trg_queue_note_to_jobnimbus
AFTER INSERT ON claim_updates
FOR EACH ROW
EXECUTE FUNCTION queue_claim_update_to_jobnimbus();
