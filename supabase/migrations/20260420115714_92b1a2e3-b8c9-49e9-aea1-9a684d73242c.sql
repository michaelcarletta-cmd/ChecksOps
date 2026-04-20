CREATE TABLE IF NOT EXISTS public.ai_response_cache (
  cache_key text PRIMARY KEY,
  task text NOT NULL,
  claim_id text NOT NULL DEFAULT '_global',
  model text NOT NULL,
  search_mode text NOT NULL DEFAULT 'off',
  prompt_hash text NOT NULL,
  payload jsonb NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_ai_response_cache_expires_at ON public.ai_response_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_ai_response_cache_claim_id ON public.ai_response_cache (claim_id);

ALTER TABLE public.ai_response_cache ENABLE ROW LEVEL SECURITY;

-- Deny all client access; service role bypasses RLS so edge functions can read/write.
CREATE POLICY "ai_response_cache_no_client_access"
  ON public.ai_response_cache
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- Cleanup helper: callable by service role to purge expired entries.
CREATE OR REPLACE FUNCTION public.cleanup_expired_ai_response_cache()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.ai_response_cache WHERE expires_at < now();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_expired_ai_response_cache() FROM PUBLIC, anon, authenticated;