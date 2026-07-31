UPDATE public.check_endorsements
SET status = 'waived',
    signature_method = 'manual',
    signature_image_url = NULL,
    updated_at = now()
WHERE id = 'd86781af-0842-45f2-a870-6d28927924f9';

UPDATE public.check_payees
SET endorsement_image_path = NULL,
    updated_at = now()
WHERE id = '0689807e-46ab-427b-bc78-b8ca553a935b';