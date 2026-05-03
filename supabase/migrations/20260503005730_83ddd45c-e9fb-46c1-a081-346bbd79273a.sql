CREATE TABLE IF NOT EXISTS public.shared_check_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL,
  sender_user_id uuid NOT NULL,
  sender_tenant_id uuid NOT NULL,
  body text NOT NULL CHECK (length(trim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shared_check_messages_check
  ON public.shared_check_messages(check_id, created_at);

ALTER TABLE public.shared_check_messages ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.user_can_access_shared_check(_check_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.shared_checks sc
    JOIN public.tenant_users tu
      ON tu.tenant_id IN (sc.source_tenant_id, sc.target_tenant_id)
    WHERE sc.check_id = _check_id
      AND sc.revoked_at IS NULL
      AND tu.user_id = _user_id
  );
$$;

CREATE POLICY "read shared check messages"
  ON public.shared_check_messages FOR SELECT
  USING (public.user_can_access_shared_check(check_id, auth.uid()));

CREATE POLICY "post shared check messages"
  ON public.shared_check_messages FOR INSERT
  WITH CHECK (
    sender_user_id = auth.uid()
    AND public.user_can_access_shared_check(check_id, auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.user_id = auth.uid() AND tu.tenant_id = sender_tenant_id
    )
  );

ALTER PUBLICATION supabase_realtime ADD TABLE public.shared_check_messages;