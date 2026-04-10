
-- Add immediate task fields to existing tasks table
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS immediate_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notification_channels text[] NOT NULL DEFAULT '{in_app}',
  ADD COLUMN IF NOT EXISTS notification_strategy text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS escalation_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sms_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS snooze_allowed boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_snooze_count integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS snooze_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS escalation_level integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_notified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS next_notification_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS requires_acknowledgement boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS due_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS deadline_source text NULL,
  ADD COLUMN IF NOT EXISTS countdown_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_acknowledged_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS urgent_reason text NULL;

-- Create notification delivery logs table
CREATE TABLE public.notification_delivery_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  channel text NOT NULL,
  notification_type text NOT NULL,
  escalation_level integer NOT NULL DEFAULT 0,
  delivery_status text NOT NULL,
  provider_response jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.notification_delivery_logs ENABLE ROW LEVEL SECURITY;

-- RLS policies for notification_delivery_logs
CREATE POLICY "Users can view own notification logs"
  ON public.notification_delivery_logs
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notification logs"
  ON public.notification_delivery_logs
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Performance indexes on tasks
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_priority ON public.tasks(assigned_to, priority_level);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_immediate ON public.tasks(assigned_to, immediate_enabled) WHERE immediate_enabled = true;
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_next_notify ON public.tasks(assigned_to, next_notification_at) WHERE next_notification_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_due ON public.tasks(assigned_to, due_at) WHERE due_at IS NOT NULL;

-- Performance indexes on notification_delivery_logs
CREATE INDEX idx_notif_logs_task_created ON public.notification_delivery_logs(task_id, created_at DESC);
CREATE INDEX idx_notif_logs_user_created ON public.notification_delivery_logs(user_id, created_at DESC);
