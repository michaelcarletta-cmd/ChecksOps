
-- Add 'increase' to deposit_provider enum
ALTER TYPE public.deposit_provider ADD VALUE IF NOT EXISTS 'increase';

-- Add Increase tracking columns to deposit_items
ALTER TABLE public.deposit_items
  ADD COLUMN IF NOT EXISTS increase_account_id text,
  ADD COLUMN IF NOT EXISTS increase_check_deposit_id text,
  ADD COLUMN IF NOT EXISTS increase_status text,
  ADD COLUMN IF NOT EXISTS increase_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS increase_last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS increase_raw_response jsonb;

-- Create increase_settings table for storing target account
CREATE TABLE IF NOT EXISTS public.increase_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text UNIQUE NOT NULL,
  setting_value jsonb NOT NULL,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid
);

ALTER TABLE public.increase_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff and admins can manage increase settings"
  ON public.increase_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

-- Add increase provider config
INSERT INTO public.deposit_provider_config (provider, display_name, is_active, is_stubbed, capabilities, config)
VALUES ('increase', 'Increase (Sandbox)', true, false, '{"rdc": true, "api": true}'::jsonb, '{"base_url": "https://api.sandbox.increase.com"}'::jsonb)
ON CONFLICT DO NOTHING;
