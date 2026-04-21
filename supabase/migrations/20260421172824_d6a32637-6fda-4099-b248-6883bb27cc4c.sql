
-- Function to compute last real activity for a claim
CREATE OR REPLACE FUNCTION public.compute_claim_last_activity(p_claim_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
    (SELECT MAX(created_at) FROM claim_events WHERE claim_id = p_claim_id),
    (SELECT MAX(created_at) FROM claim_photos WHERE claim_id = p_claim_id),
    (SELECT MAX(uploaded_at) FROM claim_files WHERE claim_id = p_claim_id),
    (SELECT MAX(created_at) FROM claim_microtasks WHERE claim_id = p_claim_id),
    (SELECT MAX(created_at) FROM tasks WHERE claim_id = p_claim_id),
    (SELECT MAX(created_at) FROM emails WHERE claim_id = p_claim_id),
    (SELECT MAX(created_at) FROM claim_communications_diary WHERE claim_id = p_claim_id),
    (SELECT created_at FROM claims WHERE id = p_claim_id)
  );
$$;

-- View for quick access to last activity per claim
CREATE OR REPLACE VIEW public.claim_last_activity AS
SELECT 
  c.id AS claim_id,
  public.compute_claim_last_activity(c.id) AS last_activity_at,
  EXTRACT(DAY FROM (NOW() - public.compute_claim_last_activity(c.id)))::INT AS days_inactive
FROM claims c
WHERE c.status NOT IN ('Claim Settled', 'Dead File', 'Closed');

-- Function to auto-generate microtasks from claim state
CREATE OR REPLACE FUNCTION public.auto_generate_claim_microtasks()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  generated_count INTEGER := 0;
  claim_rec RECORD;
BEGIN
  -- Carrier Review > 14 days: follow up
  FOR claim_rec IN
    SELECT c.id AS claim_id
    FROM claims c
    WHERE c.status IN ('Carrier Review', 'Submitted Rebuttal to Carrier')
      AND public.compute_claim_last_activity(c.id) < NOW() - INTERVAL '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM claim_microtasks m
        WHERE m.claim_id = c.id
          AND m.task_type = 'auto_carrier_followup'
          AND m.status IN ('pending', 'in_progress')
      )
  LOOP
    INSERT INTO claim_microtasks (claim_id, title, description, task_type, priority, status, is_blocking, surfaced_on_board, due_at)
    VALUES (
      claim_rec.claim_id,
      'Follow up with carrier on pending review',
      'Carrier has had this claim in review for over 14 days without response.',
      'auto_carrier_followup',
      'high',
      'pending',
      false,
      true,
      NOW() + INTERVAL '1 day'
    );
    generated_count := generated_count + 1;
  END LOOP;

  -- No activity > 10 days on active claim
  FOR claim_rec IN
    SELECT c.id AS claim_id
    FROM claims c
    WHERE c.status NOT IN ('Claim Settled', 'Dead File', 'Closed', 'On Hold')
      AND public.compute_claim_last_activity(c.id) < NOW() - INTERVAL '10 days'
      AND NOT EXISTS (
        SELECT 1 FROM claim_microtasks m
        WHERE m.claim_id = c.id
          AND m.task_type = 'auto_status_update'
          AND m.status IN ('pending', 'in_progress')
      )
  LOOP
    INSERT INTO claim_microtasks (claim_id, title, description, task_type, priority, status, is_blocking, surfaced_on_board, due_at)
    VALUES (
      claim_rec.claim_id,
      'Add status update — no activity in 10+ days',
      'This claim has had no activity in over 10 days. Add a status update.',
      'auto_status_update',
      'normal',
      'pending',
      false,
      true,
      NOW() + INTERVAL '2 days'
    );
    generated_count := generated_count + 1;
  END LOOP;

  -- Carrier Review > 21 days: escalate
  FOR claim_rec IN
    SELECT c.id AS claim_id
    FROM claims c
    WHERE c.status = 'Carrier Review'
      AND public.compute_claim_last_activity(c.id) < NOW() - INTERVAL '21 days'
      AND NOT EXISTS (
        SELECT 1 FROM claim_microtasks m
        WHERE m.claim_id = c.id
          AND m.task_type = 'auto_escalate_no_response'
          AND m.status IN ('pending', 'in_progress')
      )
  LOOP
    INSERT INTO claim_microtasks (claim_id, title, description, task_type, priority, status, is_blocking, surfaced_on_board, due_at)
    VALUES (
      claim_rec.claim_id,
      'Escalate: no carrier response in 21+ days',
      'Carrier has not responded for over 21 days. Consider escalation or DOBI complaint.',
      'auto_escalate_no_response',
      'immediate',
      'pending',
      true,
      true,
      NOW()
    );
    generated_count := generated_count + 1;
  END LOOP;

  -- RD pending > 30 days
  FOR claim_rec IN
    SELECT c.id AS claim_id
    FROM claims c
    WHERE c.status IN ('Recoverable Depreciation Requested', 'Recoverable Depreciation')
      AND public.compute_claim_last_activity(c.id) < NOW() - INTERVAL '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM claim_microtasks m
        WHERE m.claim_id = c.id
          AND m.task_type = 'auto_rd_followup'
          AND m.status IN ('pending', 'in_progress')
      )
  LOOP
    INSERT INTO claim_microtasks (claim_id, title, description, task_type, priority, status, is_blocking, surfaced_on_board, due_at)
    VALUES (
      claim_rec.claim_id,
      'Follow up on Recoverable Depreciation payment',
      'RD has been pending for over 30 days. Follow up with carrier.',
      'auto_rd_followup',
      'high',
      'pending',
      false,
      true,
      NOW() + INTERVAL '1 day'
    );
    generated_count := generated_count + 1;
  END LOOP;

  -- Waiting on funds > 14 days
  FOR claim_rec IN
    SELECT c.id AS claim_id
    FROM claims c
    WHERE c.status IN ('Waiting on ACV Funds', 'Waiting on Insurance Funds (ACV)', 'Funding from Insurance', 'Waiting on Mortgage Check')
      AND public.compute_claim_last_activity(c.id) < NOW() - INTERVAL '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM claim_microtasks m
        WHERE m.claim_id = c.id
          AND m.task_type = 'auto_funds_followup'
          AND m.status IN ('pending', 'in_progress')
      )
  LOOP
    INSERT INTO claim_microtasks (claim_id, title, description, task_type, priority, status, is_blocking, surfaced_on_board, due_at)
    VALUES (
      claim_rec.claim_id,
      'Follow up on pending insurance funds',
      'Funds have been pending for over 14 days. Contact carrier or mortgage company.',
      'auto_funds_followup',
      'high',
      'pending',
      false,
      true,
      NOW() + INTERVAL '1 day'
    );
    generated_count := generated_count + 1;
  END LOOP;

  RETURN generated_count;
END;
$$;
