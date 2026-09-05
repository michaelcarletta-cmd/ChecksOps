# Production cutover readiness matrix

**STOP FOR REVIEW.** This document is an audit. It is **not** authorization to cut over.

Prepared: 2026-09-05  
Base: current `main` after PR **#130** (CheckAlt Architecture A) and PR **#131** (cutover readiness docs) merged.  
This PR (#132) is rebased onto that `main`. It does **not** revert Architecture A.

Live verify: staging API `/health` 200, Lambda flags all production-execution **false**, both Lovable bridges still fail-closed, production DNS still Lovable.

Plaid is **N/A** (not used; keep `AWS_PLAID_ENABLED=false`).  
CheckAlt **code** is on `main` via #130. Production `AWS_CHECKALT_ENABLED` stays **false**. This PR does not modify Architecture A files.

| Area | Status | Evidence / remaining |
|---|---|---|
| Production → AWS DB migration rehearsal | **GO** | PR #127 isolated overlay `checksops_rehearsal_20260905` matched live production counts, critical PKs, `financial_stepup_log` 2/2, financial aggregates, identity, membership, FKs. Live `checksops` not overwritten. |
| Production → AWS storage migration/reconciliation | **GO** | PR #127 COPY 1,411/1,411 objects, 0 missing/failed/mismatched. 21 staging-only UAT objects left in place. Live S3 now **1,439** objects / 2,566,275,762 bytes (expected drift since rehearsal; final delta still required). |
| Remaining Supabase/Lovable runtime dependencies | **PARTIAL** | AWS staging (`VITE_AUTH_PROVIDER=cognito`) already proxies DB/storage/Class A (email, OCR/Textract, homeowner OTP, tenant admin, hire-mortgage-agent). This PR ports first-party vendor e-sign, `ingest-shared-check` (bridge secret), and `homeowner-ledger-attach-upload`. Stripe/QuickBooks stay **fail-closed**. Realtime still polling. Production SPA is still `.env.production` Supabase-only. |
| Production frontend / API AWS configuration | **GO (prepared, not switched)** for SPA; **PARTIAL** for API stack | SPA bucket + CloudFront `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net` **without** apex/`www` aliases (placeholder only). Separate API templates exist (`Environment=production-prep` only, flags false). Agent cannot create the Lambda IAM role (`iam:GetRole` denied). `.env.production` stays Supabase. Do not overlay `checksops-staging-api`. |
| Cognito EMAIL_OTP / WebAuthn (staging) | **GO** | PR #126: CheckOps / WhiteLabel / MortgageOps / `/h/upload`. Pool `us-east-1_vPmQ7cL1F`, client allows `ALLOW_USER_AUTH`, MFA OFF, EMAIL_OTP preferred. |
| Cognito EMAIL_OTP / WebAuthn (production transition) | **GO (prepared, not switched)** | Pool `us-east-1_h00WorYMT` (`checksops-production`), 0 users, EMAIL_OTP+PASSWORD+WEB_AUTHN, MFA OFF, deletion protection ACTIVE. Web client from prep stack. **Do not invite.** SES From still outstanding. Pool WebAuthn RP ID not yet set (CLI `UpdateUserPool` has no `WebAuthnConfiguration`; operator console on this pool only). |
| Tenant identity mapping + RLS / isolation | **GO (validated, not imported)** | Mapping `cognito_sub → identity_accounts.application_user_id → auth.uid()` proven on staging. Live DB bridge `identity_map` count **8**; **8/8** expected application UUIDs matched; ninth UUID fail-closed. `--apply` refused. Production still uses Supabase Auth until API/DNS switch. |
| CloudFront / DNS / API routing | **BLOCKED** (switch) / **GO (prepared)** for unused distribution | Staging: `staging.checksops.com` → CloudFront `E1CG52WRQZI7X1`. Production-prep CloudFront has **no** aliases. Production apex/`www` still `185.158.133.1` (Lovable). Switching DNS is a **cutover decision**. |
| ACM for `checksops.com` / `www` | **PARTIAL** | Cert `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` `PENDING_VALIDATION`. Operator must add ACM CNAMEs (that is a DNS change). Do not alias CloudFront until ISSUED **and** cutover approval. |
| Final DB delta via temporary DB bridge | **GO** (procedure) | Live `aws-staging-db-bridge` `health` HTTP 200, `mode:read_only`, writes/deletes/rpc/rawSql **false**. **Not executed** this PR. |
| Final storage delta via temporary storage bridge | **GO** (procedure) | Live `aws-staging-storage-bridge` `health` HTTP 200, `mode:sign_only`, deletes **false**, dbWrites **false**. **Not executed** this PR. |
| Production webhook transition | **PARTIAL** | AWS `/webhooks/{moov,checkalt}` exist; `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`. Production URLs still on Supabase. Dual-run **not started**. **Cutover decision** to start dual-run. |
| Moov production transition | **PARTIAL** | Sandbox certification **PASS** (PR #124). Production `AWS_MOOV_ENABLED=false`. Production keys/IDs not loaded on AWS. Dual-run not started. **Cutover decision**. |
| CheckAlt | **PARTIAL** | Architecture A **merged** (#130). Production `AWS_CHECKALT_ENABLED=false`. Full cut usually needs CheckAlt GO **or** a signed exception. **Cutover decision**. |
| Plaid | **N/A** | Not used. Missing keys are not a blocker. |
| Monitoring / CloudWatch / health checks | **PARTIAL** | `/health` 200, `/db-health` connected. Production-prep log group inspectable via `DescribeLogGroups`. Agent role **cannot** `cloudwatch:DescribeAlarms` / `GetMetricStatistics`. Ops-role IAM still needed for alarm APIs. |
| Reconciliation immediately after cutover | **GO** (procedure) | Report-only SQL + `/financial/reconcile` (`autoCorrected=false`). See `POST_CUTOVER_RECONCILIATION.md`. |
| Rollback if AWS production validation fails | **GO** (procedure) | Points A/B/C in `ROLLBACK.md`. Dry-run script prints only. |
| Temporary bridge teardown (after successful cutover) | **GO** (procedure) | **Do not run now.** `BRIDGE_TEARDOWN.md` + dry-run script refuse `--apply`. |
| Financial activation / `64_financial_activation_grants.sql` | **GO (hold)** | Stub returns `NOT_APPLIED`. CI refuses auto-apply. `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`. **Cutover decision** to apply. |
| Production execution / provider flags | **GO (hold)** | Live Lambda: all listed execution flags **false**; sandbox execution **true**; webhook dry-run **true**. Production-prep API template hard-codes flags false (sandbox execution also false). |
| ChecksOps AWS overall for **executing** production cutover | **BLOCKED** | Prepared resources do **not** authorize DNS, auth switch, identity import, webhook cut, Moov, CheckAlt, or financial activation. |

## Live snapshot (2026-09-05, no mutations)

| Item | Value |
|---|---|
| API `/health` | 200, `environment=staging`, `productionSupabaseChanged=false` |
| API `/db-health` | `currentDatabase=checksops`, `currentUser=checksops`, `transactionReadOnly=on`, PostgreSQL 18.3 |
| Lambda | `checksops-staging-api`, account `806168576068`, arm64, nodejs22.x, VPC attached — **not overlaid** from this branch |
| Flags false | `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_PROVIDER_LIVE_READS_ENABLED` |
| Flags true (allowed) | `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED`, `AWS_PROVIDER_WEBHOOK_DRY_RUN` |
| Staging CloudFront | `E1CG52WRQZI7X1` Deployed, alias `staging.checksops.com` |
| Production DNS | apex + `www` → `185.158.133.1` (unchanged) |
| Production Cognito | `us-east-1_h00WorYMT`, 0 users, not switched |
| Identity map | 8/8 expected UUIDs via read-only bridge; ninth excluded |
| ACM | `PENDING_VALIDATION` (no Cloudflare records added) |
| Production CloudFront (unused) | `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net`, aliases **0** |
| CFN | `checksops-staging` UPDATE_COMPLETE; `checksops-staging-frontend-https` UPDATE_COMPLETE; `checksops-production-prep` CREATE_COMPLETE |

## Remaining blockers — more prep vs cutover decision

### Still prep (can continue without switching production)

- Operator IAM to deploy `checksops-production-prep-api` (`iam:CreateRole` / `GetRole` / `PassRole`); delete leftover `checksops-production-prep-api-role` if it exists
- SES From / Cognito `DEVELOPER` email on `us-east-1_h00WorYMT`
- Set WebAuthn RP ID `checksops.com` on that pool (console; not staging)
- Operator ACM DNS CNAMEs (DNS change, but not apex cut)
- Ops-role CloudWatch alarm IAM
- Timed write-freeze drill (measurement only)
- Realtime: accept 15s polling **or** later design (waiver can be written without cutting DNS)
- CheckAlt UAT in the separate chat (does not require DNS cut)

### Require a human **cutover decision** (not more agent prep)

1. Leave Lovable/Supabase as system of record until T0, then freeze writes.
2. Switch `checksops.com` / `www` DNS (Cloudflare) to production CloudFront **after** ACM ISSUED.
3. Switch production SPA/auth to Cognito (`us-east-1_h00WorYMT`, not staging) and uncomment `.env.production.aws.example`.
4. Identity **import** of the eight production users (`--apply` is currently refused).
5. Passkey re-enrollment communication (SimpleWebAuthn credentials are not migrated).
6. Start webhook dual-run, then redirect production Moov/CheckAlt URLs.
7. Load Moov production keys and set `AWS_MOOV_ENABLED` (still false here).
8. CheckAlt GO **or** signed exception that deposits stay off AWS at DNS cut.
9. Apply `64_financial_activation_grants.sql` + `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` last.
10. Final write-freeze + DB/storage delta + recon PASS.
11. Tear down Lovable bridges **after** a successful cut (not now).

Non-blockers: Plaid; ninth UUID (fail-closed orphan); `profiles.preferred_auth_method`; staging-only S3 extras; Moov sandbox PASS.

## Related PRs (do not merge #132 from this chat)

| PR | Topic | Status |
|---|---|---|
| #130 | CheckAlt Architecture A | **Merged** to `main`. Preserved in this rebase. Production flag still false. |
| #131 | Cutover matrix/runbooks | **Merged** to `main`. |
| #132 | Production AWS prep (this PR) | Open draft on `main`; flags off; no DNS/auth switch |
| #128 / #129 | Earlier cutover-prep drafts | Superseded for matrix/runbooks by #131 |
