-- A5-201–204: persist claim coverage figures (RCV/ACV/depreciation).
-- Does not GRANT payments, disbursements, wallets, or claim_id retarget on
-- check_intake_items. Application allowlist still rejects negatives and
-- requires tenant membership via claims.org_id or a linked check.

GRANT SELECT ON TABLE public.claim_settlements TO checksops, authenticated;

GRANT INSERT (
  claim_id,
  created_by,
  replacement_cost_value,
  recoverable_depreciation,
  non_recoverable_depreciation,
  deductible,
  other_structures_rcv,
  other_structures_recoverable_depreciation,
  other_structures_non_recoverable_depreciation,
  other_structures_deductible,
  pwi_rcv,
  pwi_recoverable_depreciation,
  pwi_non_recoverable_depreciation,
  personal_property_rcv,
  personal_property_recoverable_depreciation,
  personal_property_non_recoverable_depreciation,
  ale_rcv,
  ale_recoverable_depreciation,
  ale_non_recoverable_depreciation,
  estimate_amount,
  pa_estimate_amount,
  prior_offer,
  notes
) ON TABLE public.claim_settlements TO checksops, authenticated;

GRANT UPDATE (
  replacement_cost_value,
  recoverable_depreciation,
  non_recoverable_depreciation,
  deductible,
  other_structures_rcv,
  other_structures_recoverable_depreciation,
  other_structures_non_recoverable_depreciation,
  other_structures_deductible,
  pwi_rcv,
  pwi_recoverable_depreciation,
  pwi_non_recoverable_depreciation,
  personal_property_rcv,
  personal_property_recoverable_depreciation,
  personal_property_non_recoverable_depreciation,
  ale_rcv,
  ale_recoverable_depreciation,
  ale_non_recoverable_depreciation,
  estimate_amount,
  pa_estimate_amount,
  prior_offer,
  notes,
  updated_at
) ON TABLE public.claim_settlements TO checksops, authenticated;
