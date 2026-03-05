
-- Carrier argument rebuttals: per-claim detected arguments with structured rebuttals
CREATE TABLE public.carrier_argument_rebuttals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  argument_type TEXT NOT NULL, -- e.g. 'warranty_language_misuse', 'granule_loss_cosmetic', 'wear_and_tear', 'no_direct_physical_loss', 'maintenance'
  carrier_position TEXT NOT NULL,
  
  -- Structured evidence fields
  warranty_scope TEXT,
  damage_mechanism TEXT,
  loss_trigger TEXT,
  exclusion_invoked TEXT,
  storm_date TEXT,
  collateral_hits TEXT,
  pattern_notes TEXT,
  expert_support TEXT,
  
  -- Rebuttal output
  principle TEXT NOT NULL,
  why_different TEXT NOT NULL,
  what_proves_damage TEXT NOT NULL,
  documentation_checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  carrier_ready_paragraph TEXT NOT NULL,
  
  -- Citations
  citations JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{file_name, snippet, needs_review}]
  
  -- Source tracking
  source_file_id UUID REFERENCES public.claim_files(id) ON DELETE SET NULL,
  source_file_name TEXT,
  confidence NUMERIC(3,2) DEFAULT 0.5,
  needs_review BOOLEAN DEFAULT false,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reusable playbook cards: argument_type + rebuttal template reusable across claims
CREATE TABLE public.rebuttal_playbook_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  argument_type TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  principle TEXT NOT NULL,
  why_different TEXT NOT NULL,
  what_proves_damage TEXT NOT NULL,
  documentation_checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  carrier_ready_template TEXT NOT NULL,
  usage_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.carrier_argument_rebuttals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rebuttal_playbook_cards ENABLE ROW LEVEL SECURITY;

-- Staff/admin can CRUD on both
CREATE POLICY "Staff can manage carrier argument rebuttals" ON public.carrier_argument_rebuttals
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

CREATE POLICY "Staff can manage rebuttal playbook cards" ON public.rebuttal_playbook_cards
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

-- Index for fast lookups
CREATE INDEX idx_carrier_argument_rebuttals_claim_id ON public.carrier_argument_rebuttals(claim_id);
CREATE INDEX idx_carrier_argument_rebuttals_type ON public.carrier_argument_rebuttals(argument_type);

-- Seed common playbook cards
INSERT INTO public.rebuttal_playbook_cards (argument_type, display_name, principle, why_different, what_proves_damage, documentation_checklist, carrier_ready_template) VALUES
('warranty_language_misuse', 'Manufacturer Warranty Misuse', 
 'Manufacturer warranty ≠ insurance coverage standard',
 'A warranty addresses manufacturing defects and remedies; an insurance claim addresses storm-caused physical damage. These are entirely separate legal and contractual frameworks.',
 'Mat fracture, bruising, exposed asphalt, UV protection loss + hail impact pattern + collateral damage on soft metals/vents + storm date tie-in',
 '["Test squares with chalk lines","Slope mapping showing directional pattern","Soft metal damage photos (vents, flashing, gutters)","Close-up photos of mat fracture/bruising","Weather reports for storm date","Expert/engineer report if available"]'::jsonb,
 'We are not making a manufacturer warranty claim. The insured''s claim is based on direct physical loss caused by hail impact, which is a covered peril under the policy. The manufacturer''s warranty addresses product defects — not storm damage. The physical evidence demonstrates functional damage to the roofing system that reduces its ability to shed water and protect the structure, regardless of any warranty provisions.'),

('granule_loss_cosmetic', 'Granule Loss / Cosmetic Damage', 
 'Functional damage ≠ cosmetic damage',
 'Granule displacement from hail impact exposes the asphalt mat to UV degradation, accelerating material failure. This is functional damage that shortens the roof''s serviceable life.',
 'Exposed asphalt mat under displaced granules, UV degradation evidence, mat fracture/bruising at impact sites, accelerated aging patterns, hail pattern consistency across slopes',
 '["Photos showing exposed asphalt at impact points","Test square documentation","Comparison of protected vs exposed areas","Manufacturer data on granule function","Expert assessment of remaining service life","Storm data correlation"]'::jsonb,
 'The carrier''s characterization of hail damage as merely ''cosmetic granule loss'' misrepresents the damage mechanism. Hail impacts displace granules and fracture the underlying asphalt mat, compromising the shingle''s primary waterproofing function. This constitutes direct physical loss that materially reduces the roof''s ability to perform its intended function of shedding water and protecting the structure.'),

('wear_and_tear', 'Wear and Tear Exclusion', 
 'Storm damage is not wear and tear — covered peril preempts exclusion',
 'Wear and tear is a gradual, predictable deterioration. Storm damage is sudden, accidental physical loss from a covered peril. The carrier must prove the damage is NOT from the claimed peril before invoking this exclusion.',
 'Impact marks consistent with hail size/pattern, directional damage matching storm path, collateral damage to other materials, absence of pre-existing damage in same pattern, storm date correlation',
 '["Before/after comparison if available","Hail impact pattern documentation","Collateral damage to soft metals, screens, etc.","Weather data for claimed storm event","Age and condition of materials pre-storm","Expert opinion differentiating storm vs aging"]'::jsonb,
 'The wear and tear exclusion does not apply to sudden, accidental damage from a covered peril. The physical evidence demonstrates a clear hail impact pattern that is inconsistent with normal aging or gradual deterioration. The carrier bears the burden of proving this exclusion applies, and the documented evidence establishes that the damage resulted from the claimed storm event.'),

('no_direct_physical_loss', 'No Direct Physical Loss', 
 'Direct physical loss includes any alteration that impairs function or value',
 'Modern insurance law broadly interprets ''direct physical loss'' to include any physical alteration to property that diminishes its function, integrity, or value — not limited to visible structural destruction.',
 'Measurable reduction in waterproofing capability, compromised structural integrity of roofing system, physical alteration of material properties at impact sites, documented functional impairment',
 '["Documented physical alterations at impact sites","Functional testing results (water testing, etc.)","Material property changes (bruising, fracture, deformation)","Quantified reduction in remaining service life","Expert assessment of functional impairment","Comparison to undamaged reference areas"]'::jsonb,
 'The evidence demonstrates direct physical loss to the insured property. The hail impacts have physically altered the roofing materials, compromising their waterproofing function and structural integrity. This constitutes direct physical loss under the policy — the materials have been physically changed in a way that impairs their ability to perform their intended function.'),

('maintenance', 'Maintenance / Pre-Existing Condition', 
 'Pre-existing condition does not negate covered peril damage',
 'Even if maintenance issues exist, the carrier must cover damage caused by the covered peril. The policy covers the peril, not the condition of the property. Concurrent causation applies where storm damage and pre-existing conditions coexist.',
 'Storm-specific damage patterns distinct from maintenance issues, temporal correlation with storm event, damage in areas not affected by maintenance issues, separate and distinct damage mechanisms',
 '["Photos distinguishing storm damage from maintenance issues","Timeline showing damage appeared after storm event","Expert opinion separating peril damage from pre-existing conditions","Documentation of which damages are storm-related vs pre-existing","Storm data and weather reports","Scope separating covered vs non-covered repairs"]'::jsonb,
 'While pre-existing conditions may exist on the property, the carrier''s obligation to cover storm damage remains. The policy insures against covered perils, not the condition of the property. The documented evidence clearly distinguishes between pre-existing maintenance conditions and the new damage caused by the claimed storm event. The carrier must provide coverage for the peril-related damage regardless of pre-existing conditions.')
ON CONFLICT (argument_type) DO NOTHING;
