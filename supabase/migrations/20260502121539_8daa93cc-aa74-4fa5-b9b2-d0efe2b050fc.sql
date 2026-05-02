-- Messages thread per check
CREATE TABLE public.check_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  check_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 5000),
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_check_messages_check_id_created ON public.check_messages(check_id, created_at DESC);
CREATE INDEX idx_check_messages_sender ON public.check_messages(sender_id);

ALTER TABLE public.check_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read check messages"
  ON public.check_messages FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can post check messages"
  ON public.check_messages FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = sender_id);

CREATE POLICY "Senders can update their own messages"
  ON public.check_messages FOR UPDATE
  TO authenticated
  USING (auth.uid() = sender_id)
  WITH CHECK (auth.uid() = sender_id);

CREATE POLICY "Senders or admins can delete messages"
  ON public.check_messages FOR DELETE
  TO authenticated
  USING (auth.uid() = sender_id OR public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_check_messages_updated_at
  BEFORE UPDATE ON public.check_messages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Per-user read receipts per check thread
CREATE TABLE public.check_message_reads (
  user_id UUID NOT NULL,
  check_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, check_id)
);

ALTER TABLE public.check_message_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own read receipts (select)"
  ON public.check_message_reads FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users manage their own read receipts (insert)"
  ON public.check_message_reads FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage their own read receipts (update)"
  ON public.check_message_reads FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- RPC: per-check unread counts for current user
CREATE OR REPLACE FUNCTION public.get_check_unread_counts()
RETURNS TABLE(check_id UUID, unread_count BIGINT, last_message_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.check_id,
    COUNT(*) FILTER (
      WHERE m.sender_id <> auth.uid()
        AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
    ) AS unread_count,
    MAX(m.created_at) AS last_message_at
  FROM public.check_messages m
  LEFT JOIN public.check_message_reads r
    ON r.check_id = m.check_id AND r.user_id = auth.uid()
  WHERE m.is_deleted = false
  GROUP BY m.check_id;
$$;

-- RPC: total unread for header bell
CREATE OR REPLACE FUNCTION public.get_total_unread_check_messages()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(unread_count), 0)::BIGINT
  FROM public.get_check_unread_counts();
$$;