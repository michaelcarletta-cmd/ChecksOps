
-- ============================================================
-- Phase 1 Extension: Task Creation + Client Updates via SMS
-- ============================================================

-- 1. Extend darwin_sms_activity with action metadata
ALTER TABLE public.darwin_sms_activity
  ADD COLUMN IF NOT EXISTS action_type TEXT,
  ADD COLUMN IF NOT EXISTS result_id TEXT,
  ADD COLUMN IF NOT EXISTS needs_approval BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID;

-- 2. Extend sms_conversation_state with pending action storage
ALTER TABLE public.sms_conversation_state
  ADD COLUMN IF NOT EXISTS pending_action JSONB;

-- 3. Create darwin_sms_settings table for org-level send mode
CREATE TABLE IF NOT EXISTS public.darwin_sms_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL UNIQUE,
  send_mode TEXT NOT NULL DEFAULT 'draft',
  auto_send_roles TEXT[] DEFAULT '{admin}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.darwin_sms_settings ENABLE ROW LEVEL SECURITY;

-- Org admins can read their own org settings
CREATE POLICY "Org admins can read sms settings"
  ON public.darwin_sms_settings FOR SELECT
  USING (public.is_org_admin(auth.uid(), org_id));

-- Org admins can insert their own org settings
CREATE POLICY "Org admins can insert sms settings"
  ON public.darwin_sms_settings FOR INSERT
  WITH CHECK (public.is_org_admin(auth.uid(), org_id));

-- Org admins can update their own org settings
CREATE POLICY "Org admins can update sms settings"
  ON public.darwin_sms_settings FOR UPDATE
  USING (public.is_org_admin(auth.uid(), org_id));

-- Auto-update updated_at
CREATE TRIGGER update_darwin_sms_settings_updated_at
  BEFORE UPDATE ON public.darwin_sms_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
