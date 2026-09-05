# Final production cutover readiness runbook

**DO NOT EXECUTE PRODUCTION CUTOVER FROM THIS DOCUMENT.**  
**DO NOT APPLY `64_financial_activation_grants.sql`.**  
**DO NOT CHANGE production DNS, webhooks, auth, Supabase/Lovable, Moov, or CheckAlt.**  
**DO NOT PERFORM production transactions.**  
**DO NOT REMOVE either temporary migration bridge.**  
**DO NOT MODIFY PR #125 or #130.**

| Field | Value |
|---|---|
| Prepared | 2026-09-05 |
| Base commit | `main` after PR #127 (`19f6c196`) |
| Nature | Readiness audit + ordered procedure. Production activation remains disabled. |
| Overall | **PARTIAL** readiness / **BLOCKED** for executing production cutover |
| Plaid | **N/A — not used; not a cutover requirement** |
| CheckAlt | **PARTIAL** — handled separately; production flag stays false |

Temporary Lovable **DB** (`aws-staging-db-bridge`) and **Storage** (`aws-staging-storage-bridge`) bridges **must remain deployed**. They are the last-mile delta path on cutover night.

Scorecard: `CUTOVER_READINESS_MATRIX.md`.  
Rollback: `ROLLBACK.md`.  
Bridge teardown (after success only): `BRIDGE_TEARDOWN.md`.  
Webhooks: `WEBHOOK_TRANSITION.md`.  
Auth: `COGNITO_PRODUCTION_TRANSITION.md`.  
Post-cutover recon: `POST_CUTOVER_RECONCILIATION.md`.  
Monitoring: `MONITORING.md`.

Night-of checkbox copy: `CUTOVER_NIGHT_OPERATOR_CHECKLIST.md`.

---

## Current production vs AWS (do not switch)

| Surface | Production today | AWS staging today |
|---|---|---|
| Frontend | Lovable / `.env.production` → Supabase | `https://staging.checksops.com` CloudFront `E1CG52WRQZI7X1` |
| API | Supabase Edge + PostgREST | `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging` |
| Auth | Supabase Auth + SimpleWebAuthn + MFA | Cognito EMAIL_OTP + WebAuthn (`us-east-1_vPmQ7cL1F`), RP ID `staging.checksops.com` |
| DB | Production Supabase Postgres | RDS `checksops` (UAT + overlay rehearsal DB `checksops_rehearsal_20260905`) |
| Files | Supabase Storage | S3 `files/{bucket}/…` (1,439 objects at last live list) |
| Moov / CheckAlt webhooks | Supabase functions | AWS `/webhooks/{moov,checkalt}` **dry-run**; production URLs not redirected |
| Provider flags | N/A (Lovable live money) | All production execution flags **false** |

---

## Exact ordered cutover procedure

**Do not start this sequence until every blocker in `CUTOVER_READINESS_MATRIX.md` is GO or waived.** Fill blanks at execution time. This PR does not run it.

### T−7 to T−1 (still no DNS / no flags)

1. Confirm both Lovable bridges still `mode: read_only` (DB) and Storage `sign_only` / COPY-only (no deletes).
2. Confirm Lambda flags still false: `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`.
3. Confirm `64_financial_activation_grants.sql` was **not** applied (`SELECT 'NOT_APPLIED'`).
4. Production Cognito pool ID: `________________` (must not be `us-east-1_vPmQ7cL1F`).
5. Production API URL: `________________`
6. Production frontend bundle SHA: `________________`
7. Announce user-visible passkey re-enrollment + EMAIL_OTP-first login.
8. Capture pre-cutover financial aggregates (report-only) on production and on isolated rehearsal.
9. Record current production DNS targets (apex + `www`): `________________` (live verify 2026-09-05: `185.158.133.1`).
10. Confirm CheckAlt production plan: disabled-at-DNS **with signed exception** **or** vendor GO from the separate chat.

### T0 — write-freeze (production still on Lovable)

11. Enable application write-freeze so no new checks, deposits, disbursements, ledger rows, or storage objects land.
12. Freeze Auth invites / password resets that would desync identity maps.
13. **Do not** redirect Moov/CheckAlt webhooks yet.
14. **Do not** change apex/`www` DNS yet.

### T1 — final DB delta (bridges)

15. `POST` DB bridge `health` — require `mode: read_only`, writes/deletes/rpc/rawSql **false**.
16. Keyset-page approved tables; classify insert/update/delete vs last rehearsal.
17. Reconstruct full rows for changed PKs; omit `[redacted]` secrets; keep SQL NULL.
18. Upload overlay JSON to private S3; record SHA-256: `________________`
19. Overlay into a **new** isolated `checksops_rehearsal_YYYYMMDD` (or swap-ready clone). **Do not overwrite live `checksops` UAT identity until swap is approved.**
20. Recon must PASS: counts, PK fingerprints, financial aggregates, identity, membership, FKs, required-null, `financial_stepup_log`.

Worker (token from Secrets Manager — never commit / never log):

```bash
node aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs
```

### T2 — final storage delta

21. Inventory production objects via storage bridge (counts + bytes only in Git).
22. COPY new objects append-only; never overwrite hash-verified keys; never delete production.
23. Object count + bytes match: `________________` / `________________`

```bash
node aws/db-copy/rehearsal/scripts/bridge-storage-copy.mjs
```

### T3 — identity delta

24. Create Cognito users only for application UUIDs still unmapped, **on the production pool**.
25. Refuse `application_user_id === cognito_sub`.
26. Exclude ninth UUID from invites.
27. Record mapped user count (no emails in Git): `________________`

### T4 — point AWS API at reconciled DB (still no public DNS)

28. Snapshot RDS. Snapshot ID: `________________`
29. Attach production API (flags **still false**) to the reconciled database **or** promote rehearsal by rename — only after recon PASS.
30. Smoke on a non-public host / `staging.checksops.com` pattern: CheckOps / WhiteLabel / MortgageOps EMAIL_OTP, read paths, storage sign. **No money movement.**
31. `GET /health` 200 and `GET /ops/readiness` holds.ok.

### T5 — webhook dual-run (still no DNS)

32. Production webhooks **still** on Supabase.
33. Add AWS `/webhooks/moov` (and CheckAlt if in scope) as an **additional** subscriber with `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`.
34. Prove signature verify, duplicate event id, tenant mapping from provider account id (ignore payload `tenant_id`).
35. Dual-run clean window: `________________`
36. **Never** flip DNS and webhooks in the same step.

### T6 — frontend + DNS (only after T1–T5 PASS)

37. Deploy production SPA with Cognito + production API URL (not staging pool/client). Keep previous Lovable origin for rollback.
38. Change apex/`www` to production CloudFront **or** equivalent. Record previous targets first.
39. **Do not** flip Moov/CheckAlt execution flags in the same step as DNS.
40. Immediate post-DNS recon: `POST_CUTOVER_RECONCILIATION.md`.

### T7 — financial / provider activation (separate approval; may be later)

41. Named review of `deposit.submit`, `deposit.approve`, `disbursement.send`, wallet/stakeholder pay.
42. Apply `64_financial_activation_grants.sql` **only** on the production DB after that review.
43. Set `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=true` on production Lambda only.
44. `AWS_PROVIDER_LIVE_READS_ENABLED=true` (read-only).
45. `AWS_CHECKALT_ENABLED=true` only if vendor GO / exception is signed.
46. `AWS_MOOV_ENABLED=true`.
47. `AWS_PLAID_ENABLED` stays **false**.
48. `AWS_PROVIDER_EXECUTION_ENABLED=true` **last**.
49. First production money movement is dual-controlled, lowest risk, abortable. **Not this PR.**

### T8 — monitor (then, only after success, teardown)

50. CloudWatch Lambda errors/timeouts, API 5xx, Cognito auth failures.
51. Webhook receipts vs apply (`applied: false` until T7).
52. Financial aggregate drift vs T0.
53. Storage object count + bytes vs final inventory.
54. **Only after a stable successful cutover:** `BRIDGE_TEARDOWN.md`.

---

## Tripwires (stop and roll back)

Any one: unexpected production provider transaction; amount mismatch; duplicate provider object; webhook signature failures; identity mapping failures; financial aggregate drift; sandbox IDs written into production provider tables; `/health` not 200; `productionSupabaseChanged` true; any execution flag flipped before T7 approval.
