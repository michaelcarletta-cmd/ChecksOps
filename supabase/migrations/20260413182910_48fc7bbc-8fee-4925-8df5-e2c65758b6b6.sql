DELETE FROM public.darwin_estimate_lines
WHERE claim_id = '38b34816-2e33-424f-9891-4172133e5bc1'
  AND rationale = 'Imported from BERNARD_FRANCIS_ABBREVIATED_CAR.pdf'
  AND source IN ('carrier_import', 'estimate_import');