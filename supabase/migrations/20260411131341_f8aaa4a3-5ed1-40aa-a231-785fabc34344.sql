UPDATE public.inspections
SET inspection_time = '12:16:00',
    inspection_type = COALESCE(inspection_type, 'General'),
    inspector_name = COALESCE(inspector_name, 'Test'),
    updated_at = now()
WHERE id = '1ec372df-959e-455d-b754-38527191f68d';

INSERT INTO public.jobnimbus_sync_queue (claim_id, sync_type, status, payload, contractor_id)
VALUES (
  '2f2061ae-3a6a-4c54-8cad-0042d0824349',
  'inspection',
  'pending',
  jsonb_build_object(
    'data',
    jsonb_build_object(
      'inspection_id', '1ec372df-959e-455d-b754-38527191f68d',
      'inspection_date', '2026-04-13',
      'inspection_time', '12:16:00',
      'inspection_type', 'General',
      'inspector_name', 'Test',
      'status', 'scheduled',
      'notes', null
    )
  ),
  null
);