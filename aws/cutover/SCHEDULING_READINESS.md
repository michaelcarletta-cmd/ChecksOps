# Production cutover scheduling readiness

**STOP FOR REVIEW.** This document authorizes **picking a T0 date**. It does **not** authorize executing cutover.

Audit date: 2026-09-06  
Base: current `main` `8a9181ae` (PR #132) plus live production-prep objects  
Cutover actions performed this audit: **none**

## READY TO SCHEDULE PRODUCTION CUTOVER: **YES**

Executing cutover remains **BLOCKED** until T0 explicit approvals.  
CheckAlt production execution stays **OFF** at the initial DNS/auth cut.

| Constraint at the scheduled cut | Required value |
|---|---|
| `AWS_CHECKALT_ENABLED` | `false` (prep + staging) |
| All provider / financial execution flags | `false` |
| `64_financial_activation_grants.sql` | not applied |
| Lovable DB + storage bridges | remain deployed |
| Production frontend / auth / DNS | stay Lovable/Supabase until T6 |
| Architecture A | unchanged |
| PR #125 | stays open / unmerged (UAT evidence / VOID tracker) |

## Verdict split

| Question | Answer |
|---|---|
| Ready to **schedule** T0 (DNS/auth AWS cut, flags OFF)? | **YES** |
| Ready to **execute** cutover without further human approval? | **NO** (`BLOCKED`) |
| Ready to enable CheckAlt / Moov / financial grants at that cut? | **NO** (later, separate explicit approval) |
| CheckAlt synthetic UAT (VOID IQA)? | **PARTIAL** — **non-blocking for scheduling** while CheckAlt stays OFF |

## Live rails re-verified (2026-09-06)

| Rail | Live |
|---|---|
| Production DNS apex / `www` | `185.158.133.1` (Lovable) |
| Production Cognito `us-east-1_h00WorYMT` | **0 users**, MFA OFF, EMAIL_OTP+PASSWORD+WEB_AUTHN, RP `checksops.com`, SES `DEVELOPER` / `Support@checksops.com` |
| Staging Cognito | `us-east-1_vPmQ7cL1F` unused for production; still `COGNITO_DEFAULT` |
| Prep CloudFront `E1B0ZWWO5559U5` | aliases **0**, default cert, Deployed |
| ACM `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` | **ISSUED**, `InUseBy` empty |
| Prep API `/prep/health` | 200, `environment=production-prep`, `database=not-connected` |
| Prep Lambda flags | `AWS_CHECKALT_ENABLED=false`, `AWS_MOOV_ENABLED=false`, `AWS_WRITES_ENABLED=false`, `AWS_PROVIDER_EXECUTION_ENABLED=false`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`, `AWS_PLAID_ENABLED=false`, `AWS_PROVIDER_LIVE_READS_ENABLED=false`, `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`, `AWS_PROVIDER_WEBHOOK_DRY_RUN=true` |
| Staging Lambda | `AWS_CHECKALT_ENABLED=false`; production-execution flags false; sandbox execution true (staging-only) |
| `.env.production` | Supabase only; no `VITE_AUTH_PROVIDER=cognito` |
| Bridges | still deployed; POST `/health` without token **401** fail-closed |
| Identity import `--apply` | refused; mapped eligible count **8** |
| Financial SQL | stub `NOT_APPLIED` |
| SES EMAIL_OTP | **READY** (isolated delivery proven; test user deleted) |
| `validate-production-prep.mjs --live` | `ok: true`, `blocked: []` |

## Remaining pre-cutover checklist (does **not** block scheduling)

Do these before T0 night. None of them is a merge/build gate for **picking a date**.

1. Re-verify immediately before T0: DNS still Lovable, Cognito still 0 users, all execution flags false including `AWS_CHECKALT_ENABLED`, both bridges still 401 without token, `.env.production` still Supabase.
2. Fill `CUTOVER_NIGHT_OPERATOR_CHECKLIST.md` on the night (no PII in Git).
3. Confirm the eight production identities privately (count only in Git). Ninth UUID stays fail-closed.
4. Announce passkey re-enrollment + EMAIL_OTP-first login (staging passkeys do not transfer).
5. Decide realtime: accept 15s polling for the first cut **or** defer a later design. Not a DNS blocker.
6. Optional operator AWS (not DNS): attach the ISSUED ACM cert to unused CloudFront `E1B0ZWWO5559U5` with aliases still **0**.
7. Optional DNS TXT only (do not move apex/`www` A): add `include:amazonses.com` to SPF. OTP already delivered without it.
8. Optional: timed write-freeze drill (measurement only). Freeze duration is still an **estimate**, not a measured rehearsal.
9. Moov webhook dual-run plan (additional AWS subscriber, `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`). CheckAlt dual-run is **out of scope** for the initial cut.
10. At T6 only: privately fill production SPA Cognito env from `.env.production.aws.example` using pool `us-east-1_h00WorYMT` (never staging `us-east-1_vPmQ7cL1F`). Do **not** merge that over `.env.production` until T6 is approved.

## Should anything still be built or merged before scheduling?

**No required code or merge.**

| Item | Before scheduling? |
|---|---|
| PR #125 (CheckAlt UAT / VOID tracker) | **Do not merge** as cutover. Keep open. |
| PR #133 (prep docs / templates) | Optional so `main` has the runbooks. Not required to pick T0; live AWS already exists. |
| Production SPA Cognito bundle | Built at **T6**, not before scheduling. |
| CheckAlt synthetic VOID IQA | Not required before scheduling. Enable CheckAlt later. |
| ACM attach / SPF TXT | Operator AWS/DNS TXT; not Git. |
| `64_financial_activation_grants.sql` | Must **not** be applied before or during the initial cut. |

## Exact ordered sequence for the **scheduled** DNS/auth cut

Keep flags false through this entire sequence. CheckAlt enable is **not** in this window.

### T−7 to T−1 (no DNS, no flags)

1. Confirm both Lovable bridges still deployed (DB `read_only`, storage `sign_only` / COPY-only).
2. Confirm flags false: `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_PROVIDER_LIVE_READS_ENABLED`.
3. Confirm `64_financial_activation_grants.sql` is still `NOT_APPLIED`.
4. Confirm production Cognito is `us-east-1_h00WorYMT` (not `us-east-1_vPmQ7cL1F`) and still 0 users until T3.
5. Record production API URL and frontend bundle SHA blanks for T6.
6. Announce passkey re-enrollment + EMAIL_OTP-first login.
7. Capture pre-cutover financial aggregates (report-only; no PII in Git).
8. Record current DNS targets (live: apex/`www` `185.158.133.1`).
9. Confirm CheckAlt stay-OFF exception for this cut (this document).

### T0 — write-freeze (production still Lovable)

10. Enable application write-freeze (no new checks/deposits/disbursements/ledger/storage).
11. Freeze Auth invites / password resets that would desync identity maps.
12. **Do not** redirect Moov/CheckAlt webhooks.
13. **Do not** change apex/`www` DNS.

### T1 — final DB delta

14. POST DB bridge `health` — require `mode: read_only`.
15. Keyset-page approved tables; reconstruct changed PKs; omit secrets.
16. Overlay into a **new** isolated `checksops_rehearsal_YYYYMMDD`. Do not overwrite live `checksops` until swap is approved.
17. Recon must PASS: counts, PKs, financial aggregates, identity, membership, FKs, required-null, `financial_stepup_log`.

### T2 — final storage delta

18. Inventory via storage bridge (counts + bytes only in Git).
19. COPY new objects append-only; never overwrite hash-verified keys; never delete production.

### T3 — identity delta

20. Create Cognito users only for still-unmapped application UUIDs on the **production** pool.
21. Refuse `application_user_id === cognito_sub`. Exclude the ninth UUID.
22. Record mapped user count only (no emails in Git).

### T4 — point AWS API at reconciled DB (still no public DNS)

23. Snapshot RDS.
24. Attach production-prep API (**flags still false**) to the reconciled database after recon PASS.
25. Smoke on a non-public host: CheckOps / WhiteLabel / MortgageOps EMAIL_OTP, read paths, storage sign. **No money movement.**
26. `GET /health` 200 and `/ops/readiness` holds.ok.

### T5 — webhook dual-run (optional this night; still no DNS)

27. Production webhook URLs **remain** on Supabase.
28. If approved: add AWS `/webhooks/moov` as an **additional** subscriber with `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`. Do **not** add CheckAlt as a live subscriber for this cut.
29. **Never** flip DNS and webhook ownership in the same step.
30. **Do not** remove Supabase webhook URLs.

### T6 — frontend + DNS (only after T1–T4 PASS; T5 if started)

31. Deploy production SPA with Cognito pool `us-east-1_h00WorYMT` + production API URL. Keep the previous Lovable origin for rollback.
32. Attach ACM if not already attached; set CloudFront aliases; change apex/`www` to production CloudFront. Record previous targets first.
33. **Do not** flip Moov/CheckAlt/financial/execution flags in the same step as DNS.
34. Immediate post-DNS recon (`POST_CUTOVER_RECONCILIATION.md`).

### T8 — monitor (then stop)

35. CloudWatch Lambda errors/timeouts, API 5xx, Cognito auth failures.
36. Webhook receipts vs apply (`applied: false`).
37. Financial aggregate drift vs T0; storage counts vs final inventory.
38. **Stop.** Do not tear down bridges. Do not enable providers.

### Later night (not this schedule) — T7 financial / provider activation

Requires **separate explicit approval**, after a stable DNS/auth cut:

- Named review of `deposit.submit` / `deposit.approve` / `disbursement.send`
- Apply `64_financial_activation_grants.sql` last among money gates
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=true`
- `AWS_MOOV_ENABLED=true` (own approval)
- `AWS_CHECKALT_ENABLED=true` (own approval; after UAT/VOID is accepted or waived again)
- Redirect production webhooks (own approval; never same step as DNS)
- `AWS_PROVIDER_EXECUTION_ENABLED=true` **last**
- Bridge teardown only after a declared successful cut (`BRIDGE_TEARDOWN.md`)

## Rollback checkpoints

| Point | When | What |
|---|---|---|
| **A** | Before DNS / webhook switch | Production never left Lovable. Leave DNS on `185.158.133.1`. Do not redirect webhooks. Lift freeze after Supabase health. Drop failed `checksops_rehearsal_*` only. Leave S3 copies. Disable Cognito users created only for the failed wave. Bridges stay. |
| **B** | After DNS, flags still OFF | Revert apex/`www` to recorded Lovable targets immediately. Users sign in on Supabase Auth again. Reconcile any AWS writes (should be near-zero). If dual-run was added, remove **only** the extra AWS subscriber. Bridges stay. |
| **C** | After provider flags ON | **Out of scope for the scheduled cut** (flags stay OFF). If a later T7 is in progress: immediately set execution/Moov/CheckAlt/financial flags false; restore Supabase webhook URLs; do not delete provider objects; report-only reconcile; do not re-apply grants. |

Dry-run only until T0: `node aws/cutover/scripts/rollback-dry-run.mjs`

## Actions that require explicit human approval

The agent must not perform these without a new, named approval:

1. Pick and announce the T0 write-freeze window (scheduling itself).
2. Enable production write-freeze.
3. Run final DB/storage delta against live production.
4. Identity import `--apply` (eight production users).
5. Point the production API at the reconciled DB / promote rehearsal.
6. Start Moov webhook dual-run.
7. Attach ACM aliases / switch `checksops.com` / `www` DNS / switch production SPA to Cognito.
8. Redirect production Moov or CheckAlt webhooks.
9. Set `AWS_MOOV_ENABLED=true`.
10. Set `AWS_CHECKALT_ENABLED=true` (later; not this cut).
11. Apply `64_financial_activation_grants.sql` / `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=true`.
12. Set `AWS_PROVIDER_EXECUTION_ENABLED=true`.
13. Tear down Lovable bridges.
14. Overlay `checksops-staging-api` or merge PR #125 as cutover.

## Expected downtime / write-freeze window

**Not measured.** Production was never frozen. There is no drill clock for a full freeze.

| Segment | Estimate (from rehearsal, not a freeze drill) |
|---|---|
| Announce + enable write-freeze | 5–10 min |
| Bridge keyset + reconstruct (~12k rows was minutes in rehearsal) | 5–15 min |
| Upload overlay to S3 | 2–5 min |
| Isolated overlay / restore | 10–25 min |
| Automated recon + financial gates | 5–10 min |
| Storage delta COPY (incremental) | 5–30 min |
| Cognito identity delta | 5–15 min |
| **Write-freeze until DB+storage ready, pre-DNS** | **~45–110 min** |
| T6 DNS / TLS / SPA switch | additional; depends on Cloudflare TTL (keep TTL low before T0) |

Rehearsal overlay of the ~12k-row keyset completed on the order of **minutes**. The 45–110 minute band is the published planning window until a timed freeze drill exists. DNS switch is a separate controlled window **after** recon PASS; keep flags OFF so Point B rollback is DNS revert only.

## Tripwires (abort to the matching rollback point)

Unexpected production provider transaction; amount mismatch; duplicate provider object; webhook signature failures; identity mapping failures; financial aggregate drift; sandbox IDs in production provider tables; `/health` not 200; `productionSupabaseChanged` true; any execution flag flipped during this scheduled cut; CheckAlt enabled; financial grants applied; bridges torn down.
