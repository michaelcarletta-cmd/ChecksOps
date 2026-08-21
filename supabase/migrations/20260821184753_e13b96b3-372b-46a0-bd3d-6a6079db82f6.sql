update public.check_intake_items
set check_stage = 'ready_for_deposit',
    status = 'approved_for_deposit',
    deposited_at = null,
    updated_at = now()
where id = '400d7023-cac7-45c2-8310-60f6a07e974b';