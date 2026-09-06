# Production cutover readiness matrix

**STOP FOR REVIEW.** This document is an audit. It is **not** authorization to cut over.

Updated: 2026-09-06 after PR **#135** (application parity) and the targeted live `checksops` Sept 3 payee-mirror trigger overlay. See `POST_PARITY_READINESS.md`.

**FINAL CUTOVER READINESS: PASS** — prepared for a human T0 decision only. T0 was **not** selected.

Prepared originally: 2026-09-05  
Base: current `main` after PR **#130** (CheckAlt Architecture A) and PR **#131** (cutover readiness docs) merged.  
Later: #132 prep, #135 application parity, then this post-parity overlay. Architecture A is **unchanged**.

Live verify: staging API `/health` 200, Lambda flags all production-execution **false**, both Lovable bridges still fail-closed, production DNS still Lovable.

Plaid is **N/A** (not used; keep `AWS_PLAID_ENABLED=false`).  
CheckAlt **code** is on `main` via #130. Production `AWS_CHECKALT_ENABLED` stays **false**. This PR does not modify Architecture A files.

| Area | Status | Evidence / remaining |
|---|---|---|
| Production → AWS DB migration rehearsal | **GO** | Timed rehearsal `checksops_rehearsal_20260906` remains valid (not recreated). Live `checksops` received **only** the Sept 3 `tg_mirror_payee_to_endorsement` function overlay; row counts/histograms unchanged. |
| Production → AWS storage migration/reconciliation | **GO** | PR #127 COPY 1,411/1,411, 0 hash mismatches. 2026-09-06 historical sample: 8/8 older checks, 16/16 source SHA-256 matches. Live S3 `files/` **1,439** objects / 2,566,275,762 bytes. Final T0 storage delta still required. |
| Remaining Supabase/Lovable runtime dependencies | **PARTIAL** | Class A e-sign / ingest / attach-upload ported. Stripe/QBO fail-closed. **Realtime 15s polling waived** (`REALTIME_POLLING_WAIVER.md`). Production SPA still `.env.production` Supabase-only until cutover. |
| Production frontend / API AWS configuration | **GO (prepared, not switched)** | SPA CloudFront `E1B0ZWWO5559U5` (no aliases). Prep API live at `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep`, flags **false**, no VPC, existing staging Lambda role reused. `.env.production` stays Supabase. Staging Lambda **not** overlaid. |
| Cognito EMAIL_OTP / WebAuthn (staging) | **GO** | PR #126: CheckOps / WhiteLabel / MortgageOps / `/h/upload`. Pool `us-east-1_vPmQ7cL1F`, client allows `ALLOW_USER_AUTH`, MFA OFF, EMAIL_OTP preferred. WebAuthn RP **`staging.checksops.com`** (unchanged this PR). |
| Cognito EMAIL_OTP / WebAuthn (production transition) | **GO (prepared, not switched)** | Pool `us-east-1_h00WorYMT`, **0 users**, MFA OFF, deletion protection ACTIVE. WebAuthn RP **`checksops.com`** set via `SetUserPoolMfaConfig`. SES From **PARTIAL** (agent SES APIs denied; `COGNITO_DEFAULT`). **Do not invite.** |
| Tenant identity mapping + RLS / isolation | **GO (validated, not imported)** | Live identity_map **8/8**. Ninth UUID **not present** on live production (`not_found`). `--apply` refused. Production still uses Supabase Auth until API/DNS switch. |
| CloudFront / DNS / API routing | **BLOCKED** (switch) / **GO (prepared)** for unused distribution | Staging: `staging.checksops.com` → CloudFront `E1CG52WRQZI7X1`. Production-prep CloudFront has **no** aliases. Production apex/`www` still `185.158.133.1` (Lovable). Switching DNS is a **cutover decision**. |
| ACM for `checksops.com` / `www` | **PARTIAL** | Cert `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` `PENDING_VALIDATION`. Validation CNAMEs **not** in DNS (no Cloudflare write from this agent). Completing validation would not change apex A records but needs operator DNS. Do not alias CloudFront until ISSUED **and** cutover approval. |
| Final DB delta via temporary DB bridge | **GO** (procedure) | Live `aws-staging-db-bridge` `health` HTTP 200, `mode:read_only`, writes/deletes/rpc/rawSql **false**. **Not executed** this PR. |
| Final storage delta via temporary storage bridge | **GO** (procedure) | Live `aws-staging-storage-bridge` `health` HTTP 200, `mode:sign_only`, deletes **false**, dbWrites **false**. **Not executed** this PR. |
| Production webhook transition | **PARTIAL** | AWS `/webhooks/{moov,checkalt}` exist; `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`. Production URLs still on Supabase. Dual-run **not started**. **Cutover decision** to start dual-run. |
| Moov production transition | **PARTIAL** | Sandbox certification **PASS** (PR #124). Production `AWS_MOOV_ENABLED=false`. Production keys/IDs not loaded on AWS. Dual-run not started. **Cutover decision**. |
| CheckAlt | **PARTIAL** | Architecture A **merged** (#130). Production `AWS_CHECKALT_ENABLED=false`. Full cut usually needs CheckAlt GO **or** a signed exception. **Cutover decision**. |
| Plaid | **N/A** | Not used. Missing keys are not a blocker. |
| Monitoring / CloudWatch / health checks | **PARTIAL** | Prep `/health` + `/ops/readiness` 200, flags false. Log metric filters on `/aws/lambda/checksops-production-prep-api`. `PutMetricAlarm` / `DescribeAlarms` denied. Staging `/health` 200 and `/db-health` connected. |
| Timed write-freeze drill | **GO (drill)** | Capture-path ~64 s on live read-only bridges. Production freeze **not** enabled. `--apply` / `--freeze` refused. See `WRITE_FREEZE_DRILL.md`. |
| Reconciliation immediately after cutover | **GO** (procedure) | Report-only SQL + `/financial/reconcile` (`autoCorrected=false`). See `POST_CUTOVER_RECONCILIATION.md`. |
| Rollback if AWS production validation fails | **GO** (procedure) | Points A/B/C in `ROLLBACK.md`. Dry-run script prints only. |
| Temporary bridge teardown (after successful cutover) | **GO** (procedure) | **Do not run now.** `BRIDGE_TEARDOWN.md` + dry-run script refuse `--apply`. |
| Financial activation / `64_financial_activation_grants.sql` | **GO (hold)** | Stub returns `NOT_APPLIED`. CI refuses auto-apply. `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`. **Cutover decision** to apply. |
| Production execution / provider flags | **GO (hold)** | Live staging Lambda: all listed execution flags **false**; sandbox execution **true**; webhook dry-run **true**. Production-prep API hard-codes flags false (sandbox execution also false). |
| ChecksOps AWS overall for **executing** production cutover | **BLOCKED** | Prepared resources do **not** authorize DNS, auth switch, identity import, webhook cut, Moov, CheckAlt, or financial activation. |

## Live snapshot (2026-09-05, no production mutations)

| Item | Value |
|---|---|
| Staging API `/health` | 200, `environment=staging`, `productionSupabaseChanged=false` |
| Staging API `/db-health` | `currentDatabase=checksops`, `currentUser=checksops`, `transactionReadOnly=on`, PostgreSQL 18.3 |
| Staging Lambda | `checksops-staging-api`, account `806168576068`, arm64, nodejs22.x, VPC attached — **not overlaid** from this branch |
| Staging flags false | `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_PROVIDER_LIVE_READS_ENABLED` |
| Staging flags true (allowed) | `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED`, `AWS_PROVIDER_WEBHOOK_DRY_RUN` |
| Prep API | `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` — `/health` 200 `environment=production-prep`, no DB, flags **false**, sandbox execution **false** |
| Prep Lambda role | `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` (existing SAM role; no VPC on this function) |
| Staging CloudFront | `E1CG52WRQZI7X1` Deployed, alias `staging.checksops.com` |
| Production DNS | apex + `www` → `185.158.133.1` (unchanged) |
| Production Cognito | `us-east-1_h00WorYMT`, 0 users, MFA OFF, WebAuthn RP `checksops.com`, EMAIL `COGNITO_DEFAULT`, not switched |
| Staging Cognito RP | `us-east-1_vPmQ7cL1F` still `staging.checksops.com` |
| Identity map | 8/8 expected UUIDs via read-only bridge; ninth `not_found` |
| ACM | `PENDING_VALIDATION` (validation CNAMEs empty in DNS; apex A unchanged) |
| Production CloudFront (unused) | `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net`, aliases **0** |
| CFN | `checksops-staging` UPDATE_COMPLETE; `checksops-staging-frontend-https` UPDATE_COMPLETE; `checksops-production-prep` CREATE_COMPLETE; `checksops-production-prep-api` CREATE_COMPLETE |

## Remaining blockers — more prep vs cutover decision

### Still prep (can continue without switching production)

- Operator SES domain verify + `EmailSendingAccount=DEVELOPER` on **`us-east-1_h00WorYMT` only** (preserve MFA OFF, WebAuthn RP `checksops.com`, 0 users). Never against the staging pool.
- Operator ACM DNS validation CNAMEs (not apex/`www` A records). This agent has no Cloudflare credentials.
- Dedicated ops role `cloudwatch:PutMetricAlarm` / `DescribeAlarms` (do **not** broaden `ChecksOpsCursorCloudStaging`).
- Optional: dedicated least-privilege Lambda execution role instead of sharing the staging SAM role.
- Leftover `checksops-production-prep-api-role` from an earlier failed create, if it exists (`iam:GetRole` denied from this agent).
- CheckAlt UAT in the separate chat (does not require DNS cut).

### Require a human **cutover decision** (not more agent prep)

1. Leave Lovable/Supabase as system of record until T0, then freeze writes.
2. Switch `checksops.com` / `www` DNS (Cloudflare) to production CloudFront **after** ACM ISSUED.
3. Switch production SPA/auth to Cognito (`us-east-1_h00WorYMT`, not staging) and uncomment `.env.production.aws.example`.
4. Identity **import** of the eight production users (`--apply` is currently refused). Do not import the ninth UUID.
5. Passkey re-enrollment communication (SimpleWebAuthn credentials are not migrated).
6. Start webhook dual-run, then redirect production Moov/CheckAlt URLs.
7. Load Moov production keys and set `AWS_MOOV_ENABLED` (still false here).
8. CheckAlt GO **or** signed exception that deposits stay off AWS at DNS cut.
9. Apply `64_financial_activation_grants.sql` + `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` last.
10. Final write-freeze + DB/storage delta + recon PASS.
11. Tear down Lovable bridges **after** a successful cut (not now).

Non-blockers: Plaid; ninth UUID (`not_found` on live production); `profiles.preferred_auth_method`; staging-only S3 extras; Moov sandbox PASS; Cognito-default mail for EMAIL_OTP **prep** (branded SES From is still operator prep, not a cutover switch).

## Related PRs (merge #132 as code/prep only — not cutover)

| PR | Topic | Status |
|---|---|---|
| #130 | CheckAlt Architecture A | **Merged** to `main`. Preserved in this rebase. Production flag still false. |
| #131 | Cutover matrix/runbooks | **Merged** to `main`. |
| #132 | Production AWS prep (this PR) | Open draft on `main`; flags off; no DNS/auth switch. **Code/prep merge is separate from cutover authorization.** |
| #128 / #129 | Earlier cutover-prep drafts | Superseded for matrix/runbooks by #131 |
