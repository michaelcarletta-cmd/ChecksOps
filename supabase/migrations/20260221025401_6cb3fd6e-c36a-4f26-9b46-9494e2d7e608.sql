
-- Phase 4.5: Escalation Actions + Artifact Templates

-- 1) Escalation actions — tracks every draft/sent/resolved artifact
CREATE TABLE public.escalation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  state_code text NOT NULL,
  fired_rule_ids uuid[] NOT NULL DEFAULT '{}',
  escalation_strength text NOT NULL CHECK (escalation_strength IN ('soft_leverage','formal_leverage','regulatory_leverage')),
  artifact_type text NOT NULL CHECK (artifact_type IN ('engineer_rebuttal','supplement','position_request','ia_rebuttal')),
  artifact_document_id uuid REFERENCES public.claim_files(id) ON DELETE SET NULL,
  draft_content text,
  status text NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted','sent','acknowledged','resolved')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.escalation_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view escalation actions" ON public.escalation_actions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can insert escalation actions" ON public.escalation_actions
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

CREATE POLICY "Staff can update escalation actions" ON public.escalation_actions
  FOR UPDATE TO authenticated USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

CREATE INDEX idx_escalation_actions_claim ON public.escalation_actions(claim_id);
CREATE INDEX idx_escalation_actions_status ON public.escalation_actions(status);

CREATE TRIGGER update_escalation_actions_updated_at
  BEFORE UPDATE ON public.escalation_actions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2) Artifact templates — state-specific language blocks
CREATE TABLE public.escalation_artifact_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code text NOT NULL,
  artifact_type text NOT NULL CHECK (artifact_type IN ('engineer_rebuttal','supplement','position_request','ia_rebuttal')),
  insert_block_type text NOT NULL,
  template_body text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.escalation_artifact_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view artifact templates" ON public.escalation_artifact_templates
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage artifact templates" ON public.escalation_artifact_templates
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_artifact_templates_lookup ON public.escalation_artifact_templates(state_code, artifact_type, is_active);

CREATE TRIGGER update_artifact_templates_updated_at
  BEFORE UPDATE ON public.escalation_artifact_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3) Seed PA templates
INSERT INTO public.escalation_artifact_templates (state_code, artifact_type, insert_block_type, template_body) VALUES
-- Position Request
('PA', 'position_request', 'opening', '## Formal Request for Written Coverage Position

**Re: Claim No. {{claim_number}} | Policy No. {{policy_number}}**
**Insured: {{insured_name}}**
**Property: {{property_address}}**
**Date of Loss: {{loss_date}}**
**Carrier: {{carrier}}**

Dear {{adjuster_name}},

This letter serves as a formal request for a written coverage position regarding the above-referenced claim. To date, we have not received a definitive written statement of coverage applicability or denial.'),

('PA', 'position_request', 'delay', 'Under Pennsylvania claim handling standards (31 Pa. Code § 146.5), insurers are required to provide timely communication of coverage determinations. The claim was filed {{days_since_filed}} days ago, and the absence of a written coverage position impedes the policyholder''s ability to plan repairs and exercise their rights under the policy.

We respectfully request that a written coverage determination, including any partial coverage positions, be provided within ten (10) business days of receipt of this correspondence.'),

('PA', 'position_request', 'closing', 'We trust this matter will receive prompt attention. We remain available to discuss any outstanding documentation needs or to schedule any necessary inspections.

Sincerely,
{{company_name}}
Public Adjuster for {{insured_name}}'),

-- Supplement Narrative
('PA', 'supplement', 'opening', '## Supplement Narrative — Additional Scope & Damages

**Re: Claim No. {{claim_number}} | Policy No. {{policy_number}}**
**Insured: {{insured_name}}**
**Property: {{property_address}}**
**Date of Loss: {{loss_date}}**

The following supplement addresses additional scope items and damages identified upon further inspection that were not included in the carrier''s initial estimate.'),

('PA', 'supplement', 'matching', 'Regarding the question of component matching: Pennsylvania standards recognize that partial repairs must achieve a reasonably uniform appearance. Where replacement materials cannot achieve uniformity of appearance with adjacent undamaged materials of the same type, the scope must be extended to include the contiguous area necessary to achieve a consistent appearance (31 Pa. Code § 146.7(c)).'),

('PA', 'supplement', 'closing', 'We respectfully request a revised estimate and payment reflecting the supplemental scope documented herein. We are available to coordinate a joint re-inspection at mutual convenience.

Respectfully,
{{company_name}}
Public Adjuster for {{insured_name}}'),

-- Engineer Rebuttal
('PA', 'engineer_rebuttal', 'opening', '## Rebuttal to Engineering Report

**Re: Claim No. {{claim_number}} | Policy No. {{policy_number}}**
**Insured: {{insured_name}}**
**Property: {{property_address}}**
**Date of Loss: {{loss_date}}**
**Engineer Report Under Review: {{engineer_report_ref}}**

The following addresses specific findings and conclusions in the referenced engineering report that are inconsistent with observed field conditions, industry standards, and the applicable damage causation evidence.'),

('PA', 'engineer_rebuttal', 'engineer', 'The engineering report''s attribution of observed damage to pre-existing conditions or normal wear does not account for the documented weather event on {{loss_date}} and the pattern of damage observed across the property. Damage patterns—including directional consistency, collateral impact indicators, and the distribution of affected components—are consistent with storm-related impact rather than the gradual deterioration cited in the report.'),

('PA', 'engineer_rebuttal', 'closing', 'We request that the carrier reconsider the engineering report''s conclusions in light of the above observations and field evidence. We remain available for a joint inspection or to discuss any technical questions.

Respectfully,
{{company_name}}
Public Adjuster for {{insured_name}}'),

-- IA Rebuttal
('PA', 'ia_rebuttal', 'opening', '## Response to Independent Adjuster Scope Assessment

**Re: Claim No. {{claim_number}} | Policy No. {{policy_number}}**
**Insured: {{insured_name}}**
**Property: {{property_address}}**
**Date of Loss: {{loss_date}}**

This correspondence addresses discrepancies identified in the independent adjuster''s scope assessment compared to field-verified conditions and applicable estimating standards.'),

('PA', 'ia_rebuttal', 'scope', 'The assessment under-scopes the following areas, which were documented during our on-site inspection:

{{scope_items}}

Each omitted item has been photographed, measured, and documented in accordance with industry estimating practices. The discrepancy between the IA''s estimate and the documented conditions represents a material underpayment that requires correction.'),

('PA', 'ia_rebuttal', 'closing', 'We request a revised estimate reflecting the documented scope and invite the carrier to schedule a joint re-inspection to verify the items identified above.

Respectfully,
{{company_name}}
Public Adjuster for {{insured_name}}'),

-- NJ Position Request
('NJ', 'position_request', 'opening', '## Formal Request for Written Coverage Position

**Re: Claim No. {{claim_number}} | Policy No. {{policy_number}}**
**Insured: {{insured_name}}**
**Property: {{property_address}}**
**Date of Loss: {{loss_date}}**
**Carrier: {{carrier}}**

Dear {{adjuster_name}},

This letter constitutes a formal request for a written determination of coverage for the above-referenced claim. To date, no definitive written coverage position has been communicated.'),

('NJ', 'position_request', 'delay', 'New Jersey''s Unfair Claims Settlement Practices Act (N.J.S.A. 17:29B-4) and implementing regulations (N.J.A.C. 11:2-17.6) establish clear standards for timely claim handling. It has been {{days_since_filed}} days since the claim was reported. A written coverage determination is necessary for the insured to make informed decisions regarding property repairs.

We respectfully request that a written coverage position be provided within ten (10) business days of receipt of this letter.'),

('NJ', 'position_request', 'closing', 'We appreciate your prompt attention to this matter and remain available to provide any additional information or documentation needed to complete the coverage review.

Sincerely,
{{company_name}}
Public Adjuster for {{insured_name}}'),

-- NJ Supplement
('NJ', 'supplement', 'opening', '## Supplement Narrative — Additional Scope & Damages

**Re: Claim No. {{claim_number}} | Policy No. {{policy_number}}**
**Insured: {{insured_name}}**
**Property: {{property_address}}**
**Date of Loss: {{loss_date}}**

The following supplement documents additional damages and scope items identified during our post-inspection review that were not addressed in the carrier''s initial estimate.'),

('NJ', 'supplement', 'matching', 'New Jersey regulations (N.J.A.C. 11:2-17.7(d)) require that repairs achieve a uniform and consistent appearance. Where partial replacement of like-kind materials does not achieve uniformity with adjacent undamaged sections, the reasonable and customary scope must include contiguous areas necessary to maintain aesthetic consistency as expected under the policy''s replacement cost provisions.'),

('NJ', 'supplement', 'closing', 'We request the carrier issue a revised estimate and corresponding payment reflecting the documented supplemental scope. A joint re-inspection can be arranged at mutual convenience.

Respectfully,
{{company_name}}
Public Adjuster for {{insured_name}}'),

-- NJ Engineer Rebuttal
('NJ', 'engineer_rebuttal', 'opening', '## Rebuttal to Engineering Report

**Re: Claim No. {{claim_number}} | Policy No. {{policy_number}}**
**Insured: {{insured_name}}**
**Property: {{property_address}}**
**Date of Loss: {{loss_date}}**

The following responds to specific conclusions in the carrier-retained engineering report. Our position is supported by field observations, photographic documentation, and the established weather event record for the date of loss.'),

('NJ', 'engineer_rebuttal', 'engineer', 'The engineer''s conclusion attributing the observed damage to age-related deterioration does not adequately account for the documented severe weather event affecting the area on the date of loss. The damage pattern—including directional consistency, bruising at impact sites, and the spatial distribution across exposed surfaces—supports storm causation rather than the gradual wear mechanism cited.'),

('NJ', 'engineer_rebuttal', 'closing', 'We request a reconsideration of the engineering conclusions in view of the documented field evidence. We welcome a technical discussion or joint inspection to address any remaining questions.

Respectfully,
{{company_name}}
Public Adjuster for {{insured_name}}'),

-- NJ IA Rebuttal
('NJ', 'ia_rebuttal', 'opening', '## Response to Independent Adjuster Scope Assessment

**Re: Claim No. {{claim_number}} | Policy No. {{policy_number}}**
**Insured: {{insured_name}}**
**Property: {{property_address}}**
**Date of Loss: {{loss_date}}**

This letter addresses scope discrepancies between the independent adjuster''s assessment and field-verified conditions documented during our inspection.'),

('NJ', 'ia_rebuttal', 'scope', 'The following items were documented and photographed but omitted or under-scoped in the IA assessment:

{{scope_items}}

These items represent measurable, verifiable damages consistent with the covered peril. Under N.J.A.C. 11:2-17.7, the carrier''s obligation extends to the actual scope of covered damages, not solely those identified in a single assessment.'),

('NJ', 'ia_rebuttal', 'closing', 'We request a revised estimate incorporating the documented scope and are available for a joint re-inspection at your earliest convenience.

Respectfully,
{{company_name}}
Public Adjuster for {{insured_name}}');
