-- 1. Rules table: status -> inactivity threshold
CREATE TABLE public.status_urgency_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL UNIQUE,
  display_label text NOT NULL,
  status_names text[] NOT NULL,
  threshold_days integer NOT NULL,
  count_mode text NOT NULL DEFAULT 'calendar' CHECK (count_mode IN ('calendar','business')),
  trigger_kind text NOT NULL DEFAULT 'inactivity' CHECK (trigger_kind IN ('inactivity','inspection_morning_of','inspection_day_after')),
  is_enabled boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.status_urgency_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view urgency rules"
  ON public.status_urgency_rules FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'staff'));

CREATE POLICY "Admins can manage urgency rules"
  ON public.status_urgency_rules FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- 2. SMS recipients (workspace-wide admin phone list)
CREATE TABLE public.urgency_sms_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  phone_number text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.urgency_sms_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage urgency sms recipients"
  ON public.urgency_sms_recipients FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- 3. last_activity_at on claims (seeded from updated_at)
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
UPDATE public.claims SET last_activity_at = COALESCE(updated_at, created_at) WHERE last_activity_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_claims_status_last_activity ON public.claims(status, last_activity_at) WHERE is_closed = false;

-- 4. Trigger: any new claim_updates row resets last_activity_at
CREATE OR REPLACE FUNCTION public.bump_claim_last_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.claims
     SET last_activity_at = COALESCE(NEW.created_at, now())
   WHERE id = NEW.claim_id
     AND (last_activity_at IS NULL OR last_activity_at < COALESCE(NEW.created_at, now()));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_updates_bump_activity ON public.claim_updates;
CREATE TRIGGER trg_claim_updates_bump_activity
AFTER INSERT ON public.claim_updates
FOR EACH ROW EXECUTE FUNCTION public.bump_claim_last_activity();

-- Also reset when claim status itself changes (treat status change as activity)
CREATE OR REPLACE FUNCTION public.bump_claim_activity_on_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.last_activity_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claims_status_change_activity ON public.claims;
CREATE TRIGGER trg_claims_status_change_activity
BEFORE UPDATE ON public.claims
FOR EACH ROW EXECUTE FUNCTION public.bump_claim_activity_on_status_change();

-- 5. Notification log (cadence + dedupe)
CREATE TABLE public.status_urgency_notifications_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  rule_id uuid NOT NULL REFERENCES public.status_urgency_rules(id) ON DELETE CASCADE,
  status_at_breach text NOT NULL,
  inspection_id uuid,
  notification_kind text NOT NULL DEFAULT 'inactivity',
  first_breached_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz NOT NULL DEFAULT now(),
  total_sent integer NOT NULL DEFAULT 1,
  sms_recipient_count integer NOT NULL DEFAULT 0,
  warning_id uuid,
  is_resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_urg_notif_unique_active
  ON public.status_urgency_notifications_log(claim_id, rule_id, status_at_breach, COALESCE(inspection_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_resolved = false;

ALTER TABLE public.status_urgency_notifications_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff view urgency notification log"
  ON public.status_urgency_notifications_log FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'staff'));

-- updated_at trigger reuse
DROP TRIGGER IF EXISTS trg_urg_rules_updated_at ON public.status_urgency_rules;
CREATE TRIGGER trg_urg_rules_updated_at BEFORE UPDATE ON public.status_urgency_rules
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_urg_recipients_updated_at ON public.urgency_sms_recipients;
CREATE TRIGGER trg_urg_recipients_updated_at BEFORE UPDATE ON public.urgency_sms_recipients
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_urg_log_updated_at ON public.status_urgency_notifications_log;
CREATE TRIGGER trg_urg_log_updated_at BEFORE UPDATE ON public.status_urgency_notifications_log
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6. Seed rules per spec mapping
INSERT INTO public.status_urgency_rules (rule_key, display_label, status_names, threshold_days, count_mode, trigger_kind, notes) VALUES
  ('ready_for_filing','Claim Ready for Filing', ARRAY['Estimate Submitted to Carrier','Documents Sent for Signature','Need to Prepare Estimate'], 3, 'calendar', 'inactivity', 'Maps to pre-filing prep statuses'),
  ('claim_filed','Claim Filed', ARRAY['Documents sent to Carrier'], 2, 'calendar', 'inactivity', NULL),
  ('inspection_morning','Inspections (morning of)', ARRAY['Adjuster Meeting Scheduled','Adjuster Assigned/Scheduling Inspection','Adjuster Meeting - Reinspection','Schedule Reinspection'], 0, 'calendar', 'inspection_morning_of', 'Fires morning of scheduled inspection'),
  ('inspection_after','Inspections (day after)', ARRAY['Adjuster Meeting Scheduled','Adjuster Assigned/Scheduling Inspection','Adjuster Meeting - Reinspection','Schedule Reinspection'], 1, 'calendar', 'inspection_day_after', 'Fires day after if no update logged'),
  ('carrier_review','Carrier Review', ARRAY['Carrier Review','Waiting on Carrier Estimate','Research / Investigation'], 10, 'business', 'inactivity', '10 business days'),
  ('dobi_compliance','DOBI Compliance', ARRAY['DOBI Complaint Filed'], 21, 'calendar', 'inactivity', NULL),
  ('repair_sample','Repair Attempt / Sample Needed', ARRAY['Repair Attempt / Sample Needed','Prove It Method'], 5, 'calendar', 'inactivity', NULL),
  ('appraisal','Appraisal', ARRAY['Appraisal','Appraisal - Umpire'], 21, 'calendar', 'inactivity', NULL),
  ('funding_insurance','Funding from Insurance', ARRAY['Waiting on Insurance Funds (ACV)','Waiting on ACV Funds','Waiting on Mortgage Check','Waiting on Recoverable Depreciation Check','Recoverable Depreciation Requested'], 10, 'calendar', 'inactivity', NULL),
  ('check_uploaded','Check Uploaded for Processing', ARRAY['Check Processing on iink'], 3, 'calendar', 'inactivity', NULL),
  ('job_in_production','Job in Production', ARRAY['Job in Production'], 15, 'calendar', 'inactivity', NULL),
  ('messages_received','Messages Received', ARRAY['Message Received from Carrier','Message Received from Client'], 2, 'calendar', 'inactivity', NULL);

-- 7. Remove any existing Litigation-related warnings from active queue
UPDATE public.claim_warnings_log w
   SET is_resolved = true, resolved_at = now()
  FROM public.claims c
 WHERE w.claim_id = c.id
   AND c.status = 'Litigation'
   AND w.is_resolved = false
   AND w.is_dismissed = false;