# Cutover night operator checklist (fill on the night)

**This checklist is not authorization to cut over.** Copy to an incident doc; do not commit filled PII.

Date: __________  Approver: __________  Git SHA: __________

## Safety (must all be YES before T0)

- [ ] Production DNS still Lovable (`checksops.com` / `www` not CloudFront)
- [ ] Production Moov/CheckAlt webhooks still on Supabase
- [ ] `AWS_PROVIDER_EXECUTION_ENABLED=false`
- [ ] `AWS_MOOV_ENABLED=false`
- [ ] `AWS_CHECKALT_ENABLED=false`
- [ ] `AWS_PLAID_ENABLED=false` (Plaid is not required)
- [ ] `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- [ ] `64_financial_activation_grants.sql` not applied
- [ ] DB + Storage Lovable bridges still deployed and read-only / COPY-only
- [ ] CheckAlt production plan signed (GO from separate chat **or** stay disabled)
- [ ] Production Cognito pool is **not** `us-east-1_vPmQ7cL1F`

## T0 write-freeze

- [ ] Freeze announced
- [ ] Freeze enabled
- [ ] T0 financial aggregates captured (no PII in Git)
- [ ] Previous DNS targets recorded

## T1 DB delta

- [ ] Bridge `health` `mode:read_only`
- [ ] Overlay SHA-256 __________
- [ ] Rehearsal DB name __________
- [ ] Counts / PK / financial / identity / FK / null / `financial_stepup_log` PASS

## T2 storage delta

- [ ] Object count __________
- [ ] Bytes __________
- [ ] Missing/failed/mismatched = 0

## T3 identity

- [ ] Mapped users (count only) __________
- [ ] No `cognito_sub === application_user_id`
- [ ] Ninth UUID not invited

## T4–T8

Follow `FINAL_PRODUCTION_CUTOVER_RUNBOOK.md`. Stop and roll back on any tripwire.

## After success only

- [ ] Dual-run then webhook cut (`WEBHOOK_TRANSITION.md`)
- [ ] Post-cutover recon (`POST_CUTOVER_RECONCILIATION.md`)
- [ ] Bridge teardown (`BRIDGE_TEARDOWN.md`) — **not** during a failed cutover

## Rollback (if needed)

Point used: A (pre-DNS) / B (post-DNS flags OFF) / C (flags ON)

Actions taken: __________
