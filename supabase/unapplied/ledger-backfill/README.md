# Ledger backfill (UNAPPLIED)

Do not run these scripts against production from this PR.

No live writes. No provider calls. No status, signature, payment, or disbursement changes beyond the documented claim-link rows.

Counts must be discovered at execution time. Do not hardcode the 2026-09-18 preflight numbers (39 / 107 / 86).

## Future controlled-apply order

1. `supabase/migrations/20260918170010_guard_check_claim_tenant.sql`
2. `supabase/migrations/20260918170020_verify_claim_payments_check_intake_index.sql`
3. `supabase/migrations/20260918170030_one_check_received_per_check.sql`
4. `supabase/unapplied/ledger-backfill/01_inspect.sql` (read-only)
5. `supabase/unapplied/ledger-backfill/02_apply.sql` (controlled; stop on anomalies)
6. `supabase/migrations/20260918170100_sync_check_claim_ledger.sql`
7. Re-run inspect; expect zero missing rows and zero anomalies

`20260918170000_review_void_deposit_path.sql` is a separate Wave 1 review track and is not part of this ledger order.
