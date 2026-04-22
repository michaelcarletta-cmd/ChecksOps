
-- Professional types enum
CREATE TYPE public.professional_type AS ENUM ('contractor', 'public_adjuster', 'attorney');

-- Referral alert types
CREATE TYPE public.referral_alert_type AS ENUM ('needs_contractor', 'needs_public_adjuster', 'needs_attorney');

-- Referral professionals table
CREATE TABLE public.referral_professionals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  professional_type professional_type NOT NULL,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  states_served TEXT[] NOT NULL DEFAULT '{}',
  specialties TEXT[] NOT NULL DEFAULT '{}',
  description TEXT,
  logo_url TEXT,
  is_premium BOOLEAN NOT NULL DEFAULT false,
  premium_expires_at TIMESTAMPTZ,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  rating NUMERIC(3,2) DEFAULT 0,
  reviews_count INTEGER DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_auto_discovered BOOLEAN NOT NULL DEFAULT false,
  discovery_source TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.referral_professionals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view active professionals"
  ON public.referral_professionals FOR SELECT TO authenticated
  USING (is_active = true);

CREATE POLICY "Admins can manage professionals"
  ON public.referral_professionals FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Referral recommendations
CREATE TABLE public.referral_recommendations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  professional_id UUID NOT NULL REFERENCES public.referral_professionals(id) ON DELETE CASCADE,
  recommendation_reason TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  was_selected BOOLEAN NOT NULL DEFAULT false,
  selected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.referral_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Guided users can view recommendations for their claims"
  ON public.referral_recommendations FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.guided_claim_access gca
      WHERE gca.claim_id = referral_recommendations.claim_id AND gca.user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Admins can manage recommendations"
  ON public.referral_recommendations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Guided users can update their own recommendations"
  ON public.referral_recommendations FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.guided_claim_access gca
      WHERE gca.claim_id = referral_recommendations.claim_id AND gca.user_id = auth.uid()
    )
  );

-- Referral alerts
CREATE TABLE public.referral_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  alert_type referral_alert_type NOT NULL,
  trigger_reason TEXT NOT NULL,
  notification_method TEXT NOT NULL DEFAULT 'both',
  message TEXT,
  is_dismissed BOOLEAN NOT NULL DEFAULT false,
  is_actioned BOOLEAN NOT NULL DEFAULT false,
  actioned_at TIMESTAMPTZ,
  email_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.referral_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Guided users can view alerts for their claims"
  ON public.referral_alerts FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.guided_claim_access gca
      WHERE gca.claim_id = referral_alerts.claim_id AND gca.user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Guided users can update their own alerts"
  ON public.referral_alerts FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.guided_claim_access gca
      WHERE gca.claim_id = referral_alerts.claim_id AND gca.user_id = auth.uid()
    )
  );

CREATE POLICY "Admins can manage alerts"
  ON public.referral_alerts FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "System can insert recommendations"
  ON public.referral_recommendations FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "System can insert alerts"
  ON public.referral_alerts FOR INSERT TO authenticated
  WITH CHECK (true);

-- Indexes
CREATE INDEX idx_referral_professionals_type_state ON public.referral_professionals USING GIN (states_served);
CREATE INDEX idx_referral_professionals_premium ON public.referral_professionals (is_premium, is_active);
CREATE INDEX idx_referral_alerts_claim ON public.referral_alerts (claim_id, is_dismissed);
CREATE INDEX idx_referral_recommendations_claim ON public.referral_recommendations (claim_id);

-- Updated_at triggers
CREATE TRIGGER update_referral_professionals_updated_at
  BEFORE UPDATE ON public.referral_professionals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_referral_alerts_updated_at
  BEFORE UPDATE ON public.referral_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
