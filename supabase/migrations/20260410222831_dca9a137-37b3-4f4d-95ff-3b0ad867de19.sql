
-- Drop duplicate triggers
DROP TRIGGER IF EXISTS queue_jobnimbus_claim_sync ON public.claims;
DROP TRIGGER IF EXISTS queue_jobnimbus_note_sync ON public.claim_updates;

-- Fix the claim sync function to check for jobnimbus_job_id
CREATE OR REPLACE FUNCTION public.queue_jobnimbus_claim_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only queue sync if claim is linked to JobNimbus
  IF NEW.jobnimbus_job_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if there's already a pending sync for this claim
  IF NOT EXISTS (
    SELECT 1 FROM jobnimbus_sync_queue 
    WHERE claim_id = NEW.id 
      AND sync_type = 'claim' 
      AND status = 'pending'
  ) THEN
    INSERT INTO jobnimbus_sync_queue (claim_id, contractor_id, sync_type, status)
    VALUES (NEW.id, NULL, 'claim', 'pending');
  END IF;
  RETURN NEW;
END;
$function$;

-- Fix the note sync function to check for jobnimbus_job_id
CREATE OR REPLACE FUNCTION public.queue_jobnimbus_note_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.claim_id IS NOT NULL THEN
    -- Only queue if the claim is linked to JobNimbus
    IF EXISTS (
      SELECT 1 FROM claims WHERE id = NEW.claim_id AND jobnimbus_job_id IS NOT NULL
    ) THEN
      INSERT INTO jobnimbus_sync_queue (claim_id, contractor_id, sync_type, status, payload)
      VALUES (
        NEW.claim_id,
        NULL,
        'note',
        'pending',
        jsonb_build_object('data', jsonb_build_object(
          'content', COALESCE(NEW.content, ''),
          'source_table', TG_TABLE_NAME,
          'source_id', NEW.id
        ))
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- Delete pending items for claims that aren't linked to JobNimbus
DELETE FROM jobnimbus_sync_queue
WHERE status = 'pending'
AND claim_id NOT IN (
  SELECT id FROM claims WHERE jobnimbus_job_id IS NOT NULL
);
