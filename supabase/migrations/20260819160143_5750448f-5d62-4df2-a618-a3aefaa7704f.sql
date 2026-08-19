-- Add tenant_id if not present
ALTER TABLE public.email_send_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.suppressed_emails ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);

-- Enable RLS
ALTER TABLE public.email_send_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppressed_emails ENABLE ROW LEVEL SECURITY;

-- Drop existing restricted policies if they conflict (standard DO blocks for safety)
DO $$ BEGIN
  DROP POLICY IF EXISTS "Tenants can read their own email logs" ON public.email_send_log;
  DROP POLICY IF EXISTS "Tenants can read their own suppressed emails" ON public.suppressed_emails;
END $$;

-- Create policies for authenticated users
CREATE POLICY "Tenants can read their own email logs"
  ON public.email_send_log FOR SELECT
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE POLICY "Tenants can read their own suppressed emails"
  ON public.suppressed_emails FOR SELECT
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

-- Grant access to authenticated role
GRANT SELECT ON public.email_send_log TO authenticated;
GRANT SELECT ON public.suppressed_emails TO authenticated;
