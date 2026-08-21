update public.check_intake_items
set partner_status = 'approved_for_deposit',
    partner_status_label = 'Ready for Deposit',
    partner_status_updated_at = now(),
    updated_at = now()
where id = '400d7023-cac7-45c2-8310-60f6a07e974b';