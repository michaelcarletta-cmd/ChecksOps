
-- Add execution system columns to existing tasks table
ALTER TABLE public.tasks 
  ADD COLUMN IF NOT EXISTS active_rank integer,
  ADD COLUMN IF NOT EXISTS priority_level text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS urgency_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS impact_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS age_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gravity_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_touched_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_reason text,
  ADD COLUMN IF NOT EXISTS done_definition text,
  ADD COLUMN IF NOT EXISTS linked_entity_type text,
  ADD COLUMN IF NOT EXISTS linked_entity_id uuid;

-- Add constraint for priority_level
ALTER TABLE public.tasks ADD CONSTRAINT tasks_priority_level_check 
  CHECK (priority_level IN ('low', 'medium', 'high', 'critical'));

-- Add indexes for execution queue queries
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status ON public.tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_active_rank ON public.tasks(assigned_to, active_rank) WHERE active_rank IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_gravity ON public.tasks(assigned_to, gravity_score DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_linked_claim ON public.tasks(claim_id) WHERE claim_id IS NOT NULL;

-- Create task_activity_events table
CREATE TABLE public.task_activity_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'created','activated','started','paused','resumed','reprioritized',
    'moved_to_backlog','blocked','completed','dropped','nudged','reviewed',
    'stale_flagged','daily_reset'
  )),
  metadata_json jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for timeline queries
CREATE INDEX idx_task_activity_task_created ON public.task_activity_events(task_id, created_at DESC);
CREATE INDEX idx_task_activity_user ON public.task_activity_events(user_id, created_at DESC);

-- Enable RLS on task_activity_events
ALTER TABLE public.task_activity_events ENABLE ROW LEVEL SECURITY;

-- RLS: admins and staff can view all task activity
CREATE POLICY "Admins and staff can view task activity"
  ON public.task_activity_events FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'staff'));

-- RLS: admins and staff can insert task activity  
CREATE POLICY "Admins and staff can insert task activity"
  ON public.task_activity_events FOR INSERT
  TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'staff'));

-- Migrate existing priority values to priority_level
UPDATE public.tasks SET priority_level = priority WHERE priority IN ('low', 'medium', 'high');
UPDATE public.tasks SET priority_level = 'critical' WHERE priority = 'urgent';

-- Set last_touched_at from updated_at for existing tasks
UPDATE public.tasks SET last_touched_at = updated_at WHERE last_touched_at IS NULL;
