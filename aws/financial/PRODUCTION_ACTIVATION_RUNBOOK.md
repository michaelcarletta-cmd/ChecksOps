# Production activation runbook

**DO NOT EXECUTE this runbook in this phase.**

It is a precise go/no-go sequence for a later, separately approved cutover. Provider sandbox validation (this PR) does not enable production providers, redirect production webhooks, change production DNS, deploy production frontend, or move money.

## Current go / no-go (after real-provider UAT validation)

**Re-evaluated after PR #100 merge (`1b7559de`) plus this UAT phase. Do not execute this runbook.**

A provider can remain **NO-GO** independently without weakening another provider.

| Gate | Status | Evidence |
| --- | --- | --- |
| Moov | **NO-GO** | Staging secret has no `MOOV_SANDBOX_*` values. Isolation stopped HTTP (`sandbox_keys_missing`). API version stays `v2024.01.00`. See `UAT_RESULTS.md`. |
| CheckAlt | **NO-GO** | Staging secret has no `CHECKALT_UAT_*` values. Isolation stopped HTTP (`uat_keys_missing`). Host allowlist is `https://uatapi.checkalt.com`. No negotiable check. |
| ChecksOps AWS overall | **NO-GO** | T1–T6 + PR #100 + this fail-closed UAT suite are green. Real provider ledgers are not proven. Production flags remain false. |
| Plaid sandbox on money path | **N/A / NO-GO for money** | Plaid Link is not the deposit→disburse path. |
| One ChecksOps op = one provider transaction (live HTTP) | **NO-GO** | Live provider object count is zero. Unit tests prove persist-before-HTTP recovery does not resubmit CheckAlt; Moov retries use the same `X-Idempotency-Key`. |
| Sandbox webhooks vs production records | **Partial** | Staging `/sandbox/webhooks/*` never mutate production ledgers. Production webhook URLs remain on Supabase. |
| Production flags | **HOLD** | `AWS_PROVIDER_EXECUTION_ENABLED=false`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`, all production `AWS_*_ENABLED` provider flags false. Only `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` may be true. |
| Production Moov/CheckAlt IDs in RDS | **HOLD** | Must not be overwritten. Isolation route refuses HTTP on ID overlap. |

Do not start the sequence below until every item in the **exact checklist** is GO.

## Exact go/no-go checklist (must all be GO)

Record the value at cutover time. Leave unchecked until a human fills it.

### Identity of the production AWS package

- [ ] Production AWS Lambda package SHA (`CodeSha256`) recorded: `________________`
- [ ] Staging certified SHA that was promoted: `________________`
- [ ] Git commit on `main` recorded: `________________`

### RDS reconciliation

- [ ] `aws/rls/sql/28_financial_aggregates.sql` AWS vs Supabase: zero unexplained drift
- [ ] `homeowner_ledger_amount` =
- [ ] `check_intake_amount` =
- [ ] `checkalt_deposits_amount` =
- [ ] `payment_transfers_amount_cents` =
- [ ] No unresolved `aws_financial_reconciliation_findings` that imply a duplicate provider object
- [ ] Production Moov/CheckAlt account IDs were **not** overwritten by sandbox IDs

### S3 reconciliation

- [ ] Staging vs production check-image inventory compared
- [ ] No unsigned/public production objects introduced by AWS

### Cognito identity reconciliation

- [ ] Every production user who must transact has `identity_accounts.application_user_id` mapped
- [ ] Cognito `sub` is never used as `auth.uid()` / application UUID
- [ ] Ninth-UUID / unmapped identity remains fail-closed

### Provider secret readiness

- [ ] Staging secret contains **only** `*_SANDBOX_*` keys (or is unused)
- [ ] Production secret contains **only** production keys on the production Lambda
- [ ] Moov sandbox HTTP was proven with sandbox keys before any production key is loaded on AWS
- [ ] CheckAlt: either a documented FinCapture UAT exists **or** CheckAlt stays disabled and cutover excludes deposits
- [ ] Webhook signing secrets are distinct per environment
- [ ] No secret values appear in logs, GitHub, or docs

### Moov account mappings

- [ ] Each production tenant `payment_provider_accounts.environment=production` mapping reviewed
- [ ] Sandbox object table is empty or clearly isolated (`aws_provider_sandbox_objects`)
- [ ] Facilitator / platform account ID for production is known and is not a sandbox ID
- [ ] Wallet and payment-method IDs match Moov production dashboard
- [ ] Real sandbox transfer (1 cent) was created, retrieved, replayed, and not duplicated

### CheckAlt configuration

- [ ] Production FinCapture `base_url` / merchant / FI key confirmed
- [ ] Integer-cents `userAmount` conversion certified (`123.45 → 12345`)
- [ ] If no sandbox: written exception that first production deposit is dual-controlled and abortable
- [ ] CheckAlt production flag stays false until that exception is signed

### Webhook activation order

1. [ ] Production webhooks still point at current Supabase URLs
2. [ ] AWS `/webhooks/{moov,checkalt,plaid}` deployed and signature-verified in dry-run
3. [ ] Tenant mapping from **provider account id**, payload `tenant_id` ignored
4. [ ] Duplicate event id does not mutate a second time
5. [ ] Dual-delivery (additional AWS subscriber) clean for a defined window
6. [ ] Only then remove Supabase URLs
7. [ ] Never flip DNS and webhooks in the same step

### Financial permission activation order

1. [ ] `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` still `false`
2. [ ] Named review of `deposit.submit`, `deposit.approve`, `disbursement.send`, `wallet.fund`, stakeholder pay
3. [ ] Confirm `has_permission()` CRUD is not treated as money authority
4. [ ] Set `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=true` only on production, after webhook dry-run

### Provider flag activation order

1. [ ] `AWS_PROVIDER_WEBHOOK_DRY_RUN=true` until dual-run is clean
2. [ ] `AWS_PROVIDER_LIVE_READS_ENABLED=true` (read-only)
3. [ ] `AWS_CHECKALT_ENABLED=true` only if CheckAlt exception is signed
4. [ ] `AWS_MOOV_ENABLED=true`
5. [ ] `AWS_PLAID_ENABLED` only if Link cutover is in scope (usually later)
6. [ ] `AWS_PROVIDER_EXECUTION_ENABLED=true` **last**, production only
7. [ ] Never set the production master flag to enable sandbox tests (`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` is staging-only)

### Frontend deployment order

1. [ ] AWS-backed frontend deployed to a non-production host
2. [ ] Browser cannot honor posted amounts / tenant IDs / user IDs
3. [ ] Auth is Cognito; `auth.uid()` is the application UUID
4. [ ] Production frontend still on Lovable/Supabase until DNS step

### DNS order

1. [ ] Frontend + API + webhooks independently healthy
2. [ ] Previous origin retained for rollback
3. [ ] DNS changed only after the above
4. [ ] **Not in this phase**

### Smoke transaction (production — later only)

- [ ] Not run in this phase
- [ ] First CheckAlt: sandbox/UAT or abort if none exists
- [ ] First Moov: already proven in sandbox; then one lowest-risk production ACH with dual control
- [ ] Watch idempotency key and webhook before a second transaction

### Monitoring

- [ ] CloudWatch Lambda errors / timeouts
- [ ] `aws_financial_audit` / `aws_provider_sandbox_audit` outcomes
- [ ] Reconciliation findings count
- [ ] Provider dashboard vs internal pending
- [ ] Financial aggregate drift

### Rollback thresholds (any one trips rollback)

- Unexpected production provider transaction
- Amount mismatch
- Duplicate provider transaction
- Webhook signature failures
- Identity mapping failures
- Financial aggregate drift
- Sandbox IDs written into production provider tables

### Rollback procedure

1. Set `AWS_PROVIDER_EXECUTION_ENABLED=false` immediately (no code deploy required).
2. Set all `AWS_*_ENABLED` provider flags `false`.
3. Set `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`.
4. Restore webhook URLs to the last known-good Supabase endpoints if they were changed.
5. Restore DNS to the last known-good frontend.
6. Leave ledgers intact; do not delete provider objects.
7. Reconcile and report; do not auto-correct.

## Preconditions (must all be true before anyone starts the sequence)

- Final human approval for money movement
- `AWS_PROVIDER_EXECUTION_ENABLED` still `false` until the last flag step
- Financial permissions still deactivated until the permission step
- Staging T1–T6 + sandbox fail-closed (or real sandbox HTTP) green
- Real Moov sandbox HTTP proven **or** an explicit signed waiver (not recommended)
- No unresolved reconciliation findings that imply duplicate provider risk

## Sequence (do not start while the checklist is NO-GO)

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

### 4–12

Follow the ordered checklist above (webhooks → permissions → provider flags → frontend → DNS → smoke → monitor → rollback).
