-- Table to track automated reminder logs for endorsements
CREATE TABLE IF NOT EXISTS public.endorsement_automated_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endorsement_id UUID NOT NULL REFERENCES public.check_endorsements(id) ON DELETE CASCADE,
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    reminder_number INTEGER NOT NULL,
    recipient_email TEXT NOT NULL,
    tenant_id UUID REFERENCES public.tenants(id)
);

-- Index for checking pending reminders efficiently
CREATE INDEX IF NOT EXISTS idx_endorsement_reminders_endorsement_id ON public.endorsement_automated_reminders(endorsement_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.endorsement_automated_reminders TO authenticated;
GRANT ALL ON public.endorsement_automated_reminders TO service_role;
ALTER TABLE public.endorsement_automated_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage reminders" ON public.endorsement_automated_reminders FOR ALL USING (true);

-- Function to handle the actual sending via Edge Function
-- This will be called by a cron or a scheduled trigger
-- For now, we'll rely on the existing Edge Function being called.

-- To implement "every 48 hours", we check check_endorsements where:
-- 1. Status is 'sent'
-- 2. request_sent_at is > 48 hours ago
-- 3. last_reminder_at is NULL OR > 48 hours ago
-- 4. contact_email is NOT NULL

-- We can use pg_cron if available, or just a wrapper function that we call.
CREATE OR REPLACE FUNCTION public.process_endorsement_reminders()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r RECORD;
    sent_count INTEGER := 0;
    result_log JSONB := '[]'::jsonb;
BEGIN
    FOR r IN 
        SELECT 
            e.id, 
            e.contact_email, 
            e.payee_name,
            e.reminder_count
        FROM public.check_endorsements e
        WHERE e.status = 'sent'
          AND e.contact_email IS NOT NULL
          AND e.contact_email != ''
          -- Only if never reminded AND request sent > 48h ago
          -- OR last reminder was > 48h ago
          AND (
            (e.last_reminder_at IS NULL AND e.request_sent_at < now() - interval '48 hours')
            OR 
            (e.last_reminder_at < now() - interval '48 hours')
          )
        LIMIT 50 -- Batch size
    LOOP
        -- We don't send the email directly from SQL. 
        -- Instead, we'll return the list and have the Edge Function caller handle it,
        -- OR we can trigger a generic email task.
        -- But the easiest is to have a scheduled Edge Function that calls this.
        
        sent_count := sent_count + 1;
        result_log := result_log || jsonb_build_object('id', r.id, 'email', r.contact_email);
    END LOOP;

    RETURN json_build_object('count', sent_count, 'targets', result_log);
END;
$$;
