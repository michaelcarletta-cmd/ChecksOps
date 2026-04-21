
-- Populate claim_operational_state for all active claims that don't have a row yet
-- Uses actual production status values to determine lifecycle_stage and follow_up_status

INSERT INTO public.claim_operational_state (
  claim_id, lifecycle_stage, follow_up_status, days_since_last_activity, last_activity_at, pressure_score, priority_rank
)
SELECT
  c.id,
  CASE
    WHEN c.status IN ('Claim Filed', 'Inspections', 'Schedule Reinspection', 'Claim Assigned to Freedom Adjustment') THEN 'new'
    WHEN c.status IN ('Carrier Review', 'Freedom Adjustment Review', 'Research / Investigation', 'Prove It Method', 'Repair Attempt / Sample Needed', 'Submitted Rebuttal to Carrier') THEN 'active'
    WHEN c.status IN ('Carrier Denial', 'DOBI Complaint Filed', 'DOBI Compliance', 'Litigation', 'Appraisal') THEN 'dispute'
    WHEN c.status IN ('Funding from Insurance', 'Recoverable Depreciation', 'Recoverable Depreciation Requested', 'Waiting on ACV Funds', 'Waiting on Insurance Funds (ACV)', 'Check Uploaded for Processing', 'Check Processing on iink', 'Waiting on Mortgage Check', 'Check Received - No Mortgage', 'Reissue of Check Requested', 'Check Cleared - Issue Funds') THEN 'funding'
    WHEN c.status IN ('Fee Collection') THEN 'closing'
    WHEN c.status IN ('Job in Production') THEN 'active'
    ELSE 'active'
  END,
  CASE
    WHEN c.status IN ('Carrier Denial', 'DOBI Complaint Filed', 'Litigation') THEN 'escalation'
    WHEN EXTRACT(DAY FROM now() - COALESCE(c.updated_at, c.created_at)) > 21 THEN 'overdue'
    WHEN EXTRACT(DAY FROM now() - COALESCE(c.updated_at, c.created_at)) > 10 THEN 'due'
    ELSE 'on_track'
  END,
  GREATEST(0, EXTRACT(DAY FROM now() - COALESCE(c.updated_at, c.created_at))::int),
  COALESCE(c.updated_at, c.created_at),
  -- pressure_score: higher for stale + dispute claims
  LEAST(100, GREATEST(0,
    EXTRACT(DAY FROM now() - COALESCE(c.updated_at, c.created_at))::int * 2
    + CASE WHEN c.status IN ('Carrier Denial', 'Litigation', 'DOBI Complaint Filed') THEN 30 ELSE 0 END
    + CASE WHEN c.status IN ('Appraisal', 'DOBI Compliance') THEN 15 ELSE 0 END
  )),
  -- priority_rank: same as pressure for initial seed
  LEAST(100, GREATEST(0,
    EXTRACT(DAY FROM now() - COALESCE(c.updated_at, c.created_at))::int * 2
    + CASE WHEN c.status IN ('Carrier Denial', 'Litigation', 'DOBI Complaint Filed') THEN 30 ELSE 0 END
  ))
FROM public.claims c
WHERE c.status NOT IN ('Claim Settled', 'Dead File', 'Closed')
ON CONFLICT (claim_id) DO UPDATE SET
  lifecycle_stage = EXCLUDED.lifecycle_stage,
  follow_up_status = EXCLUDED.follow_up_status,
  days_since_last_activity = EXCLUDED.days_since_last_activity,
  last_activity_at = EXCLUDED.last_activity_at,
  pressure_score = EXCLUDED.pressure_score,
  priority_rank = EXCLUDED.priority_rank,
  stale_flag = EXCLUDED.days_since_last_activity > 14,
  updated_at = now();

-- Also set stale_flag for the newly inserted rows
UPDATE public.claim_operational_state SET stale_flag = true WHERE days_since_last_activity > 14;

-- Create a function to auto-upsert ops state when claims are updated
CREATE OR REPLACE FUNCTION public.sync_claim_operational_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.claim_operational_state (
    claim_id, lifecycle_stage, follow_up_status, days_since_last_activity, last_activity_at
  ) VALUES (
    NEW.id,
    CASE
      WHEN NEW.status IN ('Claim Filed', 'Inspections', 'Schedule Reinspection', 'Claim Assigned to Freedom Adjustment') THEN 'new'
      WHEN NEW.status IN ('Carrier Denial', 'DOBI Complaint Filed', 'DOBI Compliance', 'Litigation', 'Appraisal') THEN 'dispute'
      WHEN NEW.status IN ('Funding from Insurance', 'Recoverable Depreciation', 'Recoverable Depreciation Requested', 'Waiting on ACV Funds', 'Check Uploaded for Processing', 'Check Processing on iink', 'Waiting on Mortgage Check', 'Fee Collection') THEN 'funding'
      ELSE 'active'
    END,
    CASE
      WHEN NEW.status IN ('Carrier Denial', 'DOBI Complaint Filed', 'Litigation') THEN 'escalation'
      ELSE 'due'
    END,
    0,
    now()
  )
  ON CONFLICT (claim_id) DO UPDATE SET
    lifecycle_stage = EXCLUDED.lifecycle_stage,
    follow_up_status = CASE
      WHEN NEW.status IN ('Carrier Denial', 'DOBI Complaint Filed', 'Litigation') THEN 'escalation'
      ELSE 'due'
    END,
    days_since_last_activity = 0,
    last_activity_at = now(),
    updated_at = now();
  RETURN NEW;
END;
$$;

-- Trigger on claim status changes
CREATE TRIGGER trg_sync_claim_ops_on_status_change
  AFTER INSERT OR UPDATE OF status ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_claim_operational_state();
