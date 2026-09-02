-- Financial aggregates used to prove ENABLE ROW LEVEL SECURITY did not change restored data.
-- Run as table owner / checksops_admin so RLS does not hide rows. Do not run as checksops.

SELECT 'check_intake_amount' AS metric, coalesce(sum(amount), 0) AS value
FROM public.check_intake_items
UNION ALL
SELECT 'check_intake_pa_fee_amount', coalesce(sum(pa_fee_amount), 0)
FROM public.check_intake_items
UNION ALL
SELECT 'deposit_items_amount', coalesce(sum(amount), 0)
FROM public.deposit_items
UNION ALL
SELECT 'deposit_batches_total_amount', coalesce(sum(total_amount), 0)
FROM public.deposit_batches
UNION ALL
SELECT 'checkalt_deposits_amount', coalesce(sum(amount), 0)
FROM public.checkalt_deposits
UNION ALL
SELECT 'disbursement_splits_amount', coalesce(sum(amount), 0)
FROM public.disbursement_splits
UNION ALL
SELECT 'disbursement_batches_check_amount', coalesce(sum(check_amount), 0)
FROM public.disbursement_batches
UNION ALL
SELECT 'disbursement_batches_amount_reserved_cents', coalesce(sum(amount_reserved_cents), 0)
FROM public.disbursement_batches
UNION ALL
SELECT 'claim_check_payments_check_amount', coalesce(sum(check_amount), 0)
FROM public.claim_check_payments
UNION ALL
SELECT 'claim_check_payments_payment_amount', coalesce(sum(payment_amount), 0)
FROM public.claim_check_payments
UNION ALL
SELECT 'endorsed_check_intake_amount', coalesce(sum(i.amount), 0)
FROM public.check_endorsements e
JOIN public.check_intake_items i ON i.id = e.check_id
UNION ALL
SELECT 'payment_transfers_amount_cents', coalesce(sum(amount_cents), 0)
FROM public.payment_transfers
UNION ALL
SELECT 'payment_wallet_ledger_amount_cents', coalesce(sum(amount_cents), 0)
FROM public.payment_wallet_ledger
UNION ALL
SELECT 'claim_payments_amount', coalesce(sum(amount), 0)
FROM public.claim_payments
UNION ALL
SELECT 'homeowner_ledger_amount', coalesce(sum(amount), 0)
FROM public.homeowner_ledger_events
ORDER BY metric;
