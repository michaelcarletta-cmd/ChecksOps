
-- Step 1: Add columns to deposit_items
ALTER TABLE public.deposit_items
  ADD COLUMN IF NOT EXISTS bank_reference text,
  ADD COLUMN IF NOT EXISTS bank_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS bank_confirmed_by uuid,
  ADD COLUMN IF NOT EXISTS deposit_slip_number text,
  ADD COLUMN IF NOT EXISTS variance_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS variance_reason text,
  ADD COLUMN IF NOT EXISTS return_reason text,
  ADD COLUMN IF NOT EXISTS nsf_flag boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS accounting_synced_at timestamptz;

-- Step 2: deposit_attachments table
CREATE TABLE IF NOT EXISTS public.deposit_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_item_id uuid NOT NULL REFERENCES public.deposit_items(id) ON DELETE CASCADE,
  attachment_type text NOT NULL CHECK (attachment_type IN ('deposit_slip','stamped_receipt','bank_confirmation','branch_manifest','other')),
  file_name text NOT NULL,
  file_path text NOT NULL,
  file_size integer,
  uploaded_by uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deposit_attachments_item ON public.deposit_attachments(deposit_item_id);
ALTER TABLE public.deposit_attachments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='deposit_attachments' AND policyname='Staff can manage deposit attachments') THEN
    CREATE POLICY "Staff can manage deposit attachments" ON public.deposit_attachments
      FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
      WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
  END IF;
END $$;

-- Step 3: Provider config table
CREATE TABLE IF NOT EXISTS public.deposit_provider_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL UNIQUE,
  display_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  is_stubbed boolean NOT NULL DEFAULT true,
  config jsonb DEFAULT '{}'::jsonb,
  capabilities jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deposit_provider_config ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='deposit_provider_config' AND policyname='Staff can read provider config') THEN
    CREATE POLICY "Staff can read provider config" ON public.deposit_provider_config
      FOR SELECT TO authenticated
      USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='deposit_provider_config' AND policyname='Admin can manage provider config') THEN
    CREATE POLICY "Admin can manage provider config" ON public.deposit_provider_config
      FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), 'admin'))
      WITH CHECK (public.has_role(auth.uid(), 'admin'));
  END IF;
END $$;

INSERT INTO public.deposit_provider_config (provider, display_name, is_active, is_stubbed, capabilities) VALUES
  ('manual_branch', 'Manual / Branch Deposit', true, false, '["deposit_slip","stamped_receipt","bank_confirmation"]'::jsonb),
  ('internal_ready', 'Internal Ready (Desktop)', true, false, '["deposit_slip","bank_confirmation"]'::jsonb),
  ('synctera', 'Synctera API', false, true, '["api_submission","webhook","auto_reconciliation"]'::jsonb),
  ('treasury_prime', 'Treasury Prime API', false, true, '["api_submission","webhook","auto_reconciliation"]'::jsonb)
ON CONFLICT (provider) DO NOTHING;

-- Step 4: Resolved columns on exceptions
ALTER TABLE public.deposit_exceptions ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE public.deposit_exceptions ADD COLUMN IF NOT EXISTS resolved_by uuid;
ALTER TABLE public.deposit_exceptions ADD COLUMN IF NOT EXISTS resolution_notes text;

-- Step 5: Storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('deposit-attachments', 'deposit-attachments', false)
ON CONFLICT (id) DO NOTHING;
