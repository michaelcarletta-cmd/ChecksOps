# Production cutover readiness matrix

**STOP FOR REVIEW.** This document is an audit. It is **not** authorization to cut over.

Prepared: 2026-09-05  
Base: `main` after PR #127 (`19f6c196`)  
Live verify: staging API `/health` 200, Lambda flags all production-execution **false**, both Lovable bridges still fail-closed, production DNS still Lovable.

Plaid is **N/A** (not used; keep `AWS_PLAID_ENABLED=false`).  
CheckAlt is **PARTIAL** and is handled in a separate chat (PR #125 / #130). This document does not modify those PRs.

| Area | Status | Evidence / remaining |
|---|---|---|
| Production → AWS DB migration rehearsal | **GO** | PR #127 isolated overlay `checksops_rehearsal_20260905` matched live production counts, critical PKs, `financial_stepup_log` 2/2, financial aggregates, identity, membership, FKs. Live `checksops` not overwritten. |
| Production → AWS storage migration/reconciliation | **GO** | PR #127 COPY 1,411/1,411 objects, 0 missing/failed/mismatched. 21 staging-only UAT objects left in place. Live S3 now **1,439** objects / 2,566,275,762 bytes (expected drift since rehearsal; final delta still required). |
| Remaining Supabase/Lovable runtime dependencies | **PARTIAL** | AWS staging (`VITE_AUTH_PROVIDER=cognito`) already proxies DB/storage/Class A (email, OCR/Textract, homeowner OTP, tenant admin, hire-mortgage-agent). Production SPA is still `.env.production` Supabase-only. Remaining AWS gaps: vendor e-sign, `ingest-shared-check`, Stripe/QuickBooks, money-movement (gated), realtime (polling stub). Production Lovable paths must stay until DNS cut. |
| Production frontend / API AWS configuration | **PARTIAL** | Staging API + CloudFront + Cognito exist. SAM `Environment` AllowedValues is **`staging` only**. `.env.production.aws.example` and `aws/cutover/production/*` are templates only — **not deployed**. |
| Cognito EMAIL_OTP / WebAuthn (staging) | **GO** | PR #126: CheckOps / WhiteLabel / MortgageOps / `/h/upload`. Pool `us-east-1_vPmQ7cL1F`, client allows `ALLOW_USER_AUTH`, MFA OFF, EMAIL_OTP preferred. |
| Cognito EMAIL_OTP / WebAuthn (production transition) | **PARTIAL** | **No production Cognito pool.** Staging pool must not be reused. Production passkeys (SimpleWebAuthn) are **not** migrated. Users EMAIL_OTP first, then re-enroll Cognito WebAuthn on `https://checksops.com`. SES From for production EMAIL_OTP not attached. |
| Tenant identity mapping + RLS / isolation | **PARTIAL** | Mapping `cognito_sub → identity_accounts.application_user_id → auth.uid()` proven on staging. Live DB bridge `identity_map` count **8**. Ninth UUID fail-closed (no email; do not invite). Production still uses Supabase RLS until API/DNS switch. Staging Cognito has 13 listed users (UAT extras). |
| CloudFront / DNS / API routing | **BLOCKED** (switch) | Staging: `staging.checksops.com` → CloudFront `E1CG52WRQZI7X1` / `d2p55gobpvrxya.cloudfront.net` (Deployed). Production apex/`www` still `185.158.133.1` (Lovable). API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`. Do not change Cloudflare apex/`www`. |
| Final DB delta via temporary DB bridge | **GO** (procedure) | Live `aws-staging-db-bridge` `health` HTTP 200, `mode:read_only`, writes/deletes/rpc/rawSql **false**. **Not executed** this PR. |
| Final storage delta via temporary storage bridge | **GO** (procedure) | Live `aws-staging-storage-bridge` `health` HTTP 200, `mode:sign_only`, deletes **false**, dbWrites **false**. **Not executed** this PR. |
| Production webhook transition | **PARTIAL** | AWS `/webhooks/{moov,checkalt}` exist; `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`. Production URLs still on Supabase. Dual-run **not started**. |
| Moov production transition | **PARTIAL** | Sandbox certification **PASS** (PR #124) including Lambda egress, $0.01 transfer, idempotent replay, signed webhook dry-run. Production `AWS_MOOV_ENABLED=false`. Production keys/IDs not loaded on AWS. Dual-run not started. |
| CheckAlt | **PARTIAL** | Separate chat. Production `AWS_CHECKALT_ENABLED=false`. Do not treat UAT IQA as a DNS-cut blocker if CheckAlt stays disabled **and** deposits remain on Lovable until a signed exception — usually unacceptable for a full cut. |
| Plaid | **N/A** | Not used. Missing keys are not a blocker. |
| Monitoring / CloudWatch / health checks | **PARTIAL** | `/health` 200, `/db-health` connected `checksops` / `transactionReadOnly=on`, Lambda X-Ray tracing Active. Agent role **cannot** `cloudwatch:DescribeAlarms` / `GetMetricStatistics`. No production alarm stack deployed. `/ops/readiness` is in this PR (404 on live Lambda until a later overlay). |
| Reconciliation immediately after cutover | **GO** (procedure) | Report-only SQL + `/financial/reconcile` (`autoCorrected=false`). See `POST_CUTOVER_RECONCILIATION.md`. |
| Rollback if AWS production validation fails | **GO** (procedure) | Points A/B/C in `ROLLBACK.md`. Dry-run script prints only. |
| Temporary bridge teardown (after successful cutover) | **GO** (procedure) | **Do not run now.** `BRIDGE_TEARDOWN.md` + dry-run script refuse `--apply`. |
| Financial activation / `64_financial_activation_grants.sql` | **GO (hold)** | Stub returns `NOT_APPLIED`. CI refuses auto-apply. `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`. **BLOCKED** to apply until human approval. |
| Production execution / provider flags | **GO (hold)** | Live Lambda: all listed execution flags **false**; sandbox execution **true**; webhook dry-run **true**. |
| ChecksOps AWS overall for **executing** production cutover | **BLOCKED** | Data/storage rehearsal GO does **not** authorize DNS, auth, webhook, Moov, CheckAlt, or financial activation. |

## Live snapshot (2026-09-05, no mutations)

| Item | Value |
|---|---|
| API `/health` | 200, `environment=staging`, `productionSupabaseChanged=false` |
| API `/db-health` | `currentDatabase=checksops`, `currentUser=checksops`, `transactionReadOnly=on`, PostgreSQL 18.3 |
| Lambda | `checksops-staging-api`, account `806168576068`, arm64, nodejs22.x, VPC attached |
| Flags false | `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_PROVIDER_LIVE_READS_ENABLED` |
| Flags true (allowed) | `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED`, `AWS_PROVIDER_WEBHOOK_DRY_RUN` |
| Staging CloudFront | `E1CG52WRQZI7X1` Deployed, alias `staging.checksops.com` |
| Production DNS | apex + `www` → `185.158.133.1` (unchanged) |
| Cognito staging users listed | 13 (12 enabled) — UAT extras vs 8 production identity_map rows |
| CFN | `checksops-staging` UPDATE_COMPLETE; `checksops-staging-frontend-https` UPDATE_COMPLETE |

## Remaining blockers before any production cutover

Must be GO or waived in writing:

1. Human approval to leave Lovable/Supabase as system of record.
2. Production Cognito user pool + app client (not `us-east-1_vPmQ7cL1F`) with EMAIL_OTP + WEB_AUTHN, RP ID `checksops.com`, SES delivery.
3. Identity import of every production user who must sign in (`sub ≠ application UUID`).
4. Passkey re-enrollment communication (SimpleWebAuthn credentials are not migrated).
5. Production frontend env + deploy (Cognito + production API URL). `.env.production` stays Supabase until then.
6. Production API stack (separate from staging), secrets production-only, flags still **false**.
7. Final write-freeze + bridge DB overlay + storage COPY + recon PASS.
8. Cognito identity delta for users created after the last overlay.
9. Moov production keys/IDs + webhook dual-run (sandbox PASS ≠ production GO).
10. CheckAlt GO **or** signed exception that deposits stay off AWS at DNS cut.
11. `64_financial_activation_grants.sql` only after webhook dry-run + named review — not this PR.
12. TOTP/step-up: accept EMAIL_OTP/WebAuthn-only at DNS cut **or** provision later. Do not treat stub MFA as money authority.
13. Workflow gaps: e-sign / ingest-shared-check / Stripe / QuickBooks — port, fail-closed, or dual-run Edge Function.
14. Realtime: accept 15s polling or add a later design.
15. Timed write-freeze drill (never measured). Budget ~45–110 min pre-DNS from rehearsal.
16. Production CloudWatch alarms + operator access (example YAML in this PR; not deployed).
17. Production ACM cert + CloudFront for apex/`www` (example YAML; not deployed; DNS still Lovable).

Non-blockers: Plaid; ninth UUID (fail-closed orphan); `profiles.preferred_auth_method`; staging-only S3 extras; Moov sandbox PASS.

## Related open PRs (do not merge from this chat)

| PR | Topic | This chat |
|---|---|---|
| #125 / #130 | CheckAlt UAT / architecture A | **Do not modify** |
| #128 / #129 | Earlier cutover-prep drafts | Superseded for the matrix/runbooks by this PR; do not merge those instead of reviewing this one |
