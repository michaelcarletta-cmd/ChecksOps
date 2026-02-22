
-- Add heartbeat columns to darwin_jobs
ALTER TABLE public.darwin_jobs
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS ttl_seconds integer NOT NULL DEFAULT 120;

-- Atomic acquire-or-steal RPC
CREATE OR REPLACE FUNCTION public.acquire_darwin_job(
  p_job_type text,
  p_claimed_by text,
  p_ttl_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row darwin_jobs;
BEGIN
  -- Try to atomically claim the job if idle OR heartbeat expired
  UPDATE darwin_jobs
  SET
    status = 'running',
    started_at = now(),
    heartbeat_at = now(),
    claimed_by = p_claimed_by,
    ttl_seconds = p_ttl_seconds,
    error_message = NULL,
    completed_at = NULL
  WHERE job_type = p_job_type
    AND (
      status != 'running'
      OR heartbeat_at IS NULL
      OR (now() - heartbeat_at) > (ttl_seconds * interval '1 second')
    )
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    -- Lock is held and heartbeat is fresh
    SELECT * INTO v_row FROM darwin_jobs WHERE job_type = p_job_type;
    RETURN jsonb_build_object(
      'acquired', false,
      'status', v_row.status,
      'claimed_by', v_row.claimed_by,
      'heartbeat_at', v_row.heartbeat_at,
      'started_at', v_row.started_at
    );
  END IF;

  RETURN jsonb_build_object('acquired', true, 'started_at', v_row.started_at);
END;
$$;

-- Heartbeat update RPC
CREATE OR REPLACE FUNCTION public.heartbeat_darwin_job(
  p_job_type text,
  p_claimed_by text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE darwin_jobs
  SET heartbeat_at = now()
  WHERE job_type = p_job_type
    AND claimed_by = p_claimed_by
    AND status = 'running';
  RETURN FOUND;
END;
$$;

-- Release job RPC
CREATE OR REPLACE FUNCTION public.release_darwin_job(
  p_job_type text,
  p_error_message text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE darwin_jobs
  SET
    status = 'idle',
    completed_at = now(),
    heartbeat_at = NULL,
    error_message = p_error_message
  WHERE job_type = p_job_type;
  RETURN FOUND;
END;
$$;
