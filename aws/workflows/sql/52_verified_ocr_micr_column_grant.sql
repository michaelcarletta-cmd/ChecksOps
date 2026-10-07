-- Allow the OCR handler to persist only Azure-verified MICR fields.
-- Generic /data/write continues to reject both columns; RLS remains enabled.
GRANT UPDATE (routing_number, account_number)
ON TABLE public.check_intake_items TO checksops;
