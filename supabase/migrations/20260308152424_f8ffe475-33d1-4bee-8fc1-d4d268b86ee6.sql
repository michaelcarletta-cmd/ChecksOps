
-- Check Intake Items: core check record
CREATE TABLE public.check_intake_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID REFERENCES public.claims(id) ON DELETE SET NULL,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  front_image_path TEXT NOT NULL,
  back_image_path TEXT,
  carrier_name TEXT,
  check_number TEXT,
  amount NUMERIC(12,2),
  issue_date DATE,
  detected_claim_number TEXT,
  payee_line TEXT,
  is_multi_payee BOOLEAN DEFAULT false,
  raw_ocr_front JSONB,
  raw_ocr_back JSONB,
  ocr_status TEXT DEFAULT 'pending' CHECK (ocr_status IN ('pending','processing','completed','failed')),
  deposit_recommendation TEXT CHECK (deposit_recommendation IN ('ready_for_deposit','endorsements_pending','branch_deposit_recommended','request_reissue')),
  deposit_recommendation_reasons JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'uploaded' CHECK (status IN ('uploaded','ocr_complete','endorsements_in_progress','ready','needs_review','deposited','voided')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Check Payees: individual payee records per check
CREATE TABLE public.check_payees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  payee_name TEXT NOT NULL,
  payee_type TEXT DEFAULT 'unknown' CHECK (payee_type IN ('insured','mortgage_company','contractor','public_adjuster','unknown')),
  endorsement_status TEXT DEFAULT 'pending' CHECK (endorsement_status IN ('pending','viewed','signed','rejected','expired')),
  endorsement_token TEXT UNIQUE,
  endorsement_token_expires_at TIMESTAMPTZ,
  endorsement_image_path TEXT,
  endorsed_at TIMESTAMPTZ,
  contact_email TEXT,
  contact_phone TEXT,
  notification_sent_via TEXT CHECK (notification_sent_via IN ('email','sms','both')),
  notification_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Check Endorsement Events: event log for endorsement workflow
CREATE TABLE public.check_endorsement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  payee_id UUID REFERENCES public.check_payees(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB DEFAULT '{}'::jsonb,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Check Eligibility Results: deposit eligibility evaluation
CREATE TABLE public.check_eligibility_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  recommendation TEXT NOT NULL CHECK (recommendation IN ('ready_for_deposit','endorsements_pending','branch_deposit_recommended','request_reissue')),
  reasons JSONB DEFAULT '[]'::jsonb,
  rule_results JSONB DEFAULT '{}'::jsonb,
  evaluated_at TIMESTAMPTZ DEFAULT now(),
  evaluated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Check Audit Log: full event timeline
CREATE TABLE public.check_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_description TEXT,
  event_data JSONB DEFAULT '{}'::jsonb,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_check_intake_claim ON public.check_intake_items(claim_id);
CREATE INDEX idx_check_intake_status ON public.check_intake_items(status);
CREATE INDEX idx_check_payees_check ON public.check_payees(check_id);
CREATE INDEX idx_check_payees_token ON public.check_payees(endorsement_token);
CREATE INDEX idx_check_audit_check ON public.check_audit_log(check_id);
CREATE INDEX idx_check_endorsement_events_check ON public.check_endorsement_events(check_id);

-- RLS
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_payees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_endorsement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_eligibility_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_audit_log ENABLE ROW LEVEL SECURITY;

-- Staff and admin can do everything
CREATE POLICY "Staff can manage check_intake_items" ON public.check_intake_items
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

CREATE POLICY "Staff can manage check_payees" ON public.check_payees
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

CREATE POLICY "Staff can manage check_endorsement_events" ON public.check_endorsement_events
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

CREATE POLICY "Staff can manage check_eligibility_results" ON public.check_eligibility_results
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

CREATE POLICY "Staff can manage check_audit_log" ON public.check_audit_log
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

-- Read-only users can view
CREATE POLICY "Read-only can view check_intake_items" ON public.check_intake_items
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'read_only'));

CREATE POLICY "Read-only can view check_payees" ON public.check_payees
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'read_only'));

CREATE POLICY "Read-only can view check_audit_log" ON public.check_audit_log
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'read_only'));
