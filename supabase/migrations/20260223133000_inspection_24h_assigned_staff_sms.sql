-- Default automation: remind assigned staff 24 hours before inspection by SMS.
INSERT INTO public.automations (
  name,
  description,
  trigger_type,
  trigger_config,
  actions,
  conditions,
  is_active
)
SELECT
  'Inspection 24h Reminder to Assigned Staff',
  'Automatically sends a text reminder to assigned claim staff when an inspection is within 24 hours so they can cancel or reschedule if needed.',
  'inspection_upcoming_24h',
  jsonb_build_object(
    'hours_before', 24
  ),
  jsonb_build_array(
    jsonb_build_object(
      'type', 'send_sms',
      'config', jsonb_build_object(
        'recipient_type', 'claim_staff',
        'message', 'Inspection reminder: Claim {claim.claim_number} has an inspection on {inspection.date} at {inspection.time}. If needed, please cancel or reschedule now.'
      )
    )
  ),
  '{}'::jsonb,
  true
WHERE NOT EXISTS (
  SELECT 1
  FROM public.automations
  WHERE trigger_type = 'inspection_upcoming_24h'
    AND name = 'Inspection 24h Reminder to Assigned Staff'
);
