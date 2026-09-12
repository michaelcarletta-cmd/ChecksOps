-- CC-047: allow tenant reviewers to persist detected_claim_number metadata.
-- Does not GRANT claim_id (auto-link trigger cannot fabricate a claim attachment).
-- Does not GRANT amount, status, check_stage, deposit, routing, or provider columns.

GRANT UPDATE (detected_claim_number)
  ON TABLE public.check_intake_items
  TO checksops, authenticated;
