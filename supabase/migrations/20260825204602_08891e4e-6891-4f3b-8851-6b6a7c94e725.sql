-- Remove duplicate mortgage_handling billing rows (keep earliest) so the unique index can be created
DELETE FROM public.check_billing_events a
USING public.check_billing_events b
WHERE a.event_type = 'mortgage_handling'
  AND b.event_type = 'mortgage_handling'
  AND a.tenant_id = b.tenant_id
  AND a.check_intake_item_id IS NOT NULL
  AND a.check_intake_item_id = b.check_intake_item_id
  AND a.id > b.id;

-- Add the uniqueness rule the trigger's ON CONFLICT clause expects
CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_tenant_check_event_uniq
ON public.check_billing_events (tenant_id, check_intake_item_id, event_type)
WHERE check_intake_item_id IS NOT NULL;