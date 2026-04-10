
-- Create trigger function to auto-queue JobNimbus syncs
CREATE OR REPLACE FUNCTION public.queue_jobnimbus_claim_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only queue if contractor_id is set
  IF NEW.contractor_id IS NOT NULL THEN
    -- Check if there's already a pending sync for this claim
    IF NOT EXISTS (
      SELECT 1 FROM jobnimbus_sync_queue 
      WHERE claim_id = NEW.id 
        AND sync_type = 'claim' 
        AND status = 'pending'
    ) THEN
      INSERT INTO jobnimbus_sync_queue (claim_id, contractor_id, sync_type, status)
      VALUES (NEW.id, NEW.contractor_id, 'claim', 'pending');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Create trigger on claims table
DROP TRIGGER IF EXISTS trigger_jobnimbus_claim_sync ON claims;
CREATE TRIGGER trigger_jobnimbus_claim_sync
  AFTER INSERT OR UPDATE ON claims
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_jobnimbus_claim_sync();
