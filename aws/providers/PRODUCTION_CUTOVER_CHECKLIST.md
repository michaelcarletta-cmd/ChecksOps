# Production provider cutover checklist

**Do not execute this checklist in Tranche 4.** It only names what must be switched later, after an explicit production-cutover approval.

Production ChecksOps stays on Lovable/Supabase until every item below is planned, dual-run, and approved.

## Frontend / DNS

- [ ] Production DNS still points at Lovable (do not change)
- [ ] Production frontend still uses Supabase auth + `supabase.functions.invoke`
- [ ] AWS staging frontend (`VITE_AUTH_PROVIDER=cognito`) only
- [ ] After cutover: production frontend env → Cognito + AWS API Gateway base URL

## Secrets (create AWS copies; do not rotate production in place until dual-run is done)

| Secret | Staging now | Production later |
| --- | --- | --- |
| Moov public/secret keys + account id | `PROVIDER_SECRETS_ARN` | New production secret; never reuse staging webhook secret |
| Moov webhook signing secret | staging fixture or unused | New secret generated in Moov dashboard for the AWS URL |
| CheckAlt FI key / username / password | Secrets Manager | Production FinCapture credentials |
| CheckAlt webhook secret | staging fixture | New secret if CheckAlt supports signing |
| Plaid client id / secret / env | Secrets Manager | Production Plaid item; `PLAID_ENV=production` only after approval |
| Plaid webhook verification key | staging HMAC fixture | Official Plaid webhook verification |
| Actum username / password / parent id | Secrets Manager | Production Actum (if still in use) |
| QuickBooks client id / secret / redirect | Secrets Manager | Production QB app redirect → AWS |
| Resend / email provider (provider-event mail) | not wired | Separate cutover; not part of T4 |

## Webhook URLs (do not redirect now)

| Provider | Production today | Future AWS |
| --- | --- | --- |
| Moov | Supabase `moov-webhook` | `https://<prod-api>/webhooks/moov` |
| CheckAlt / FinCapture | existing deposit webhook (if any) + poll | `https://<prod-api>/webhooks/checkalt` |
| Plaid Transfer | Supabase `plaid-transfer-webhook` | `https://<prod-api>/webhooks/plaid` |
| Stripe tenant billing | `tenant-billing-webhook` | out of T4 scope |
| Resend | `resend-webhook` | out of T4 scope |

Required before flipping a URL:

1. AWS execution flags reviewed (still fail-closed until money movement is separately approved)
2. Dual-delivery or shadow mode validated
3. Idempotency proven against real event ids
4. Tenant mapping proven from provider account ids (never from payload tenant ids)
5. Production DNS/frontend still serving customers during shadow

## Edge Functions that must have an AWS replacement before disabling Supabase

All rows in `PROVIDER_INVENTORY.md` marked `disabled` plus the `db_status` / `webhook` rows. Highest risk last:

1. Status reads (already on AWS as local snapshots)
2. Webhook ingestion (AWS dry-run exists; apply-path not built)
3. KYC/TOS/recipient mutations in **provider sandbox**
4. Bank linking in sandbox
5. CheckAlt deposit submit in UAT
6. Moov/Plaid money movement (separate approval)

## Authorization that must be activated (not now)

See `aws/functions/api/provider-authz.mjs`:

- deposit.submit
- disbursement.execute
- ACH / RTP / wallet.transfer
- stakeholder.pay
- provider configuration (platform/tenant admin)

A valid tenant user must never automatically receive these.

## Financial go-live gates

- [ ] Zero unintended drift vs `28_financial_aggregates.sql`
- [ ] No live provider transaction in staging during readiness
- [ ] Sandbox-only Moov/CheckAlt/Plaid first
- [ ] Production webhook URLs unchanged until dual-run sign-off
- [ ] Rollback: set `AWS_PROVIDER_EXECUTION_ENABLED=false` and keep Supabase functions serving production

## Sandbox validation (current — NO-GO)

See `aws/financial/PROVIDER_SANDBOX_VALIDATION.md` and `aws/financial/PRODUCTION_ACTIVATION_RUNBOOK.md`.

- [ ] Moov `MOOV_SANDBOX_*` loaded on staging (not done)
- [ ] Real Moov sandbox HTTP: auth, 1-cent transfer, retrieve, idempotent retry (not done)
- [ ] CheckAlt dedicated FinCapture UAT (none available — production CheckAlt stays disabled)
- [ ] Plaid sandbox only if Link is in scope (not required for money movement; keys missing)
- [ ] Sandbox IDs isolated from production `payment_provider_accounts`
- [ ] Exact go/no-go checklist in the production runbook is all GO before cutover

