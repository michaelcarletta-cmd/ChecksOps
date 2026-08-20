WITH r AS (
  SELECT * FROM public.mortgage_handling_requests
  WHERE id = 'aa3d85f9-ebed-4100-acf6-34d73109539d'
)
INSERT INTO public.platform_fee_line_items (tenant_id, fee_code, description, quantity, unit_cents, amount_cents, claim_id, status, source_reference, metadata)
SELECT r.tenant_id, 'mortgage_handling',
  'Mortgage handling — ' || COALESCE(r.mortgage_company, r.mortgage_servicer, 'mortgage company'),
  1, COALESCE(r.flat_fee_cents, 1000), COALESCE(r.flat_fee_cents, 1000), r.claim_id, 'unbilled',
  'mortgage_handling:' || r.id::text, jsonb_build_object('request_id', r.id)
FROM r
ON CONFLICT (tenant_id, source_reference) WHERE source_reference IS NOT NULL DO NOTHING;

UPDATE public.mortgage_handling_requests
SET billing_status = 'billed', billed_at = COALESCE(billed_at, completed_at, now()), billing_error = NULL,
    flat_fee_cents = COALESCE(flat_fee_cents, 1000)
WHERE id = 'aa3d85f9-ebed-4100-acf6-34d73109539d';