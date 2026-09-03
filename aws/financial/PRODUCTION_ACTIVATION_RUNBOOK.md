# Production activation runbook

**DO NOT EXECUTE this runbook in this phase.**

It is a precise sequence for a later, separately approved cutover. This PR does not enable production providers, redirect production webhooks, change production DNS, or move money.

## Preconditions (must all be true before anyone starts)

- Final human approval for money movement
- `AWS_PROVIDER_EXECUTION_ENABLED` still `false` until step 5
- Financial permissions still deactivated until tested in production-like sandbox
- Staging certification green, including T1–T5 regression
- No unresolved reconciliation findings that imply duplicate provider risk

## Sequence

### 1. Final database backup

- RDS snapshot of production (or the database that will become production).
- Confirm snapshot ID and restore test.

### 2. Final Supabase → AWS delta reconciliation

- Re-run financial aggregates (`aws/rls/sql/28_financial_aggregates.sql`) on both sides.
- Diff `check_intake_items`, `checkalt_deposits`, `payment_transfers`, disbursement tables, `homeowner_ledger_events`.
- Do not proceed on amount drift.

### 3. Provider secret validation

- Confirm Secrets Manager entries are **production** credentials only on the production Lambda, and **sandbox** credentials only on staging.
- Rotate any secret that was ever used for a test in the wrong environment.
- Verify webhook secrets are distinct.

### 4. Webhook endpoint activation order

1. Keep production webhooks on current Supabase URLs.
2. Deploy AWS webhook routes and prove signature + idempotency in dry-run.
3. Add AWS URLs as **additional** subscribers if the provider allows dual delivery.
4. Only then remove Supabase URLs.
5. Never flip DNS and webhooks in the same step.

### 5. Provider execution flag order

1. `AWS_PROVIDER_WEBHOOK_DRY_RUN=true` remains until webhook dual-run is clean.
2. `AWS_PROVIDER_LIVE_READS_ENABLED=true` (read-only GETs) for readiness.
3. `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=true` only after a named permission review.
4. Per-provider flags one at a time: CheckAlt, then Moov, then Plaid. Actum/QuickBooks last if ever.
5. `AWS_PROVIDER_EXECUTION_ENABLED=true` last, on production only, with a change window.

### 6. Frontend deployment

- Deploy the AWS-backed frontend that calls the certified routes.
- Confirm it cannot post amounts/tenant IDs that the server will honor.

### 7. DNS change

- After frontend + API + webhooks are healthy.
- Keep the previous origin ready for rollback.
- Do not change DNS in this phase.

### 8. Smoke transaction strategy

- First CheckAlt deposit: **sandbox or a $0.01–controlled test instrument if the provider documents it as non-production**. If no safe instrument exists, stop.
- First Moov transfer: sandbox only, then a single lowest-risk production ACH with dual-control.
- Watch idempotency keys and webhook confirmations before a second transaction.

### 9. Monitoring

- CloudWatch Lambda errors / timeouts
- `aws_financial_audit` outcomes
- Reconciliation findings count
- Provider dashboard vs internal pending
- Financial aggregates drift

### 10. Rollback triggers

- Any unexpected production provider transaction
- Amount mismatch
- Duplicate provider transaction
- Webhook signature failures
- Identity mapping failures
- Financial aggregate drift

### 11. Rollback procedure

1. Set `AWS_PROVIDER_EXECUTION_ENABLED=false` immediately (no code deploy required).
2. Set all `AWS_*_ENABLED` provider flags `false`.
3. Set `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`.
4. Restore webhook URLs to the last known-good Supabase endpoints if they were changed.
5. Restore DNS to the last known-good frontend.
6. Leave ledgers intact; do not delete provider objects.
7. Reconcile and report; do not auto-correct.

### 12. Post-cutover reconciliation

- Run internal vs provider comparison for every transaction since cutover.
- Confirm no unknown provider transactions.
- Confirm no internal-succeeded / provider-missing rows without a documented reason.
