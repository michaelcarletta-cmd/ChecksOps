# Claim-link diagnostics (UNAPPLIED)

Read-only. Do not run against production from this PR.

`01_inspect.sql` is diagnostic only. There is no apply script in this phase.

ClaimLedgerCard Funds Received is `SUM(check_intake_items.amount)` for the linked claim. Missing `claim_payments` / `claim_checks` are not missing Funds Received.

Do not apply the numbered migrations in `supabase/migrations/` from this PR.
