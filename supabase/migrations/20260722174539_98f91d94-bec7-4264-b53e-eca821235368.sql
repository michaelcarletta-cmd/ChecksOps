UPDATE public.checkalt_deposits
SET status = 'error',
    last_status_payload = jsonb_build_object('reaped', true, 'reason', 'edge_worker_cpu_exceeded')
WHERE id IN ('a6257446-9d6a-4a93-a29f-7c7b711aacd9','fbcf0429-7723-4fad-b1f9-6874d070f7a3');

UPDATE public.check_intake_items
SET check_stage = 'ready_for_deposit',
    status = 'approved_for_deposit'
WHERE id IN ('32895d43-bc20-42ef-9f26-64257b7137a2','1ff0a2e2-8432-4664-b969-44387488acb7');