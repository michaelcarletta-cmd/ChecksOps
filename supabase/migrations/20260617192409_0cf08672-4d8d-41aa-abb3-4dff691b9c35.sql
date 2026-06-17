UPDATE public.check_intake_items
SET back_image_path = 'checks/62c637b1-56b6-456f-9bc6-9677daa364a9/back-1781555859332.jpg',
    updated_at = now()
WHERE id = '62c637b1-56b6-456f-9bc6-9677daa364a9';

INSERT INTO public.check_audit_log (check_id, event_type, event_description, event_data)
VALUES (
  '62c637b1-56b6-456f-9bc6-9677daa364a9',
  'back_image_restored_to_original',
  'Restored original back image so the full check is visible. SVG composite remains on disk and will be regenerated as PNG on the next endorsement event.',
  jsonb_build_object(
    'previous_back_image_path', 'checks/62c637b1-56b6-456f-9bc6-9677daa364a9/back-1781555859332_endorsed_1781723968804.svg',
    'restored_back_image_path', 'checks/62c637b1-56b6-456f-9bc6-9677daa364a9/back-1781555859332.jpg',
    'reason', 'svg_composite_not_rendering_in_browser'
  )
);