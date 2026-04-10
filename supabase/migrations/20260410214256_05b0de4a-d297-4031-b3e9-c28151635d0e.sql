
CREATE OR REPLACE FUNCTION public.queue_jobnimbus_claim_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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
$$;
