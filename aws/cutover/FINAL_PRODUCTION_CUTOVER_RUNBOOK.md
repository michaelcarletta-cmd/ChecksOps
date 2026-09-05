# Final production cutover readiness runbook

**DO NOT EXECUTE PRODUCTION CUTOVER FROM THIS DOCUMENT.**  
**DO NOT APPLY `64_financial_activation_grants.sql`.**  
**DO NOT CHANGE production DNS, webhooks, auth, Supabase/Lovable, Moov, or CheckAlt.**  
**DO NOT PERFORM production transactions.**

| Field | Value |
|---|---|
| Prepared | 2026-09-05 |
| Base commit | `main` after PR #127 (`19f6c196`) |
| Nature | Readiness audit + ordered procedure. Production activation remains disabled. |
| Overall | **PARTIAL** readiness / **BLOCKED** for executing production cutover |
| Plaid | **N/A — not used; not a cutover requirement** |

Temporary Lovable **DB** (`aws-staging-db-bridge`) and **Storage** (`aws-staging-storage-bridge`) bridges **must remain deployed**. They are the last-mile delta path on cutover night.

PR #127 proved production → AWS staging **data + storage** migration. This document is the next phase: whether ChecksOps AWS can become production, and the exact night-of sequence if a human later approves that.

---

## Scorecard

| Area | Status | Why |
|---|---|---|
| Data migration (DB overlay + recon) | **GO** | Isolated `checksops_rehearsal_20260905` matched live production counts, critical PKs (including `financial_stepup_log` 2/2), financial aggregates, identity, membership, FKs, required-null. Live `checksops` business data was not overwritten. |
| Storage migration | **GO** | 1,411 production objects / 2,565,912,220 bytes exact; 21 staging-only UAT objects left in place. |
| Remaining Supabase runtime deps | **GO** (normal non-financial) | Class A now includes `ingest-shared-check`, `homeowner-ledger-attach-upload`, and first-party `send-signature-request` (SES/sink). Money-movement / Stripe / QuickBooks stay disabled. Realtime remains polling. Production SPA is still `.env.production` Supabase-only. |
| Cognito EMAIL_OTP / WebAuthn | **GO** (EMAIL_OTP) / **PARTIAL** (production pool) | Staging EMAIL_OTP + WebAuthn proven. Production pool/SES/RP `checksops.com` **prepared, not created**. Passkeys not migrated. TOTP preferred-MFA not enabled. |
| Production AWS frontend/API config | **GO** (prepared) | Example production SAM/Cognito/WebAuthn params exist under `aws/cutover/production/`. Live SAM `Environment` AllowedValues remains **`staging` only**. `.env.production.aws.example` unused. **Not deployed.** |
| Tenant isolation / RLS | **GO** (ninth UUID) / **PARTIAL** (production switch) | Ninth UUID classified as fail-closed orphan (no email/Cognito). Staging RLS still fail-closed for that UUID. Production still uses Supabase RLS until DNS/API switch. |
| Smoke / recon / monitoring / rollback | **GO** (tooling) | `/ops/readiness`, `staging-smoke.mjs`, `rollback-dry-run.mjs` runnable without cutover. Production smoke transaction **not run** (forbidden). |
| Financial TOTP / step-up | **PARTIAL** | Cognito associate/verify enrollment prepared. Preferred MFA refused. `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`. Does not unlock money. |
| Final DB + storage delta (bridges) | **GO** (procedure) | Repeatable via remaining bridges. Timed write-freeze not measured. Overlay into isolated rehearsal first; never overwrite live `checksops` until a later approved swap. |
| DNS / CloudFront / API routing | **BLOCKED** (switch) | `staging.checksops.com` → CloudFront `d2p55gobpvrxya.cloudfront.net`. Apex/`www` remain Lovable. Do not change Cloudflare apex until every other GO gate is signed. |
| Moov webhook / provider | **PARTIAL** | Sandbox certification **PASS** (2026-09-04, PR #124) including Lambda egress. Production `AWS_MOOV_ENABLED` / master execution **false**. Production webhooks still on Supabase. Dual-run not started. |
| CheckAlt | **PARTIAL** | Treat UAT as **pending vendor IQA**. Auth/egress historically OK; approved UAT deposit account / depositor `ssoKey` still required. PR #125 remains untouched. Production CheckAlt flags **false**. |
| Plaid | **N/A** | Not used. Keep `AWS_PLAID_ENABLED=false`. Missing Plaid keys are not a blocker. |
| Financial activation / grants | **GO (hold)** | `64_financial_activation_grants.sql` is a no-op `NOT_APPLIED` stub. CI refuses auto-apply. `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`. **BLOCKED** to activate until human approval. |

**ChecksOps AWS overall for production cutover: BLOCKED.**  
Data/storage rehearsal **GO** does **not** authorize DNS, auth, webhook, Moov, CheckAlt, or financial activation.

---

## Remaining production blockers

Must be resolved (or explicitly waived in writing) **before** any production cutover:

1. **Human approval** to leave Lovable/Supabase as system of record — not granted.
2. **Production Cognito user pool + app client** with EMAIL_OTP + WEB_AUTHN, `RelyingPartyId=checksops.com`, SES/Cognito email delivery for real mailboxes (not Tester intercept). SAM still forbids `Environment=production`.
3. **Identity import** of every production user who must sign in: `identity_accounts` maps `cognito_sub → application_user_id` with `sub ≠ application UUID`. Do not mint UUIDs from Cognito subs.
4. **Passkey re-enrollment** — production SimpleWebAuthn credentials in `user_passkeys` are excluded from migration. Communicate EMAIL_OTP-first, then register Cognito passkeys on `https://checksops.com`.
5. **Production frontend env + deploy** — Cognito + API Gateway URL on the production SPA (see `.env.production.aws.example`). Today `.env.production` is Supabase-only.
6. **Production API stack** — separate Lambda/HTTP API (not the staging stack), production secrets only, flags still **false** until the ordered activation below.
7. **Final write-freeze + bridge delta** on cutover night (DB overlay + storage COPY) with recon PASS. Bridges must still be deployed.
8. **Cognito identity delta** for users created after the last rehearsal overlay.
9. **Moov production** — production keys/IDs (never sandbox IDs), webhook dual-run, then flags. Sandbox PASS is not production GO.
10. **CheckAlt vendor IQA** — approved UAT deposit account + depositor `ssoKey` **or** a signed exception that CheckAlt stays disabled at DNS cut (deposits remain on Supabase until then — usually unacceptable).
11. **Financial grants** — apply `64_financial_activation_grants.sql` only after webhook dry-run + named review. Not in this PR.
12. **TOTP / financial step-up** — Enrollment APIs exist; preferred MFA stays off so EMAIL_OTP login is unchanged. Accept EMAIL_OTP/WebAuthn-only at DNS cut **or** enable preferred MFA later. Never treat step-up as money authority while flags are false.
13. **Workflow invoke gaps on AWS** — Stripe/QuickBooks/money-movement remain non-Class-A. `ingest-shared-check`, `homeowner-ledger-attach-upload`, and first-party e-sign are ported. Apply `70_ingest_shared_check.sql` on staging before live partner ingest (RLS). CheckAlt stays on PR #125.
14. **Realtime** — AWS is polling fallback. Accept 15s poll or add a later realtime design.
15. **Timed write-freeze drill** — never measured against live production freeze. Budget ~45–110 min pre-DNS from rehearsal.

Non-blockers:

- **Plaid**
- Ninth UUID `dd24eea5-…` (classified fail-closed orphan; do not invite)
- Cosmetic `profiles.preferred_auth_method` on AWS (Cognito replaced it)
- Staging-only UAT S3 extras (21 objects)
- Moov sandbox certification (already PASS; still not production activation)

---

## Current production vs AWS (do not switch)

| Surface | Production today | AWS staging today |
|---|---|---|
| Frontend | Lovable / `.env.production` → Supabase | `https://staging.checksops.com` CloudFront `E1CG52WRQZI7X1` |
| API | Supabase Edge + PostgREST | `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging` |
| Auth | Supabase Auth + SimpleWebAuthn + MFA | Cognito EMAIL_OTP + WebAuthn (`us-east-1_vPmQ7cL1F`), RP ID `staging.checksops.com` |
| DB | Production Supabase Postgres | RDS `checksops` (UAT + overlay rehearsal DB `checksops_rehearsal_20260905`) |
| Files | Supabase Storage | S3 `files/{bucket}/…` |
| Moov / CheckAlt webhooks | Supabase functions | AWS `/webhooks/{moov,checkalt}` **dry-run**; production URLs not redirected |
| Provider flags | N/A (Lovable live money) | All production execution flags **false** |

---

## Exact ordered cutover procedure

**Do not start this sequence until every blocker above is GO or waived.** Fill blanks at execution time. This PR does not run it.

### T−7 to T−1 (still no DNS / no flags)

1. Confirm both Lovable bridges still `mode: read_only` (DB) and Storage COPY-only (no deletes).
2. Confirm staging Lambda flags still false: `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`.
3. Confirm `64_financial_activation_grants.sql` was **not** applied (`SELECT 'NOT_APPLIED'`).
4. Production Cognito pool ID: `________________` (must not be `us-east-1_vPmQ7cL1F` staging).
5. Production API URL: `________________`
6. Production frontend bundle SHA: `________________`
7. Announce user-visible passkey re-enrollment + EMAIL_OTP.
8. Capture pre-cutover financial aggregates (report-only) on production and on isolated rehearsal.

### T0 — write-freeze (production still on Lovable)

9. Enable application write-freeze (maintenance / flag) so no new checks, deposits, disbursements, ledger rows, or storage objects land.
10. Freeze Auth invites / password resets that would desync identity maps.
11. **Do not** redirect Moov/CheckAlt webhooks yet.
12. **Do not** change apex DNS yet.

### T1 — final DB delta (bridges)

13. `POST` DB bridge `health` — require `mode: read_only`, writes/deletes/rpc/rawSql **false**.
14. Keyset-page approved tables; classify insert/update/delete vs last rehearsal.
15. Reconstruct full rows for changed PKs; omit `[redacted]` secrets; keep SQL NULL.
16. Upload overlay JSON to private S3; record SHA-256: `________________`
17. Overlay into a **new** isolated `checksops_rehearsal_YYYYMMDD` (or swap-ready clone). **Do not overwrite live `checksops` UAT identity until swap is approved.**
18. Recon must PASS: counts, PK fingerprints, financial aggregates, identity, membership, FKs, required-null, `financial_stepup_log`.

### T2 — final storage delta

19. Inventory production objects via storage bridge (counts + bytes only in Git).
20. COPY new objects append-only; never overwrite hash-verified keys; never delete production.
21. Object count + bytes match: `________________` / `________________`

### T3 — identity delta

22. Create Cognito users only for application UUIDs still unmapped.
23. Refuse `application_user_id === cognito_sub`.
24. Record mapped user count (no emails in Git): `________________`

### T4 — point AWS API at reconciled DB (still no public DNS)

25. Snapshot RDS. Snapshot ID: `________________`
26. Attach production API (flags **still false**) to the reconciled database **or** promote rehearsal by rename — only after recon PASS.
27. Smoke on a non-public host: CheckOps / WhiteLabel / MortgageOps login (EMAIL_OTP), read paths, storage sign. **No money movement.**

### T5 — webhook dual-run (still no DNS)

28. Production webhooks **still** on Supabase.
29. Add AWS `/webhooks/moov` (and CheckAlt if in scope) as an **additional** subscriber with `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`.
30. Prove signature verify, duplicate event id, tenant mapping from provider account id (ignore payload `tenant_id`).
31. Dual-run clean window: `________________`

### T6 — frontend + DNS (only after T1–T5 PASS)

32. Deploy production SPA with Cognito + production API URL (not staging pool/client).
33. Keep previous Lovable origin for rollback.
34. Change apex/`www` to production CloudFront **or** equivalent. Record previous targets: `________________`
35. **Do not** flip Moov/CheckAlt execution flags in the same step as DNS.

### T7 — financial / provider activation (separate approval; may be later)

36. Named review of `deposit.submit`, `deposit.approve`, `disbursement.send`, wallet/stakeholder pay.
37. Apply `64_financial_activation_grants.sql` **only** on the production DB after that review.
38. Set `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=true` on production Lambda only.
39. `AWS_PROVIDER_LIVE_READS_ENABLED=true` (read-only).
40. `AWS_CHECKALT_ENABLED=true` only if vendor IQA / exception is signed.
41. `AWS_MOOV_ENABLED=true`.
42. `AWS_PLAID_ENABLED` stays **false** (not required).
43. `AWS_PROVIDER_EXECUTION_ENABLED=true` **last**.
44. First production money movement is dual-controlled, lowest risk, abortable. **Not this PR.**

### T8 — monitor

45. CloudWatch Lambda errors/timeouts.
46. `aws_financial_audit` / reconciliation findings.
47. Provider dashboard vs internal pending.
48. Financial aggregate drift vs T0 snapshot.

---

## Exact rollback procedure

**Rollback point A — before DNS/webhook switch:** production never left Lovable.

1. Leave/restore DNS to Lovable/Supabase frontend + API.
2. Do not redirect provider webhooks (they never moved).
3. Lift write-freeze only after Supabase health.
4. Drop failed `checksops_rehearsal_*` only. Never drop production Supabase. Never drop live staging `checksops` unless that was the failed swap target.
5. Leave S3 copies in place (append-only).
6. Disable Cognito users created only for the failed wave.
7. Bridges stay deployed for a later retry.

**Rollback point B — after DNS, flags still OFF:**

1. Revert apex/`www` DNS to recorded Lovable targets.
2. Keep AWS S3/RDS (no destructive rollback).
3. Users sign in on Supabase Auth again (Cognito passkeys unused).
4. Reconcile any AWS writes during the window (should be near-zero if flags stayed false).

**Rollback point C — after provider flags ON (money risk):**

1. Set `AWS_PROVIDER_EXECUTION_ENABLED=false` immediately (no deploy required).
2. Set `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` false.
3. Restore webhook URLs to last known-good Supabase endpoints.
4. Restore DNS to Lovable if the SPA cannot run disabled.
5. Leave ledgers and provider objects intact; do not delete Moov/CheckAlt objects.
6. Reconcile; do not auto-correct amounts.

Tripwires (any one): unexpected production provider transaction, amount mismatch, duplicate provider object, webhook signature failures, identity mapping failures, financial aggregate drift, sandbox IDs written into production provider tables.

---

## Cognito EMAIL_OTP / WebAuthn transition (and rollback)

**Staging (proven):** CheckOps, WhiteLabel, and MortgageOps use Cognito EMAIL_OTP + WebAuthn on `https://staging.checksops.com`. Homeowner `/h/upload` uses AWS OTP functions (not a Cognito SPA session). Mapping: `cognito_sub → identity_accounts.application_user_id → auth.uid()`.

**Production transition (future):**

1. New user pool; do not reuse staging pool `us-east-1_vPmQ7cL1F`.
2. RP ID / origin `checksops.com` / `https://checksops.com` (and `www` if that is the canonical host — pick one RP ID).
3. Import/link users to existing application UUIDs.
4. First login: EMAIL_OTP (or temporary password for master/UAT only).
5. Users register new Cognito passkeys. Old Supabase passkeys stay in production DB unused.
6. TOTP step-up: either ship Cognito MFA later or accept EMAIL_OTP/WebAuthn until financial activation.

**Rollback:** if DNS is still Lovable, no Cognito production rollback is required. If DNS already moved, revert DNS; Supabase Auth remains the credential store for production passkeys/MFA.

Frontend/API now read WebAuthn origin from `VITE_APP_URL` / `COGNITO_WEBAUTHN_ORIGIN` with **default `https://staging.checksops.com`**. Production origin is **not** enabled in the staging template.

---

## Final DB + storage delta (keep bridges)

Worker:

```bash
# Storage (append-only COPY; token from Secrets Manager — never commit):
node aws/db-copy/rehearsal/scripts/bridge-storage-copy.mjs

# DB delta + isolated rehearsal overlay (does not overwrite checksops):
node aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs
```

DB bridge: `POST https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge`  
Require `mode: read_only`. Do not tear down either function after this PR.

---

## Monitoring (cutover window)

| Signal | Where |
|---|---|
| Lambda errors / timeouts | CloudWatch `checksops-*-api` |
| Auth failures | Cognito metrics + `/identity/me` 401 `identity_not_linked` |
| Webhook receipts vs apply | `/webhooks/*` dry-run `applied: false` until T7 |
| Financial drift | `aws/rls/sql/28_financial_aggregates.sql` vs T0 |
| Storage | object count + bytes vs bridge inventory |
| Isolation | Freedom vs C1C vs unmapped UUID = 0 rows |

---

## Safe preparation in the accompanying PR (activation still disabled)

- Class A: `ingest-shared-check`, `homeowner-ledger-attach-upload`, first-party `send-signature-request` (SES/sink, no Lovable).
- Production SAM/Cognito/WebAuthn/EMAIL_OTP **examples only** (`aws/cutover/production/`). Live template still forbids `Environment=production`.
- Ninth UUID classified as fail-closed orphan. Identity import dry-run refuses `--apply`.
- TOTP enrollment routes prepared; preferred MFA and financial flags stay false.
- `/ops/readiness`, staging-smoke, rollback dry-run (no production changes).
- `.env.production.aws.example` — placeholders only; `.env.production` unchanged (Supabase).
- WebAuthn origin/RP ID with **staging defaults**; apex origin still 403 unless env is later pointed at production.
- Tests lock flags, `64` stub, Plaid non-requirement, Class A registry, and default WebAuthn origin.

Not in this PR: production Cognito pool deploy, DNS, webhook redirect, `64` grants, provider flag flips, PR #125, bridge teardown, Plaid enablement, production cutover.
