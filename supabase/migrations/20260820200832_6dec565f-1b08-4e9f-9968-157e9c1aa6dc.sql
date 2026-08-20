update public.checkalt_deposits
set status = 'rejected',
    returned_at = now(),
    reject_code = 1721,
    reject_notes = 'Duplicate submission of check #0121279083 ($742.46); provider reports transaction 119611626 not present. Cancelled by ops.',
    updated_at = now()
where id = 'be786b94-5b29-47a4-813a-b6de24fbb506';