# Production cutover readiness matrix

**STOP FOR REVIEW.** This document is an audit. It is **not** authorization to cut over.

Prepared: 2026-09-06 (prep Steps 1–5D + SES EMAIL_OTP 6B **READY**; **STOP FOR REVIEW**)  
Base: current `main` `8a9181ae` (PR #132 merged) plus this prep PR live objects  
Live verify: staging + prep `/health` 200, production-execution flags **false**, bridges still deployed (fail-closed 401 without token), production DNS still Lovable. Cutover **not** executed.

Plaid is **N/A** (not used; keep `AWS_PLAID_ENABLED=false`).  
CheckAlt is **PARTIAL** and is handled in a separate chat (PR #125 / #130). This document does not modify those PRs.

| Area | Status | Evidence / remaining |
|---|---|---|
| Production → AWS DB migration rehearsal | **GO** | PR #127 isolated overlay `checksops_rehearsal_20260905` matched live production counts, critical PKs, `financial_stepup_log` 2/2, financial aggregates, identity, membership, FKs. Live `checksops` not overwritten. |
| Production → AWS storage migration/reconciliation | **GO** | PR #127 COPY 1,411/1,411 objects, 0 missing/failed/mismatched. 21 staging-only UAT objects left in place. Live S3 now **1,439** objects / 2,566,275,762 bytes (expected drift since rehearsal; final delta still required). |
| Remaining Supabase/Lovable runtime dependencies | **PARTIAL** | AWS staging (`VITE_AUTH_PROVIDER=cognito`) already proxies DB/storage/Class A. Production SPA is still `.env.production` Supabase-only. Draft PR #132 ports vendor e-sign / ingest (not merged here). Stripe/QuickBooks stay fail-closed. Realtime still polling. |
| Production frontend / API AWS configuration | **GO (prepared, not switched)** | SPA: CloudFront `E1B0ZWWO5559U5` placeholder, aliases **0**. API: `checksops-production-prep-api`, `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` `/health` 200, `environment=production-prep`, all execution flags **false**, no VPC/RDS. Lambda role and CFN `ExistingExecutionRoleArn` both **`checksops-production-prep-api-role`** (`UPDATE_COMPLETE`). `.env.production` stays Supabase. Do not overlay `checksops-staging-api`. Do not point DNS at this API. |
| Cognito EMAIL_OTP / WebAuthn (staging) | **GO** | PR #126. Pool `us-east-1_vPmQ7cL1F`, `ALLOW_USER_AUTH`, MFA OFF, EMAIL_OTP preferred, WebAuthn RP `staging.checksops.com`. |
| Cognito EMAIL_OTP / WebAuthn (production transition) | **GO (prepared, not switched)** | Pool `us-east-1_h00WorYMT`, 0 users, EMAIL_OTP+PASSWORD+WEB_AUTHN, MFA OFF, deletion protection ACTIVE, client `3ja9fqaq2fjkv3i6up2varcqpe`, WebAuthn RP ID `checksops.com`, email **`DEVELOPER`** / SES `support@checksops.com`. **Do not invite.** Staging pool remains `COGNITO_DEFAULT`. |
| Tenant identity mapping + RLS / isolation | **GO (validated, not imported)** | Mapping proven on staging. Live DB bridge `identity_map` count **8**. Ninth UUID fail-closed. `--apply` refused. Production still uses Supabase Auth until API/DNS switch. |
| CloudFront / DNS / API routing | **BLOCKED** (switch) / **GO (prepared)** unused distribution | Staging: `staging.checksops.com` → `E1CG52WRQZI7X1`. Production-prep CloudFront has **no** aliases. Production apex/`www` still `185.158.133.1` (Lovable). Switching DNS is a **cutover decision**. |
| ACM for `checksops.com` / `www` | **GO (issued, not attached)** | Cert `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` **`ISSUED`** 2026-09-05T20:23:49Z. Cloudflare validation CNAMEs present (DNS-only). Apex/`www` still Lovable. Not in use by CloudFront. |
| SES production EMAIL_OTP | **READY** (prep; not switched) | Operator: SES us-east-1 production access + domain DKIM. Cognito `DEVELOPER` / `Support@checksops.com`. Isolated EMAIL_OTP **delivered**; test user deleted; pool **0 users**. Staging `COGNITO_DEFAULT` unchanged. Apex/`www` still Lovable. |
| Final DB delta via temporary DB bridge | **GO** (procedure) | Live `aws-staging-db-bridge` `health` HTTP 200, `mode:read_only`. **Not executed** this PR. |
| Final storage delta via temporary storage bridge | **GO** (procedure) | Live `aws-staging-storage-bridge` `health` HTTP 200, `mode:sign_only`. **Not executed** this PR. |
| Production webhook transition | **PARTIAL** | AWS `/webhooks/{moov,checkalt}` exist; `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`. Production URLs still on Supabase. Dual-run **not started**. **Cutover decision**. |
| Moov production transition | **PARTIAL** | Sandbox certification **PASS** (PR #124). Production `AWS_MOOV_ENABLED=false`. **Cutover decision**. |
| CheckAlt | **PARTIAL** | Separate chat. Production `AWS_CHECKALT_ENABLED=false`. **Cutover decision**. |
| Plaid | **N/A** | Not used. Missing keys are not a blocker. |
| Monitoring / CloudWatch / health checks | **GO (inspect-only)** | Prep `/health` 200. Five alarms on `checksops-production-prep-alarms` (`ActionsEnabled=false`, no SNS). `DescribeAlarms` allowed. |
| Reconciliation immediately after cutover | **GO** (procedure) | Report-only SQL + `/financial/reconcile` (`autoCorrected=false`). |
| Rollback if AWS production validation fails | **GO** (procedure) | Points A/B/C in `ROLLBACK.md`. Dry-run script prints only. |
| Temporary bridge teardown (after successful cutover) | **GO** (procedure) | **Do not run now.** Dry-run scripts refuse `--apply`. |
| Financial activation / `64_financial_activation_grants.sql` | **GO (hold)** | Stub `NOT_APPLIED`. CI refuses auto-apply. `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`. **Cutover decision** to apply. |
| Production execution / provider flags | **GO (hold)** | Live staging Lambda: listed execution flags **false**. Production-prep API templates hard-code flags false (sandbox execution also false). |
| ChecksOps AWS overall for **executing** production cutover | **BLOCKED** | Prepared resources do **not** authorize DNS, auth switch, identity import, webhook cut, Moov, CheckAlt, or financial activation. |

## Live snapshot (2026-09-05)

| Item | Value |
|---|---|
| API `/health` | 200, `environment=staging`, `productionSupabaseChanged=false` |
| API `/db-health` | `currentDatabase=checksops`, `currentUser=checksops`, `transactionReadOnly=on`, PostgreSQL 18.3 |
| Lambda | `checksops-staging-api` — **not overlaid** from this branch |
| Flags false | `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_PROVIDER_LIVE_READS_ENABLED` |
| Flags true (allowed on staging) | `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED`, `AWS_PROVIDER_WEBHOOK_DRY_RUN` |
| Staging CloudFront | `E1CG52WRQZI7X1` Deployed, alias `staging.checksops.com` |
| Production DNS | apex + `www` → `185.158.133.1` (unchanged) |
| Production Cognito | `us-east-1_h00WorYMT`, 0 users, not switched |
| ACM | **`ISSUED`** (not attached to CloudFront; apex/`www` still Lovable) |
| Production CloudFront (unused) | `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net`, aliases **0** |
| CFN | `checksops-staging` live; `checksops-production-prep` CREATE_COMPLETE; `checksops-production-prep-api` UPDATE_COMPLETE (dedicated role); `checksops-production-prep-alarms` CREATE_COMPLETE (`ActionsEnabled=false`) |
| Production-prep API | `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` `/health` 200, `environment=production-prep`, `database=not-connected` |

## Remaining blockers — more prep vs cutover decision

### Still prep (can continue without switching production)

- CheckAlt UAT GO **or** signed exception (separate chat; production flag stays false)
- Timed write-freeze drill (measurement only)
- Realtime: accept 15s polling **or** later design
- Optional: attach ACM to unused CloudFront **without** aliases (not done; `InUseBy` empty)
- Optional: SPF `include:amazonses.com` without moving apex/`www` A (OTP already delivered)

Prep walkthrough Steps 1–5D and SES EMAIL_OTP proof (6A–6B) are **verified**.

### Require a human **cutover decision** (not more agent prep)

1. Leave Lovable/Supabase as system of record until T0, then freeze writes.
2. Switch `checksops.com` / `www` DNS to production CloudFront **after** ACM ISSUED.
3. Switch production SPA/auth to Cognito (`us-east-1_h00WorYMT`, not staging).
4. Identity **import** of the eight production users (`--apply` is refused).
5. Passkey re-enrollment communication.
6. Start webhook dual-run, then redirect production Moov/CheckAlt URLs.
7. Load Moov production keys and set `AWS_MOOV_ENABLED` (still false).
8. CheckAlt GO **or** signed exception.
9. Apply `64_financial_activation_grants.sql` + `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` last.
10. Final write-freeze + DB/storage delta + recon PASS.
11. Tear down Lovable bridges **after** a successful cut (not now).

Non-blockers: Plaid; ninth UUID (fail-closed orphan); `profiles.preferred_auth_method`; staging-only S3 extras; Moov sandbox PASS.

## Related open PRs (do not merge as cutover)

| PR | Topic | This chat |
|---|---|---|
| #125 / #130 | CheckAlt UAT / architecture A | **Do not modify** |
| #132 | Production AWS prep (Cognito/CloudFront/Class A ports) | Live objects reused; e-sign/ingest not copied here |
| #128 / #129 | Earlier cutover-prep drafts | Superseded for matrix/runbooks by #131 |
