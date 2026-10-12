-- Let the API correct a check's amount while the check is in Review.
-- The API applies the change only when status is uploaded, needs_review,
-- ocr_complete or manual_review_required (write-check-workflow.mjs), in the
-- same UPDATE. routing_number and account_number were granted by SQL 52.
GRANT UPDATE (amount) ON TABLE public.check_intake_items TO checksops;
