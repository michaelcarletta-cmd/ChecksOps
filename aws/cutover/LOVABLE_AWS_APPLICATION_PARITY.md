# Lovable → AWS application parity audit

**STOP FOR REVIEW.** This document is a read-only classification. It does **not** implement ports, merge PRs, freeze production, change DNS/auth, import users, redirect webhooks, enable Moov/CheckAlt, or apply `64_financial_activation_grants.sql`.

Audit date: 2026-09-06  
Published Lovable: `https://checksops.com` deployment `d5e0b627-fe28-449c-b44c-ffcd73b5bdf7` (`/assets/index-U9NpDj7H.js`)  
GitHub AWS architecture source of truth: `origin/main` `8a9181ae` (includes PR **#132**)  
Live schema probe: read-only `aws-staging-db-bridge` (`mode: read_only`, writes/rpc/rawSql false)

## LOVABLE → AWS APPLICATION PARITY: **FAIL**

Published Lovable and GitHub `src/` are the **same product surface** (routes, pages, and 69 live Edge Function names). The completed AWS architecture already covers Moov/CheckAlt **handlers** (flags stay false), Class A mailer/OCR/HomeownerOps, returned-check RPCs, and PR #132 e-sign send + ingest.

Parity still **FAIL** because several **live product workflows** have no AWS equivalent (or public submit remains `writes_disabled`). Those must be ported to the AWS implementation — not by copying Supabase Auth/RLS/Edge patterns.

PR **#125** stays open and unmerged (CheckAlt UAT / VOID tracker). Do not revive superseded migration PRs.

---

## Method

| Source | Role |
|---|---|
| Live published SPA (main + 94 lazy chunks) | Current product experience |
| `origin/main` `src/` + `supabase/functions` + `supabase/migrations` | What Lovable shipped into GitHub (157 bot commits since 2026-09-01) |
| `origin/main` `aws/functions` + `aws/write-path` + rehearsal docs | Completed AWS architecture |
| Read-only DB bridge `schema` / `health` | Live tables/columns **without** writing production |

This branch (`cursor/production-prep-readiness-9053` / this audit branch) is **behind** `origin/main` for PR #132 (`ingest-shared-check`, `send-signature-request`, `homeowner-ledger-attach-upload`). Those are **ALREADY IN AWS** on `main`. Do not treat this prep branch as the AWS source of truth.

No unpublished Lovable-only product UI was found after the last GitHub Lovable `src/` commits (2026-09-05). Live-only invoke names `notify-homeowner-lead` and `public-invoice` exist on GitHub; GitHub-only invokes (`quickbooks-*`, `tenant-credit-topup`, …) are tree-shaken from the published bundle or billing panels not loaded in the chunks downloaded.

---

## Classification legend

| Status | Meaning |
|---|---|
| **ALREADY IN AWS** | Behavior exists on `origin/main` AWS (handler, RPC bridge, or Cognito replacement). Flags may still be false. |
| **NEEDS PORTING TO AWS** | Live (or GitHub SPA) product behavior has no AWS implementation. Port to Lambda/Cognito/SES/RDS — do not copy Supabase internals. |
| **LOVABLE/SUPABASE-SPECIFIC — DO NOT PORT DIRECTLY** | Auth JWT/`auth.uid()`, SimpleWebAuthn tables, vault/pg_net/pg_cron, migration bridges. |
| **INTENTIONALLY SUPERSEDED BY AWS** | Cognito EMAIL_OTP/WebAuthn, 15s polling, Stripe/QBO fail-closed, sandbox isolation, header spoof ignore. |
| **NEEDS HUMAN REVIEW** | Product intent is clear; cutover-night vs later-night, or Cognito MFA posture, needs an operator decision. |

Layer tags: `CODE ONLY` · `SCHEMA/DATABASE` · `STORAGE` · `EDGE FUNCTION/BACKEND` · `CONFIGURATION` (or a combination).

**Data capture:** existing DB/storage delta (bridge overlay + S3 COPY) captures **row/object data** for tables/columns that already exist on the AWS target. Overlay **intersects** live keys with writable RDS columns — extra live columns are silently dropped if AWS schema is missing them. Function/trigger **bodies** are **not** in the overlay.

---

## 1. Pages, routes, UI, styling

| Item | Status | Layer | Data delta? |
|---|---|---|---|
| Marketing + auth routes (`/`, `/login`, `/signup`, `/account/security`, `/reset-password`, `/pricing`, `/security`, `/privacy-notice`, `/terms`) | ALREADY IN AWS | CODE ONLY | n/a |
| Public token routes (`/sign`, `/endorse`, `/payment-direction/:token`, `/verify-account/*`, `/pay-setup/:token`, `/h/upload`, `/h/claim/:token`, `/ledger/:token`, `/start-claim/:token`, `/invoice/:token`, `/unsubscribe`) | ALREADY IN AWS | CODE ONLY | n/a |
| Admin (`/admin/tenants`, `/admin/mortgage-ops`, `/admin/financial-model`) | ALREADY IN AWS | CODE ONLY | n/a |
| MortgageOps (`/mortgage-ops/login`, `/mortgage-ops/queue`) | ALREADY IN AWS | CODE ONLY | n/a |
| White-label `/:slug/{login,checks,payments,cash-jobs,wallet-ops,settings}` | ALREADY IN AWS | CODE ONLY | n/a |
| Returned-check UI (`ReturnedChecksPanel`, `MarkCheckReturnedDialog`, live chunk `ReturnedChecksPanel-B3mSVKFw.js`) | ALREADY IN AWS | CODE ONLY | rows via overlay if columns exist |
| Homeowner ledger / Funds / recipient pay-setup | ALREADY IN AWS | CODE ONLY | overlay |
| Passkey / Account Security UI still talking to `passkey-*` + `preferred_auth_method` | INTENTIONALLY SUPERSEDED BY AWS (Cognito `/auth/passkey/*`) | CODE ONLY + CONFIGURATION | do not copy `user_passkeys` |
| Live CSS/JS content-hash ≠ GitHub | ALREADY IN AWS | CODE ONLY | Vite hash only; feature set matches `src/` |
| Responsive / settings design system (WalletOps hero/cards) | ALREADY IN AWS | CODE ONLY | shipped in GitHub `src/` before/during migration |

No new live route exists that is missing from `src/App.tsx` / `WhiteLabelApp.tsx`.

---

## 2. Forms, validation, workflows

| Item | Status | Layer | Data delta? |
|---|---|---|---|
| Check intake / OCR / endorsement checklist (read + DB writes allowlisted) | ALREADY IN AWS | CODE + EDGE | overlay + `/data` writes |
| In-app / in-person `functions.invoke("check-endorsement")` (CheckCommandCenter, EndorsementChecklist, InPersonSignatureDialog) | **NEEDS PORTING TO AWS** | EDGE FUNCTION/BACKEND | endorsement rows overlay; **submit path missing** |
| Public `/endorse` GET | ALREADY IN AWS (`POST /public/endorsement` read-only) | EDGE | token tables overlay |
| Public endorsement **submit/reject** and `/public/signature-submit` | **NEEDS PORTING TO AWS** (still `writes_disabled` on `origin/main`) | EDGE FUNCTION/BACKEND | n/a until handler exists |
| `send-signature-request` (email a signer) | ALREADY IN AWS (PR #132 `esign.mjs`) | EDGE | signer rows overlay |
| `send-payment-direction-request` (`src/lib/endorsementWorkflow.ts`; not in published main chunk but **is** on GitHub SPA) | **NEEDS PORTING TO AWS** | EDGE + CODE | direction rows overlay; email is SES Class A |
| `record_check_return` / `resolve_check_return` | ALREADY IN AWS (`workflow-rpc.mjs` `safe_now`) | EDGE + SCHEMA | overlay captures `returned_*` if RDS has columns (Sept 1 dump timing) |
| `check-reconciliation` + Loss Prevention “Run reconciliation” | **NEEDS PORTING TO AWS** | EDGE FUNCTION/BACKEND | `check_reconciliation_alerts` table already on live + staging inventory; **writer missing** |
| `ingest-shared-check` | ALREADY IN AWS (PR #132) | EDGE | overlay |
| `homeowner-ledger-attach-upload` | ALREADY IN AWS (PR #132) | EDGE + STORAGE | overlay + S3 COPY |
| Homeowner ledger view/send/upload/sign-link/claim/upload-check | ALREADY IN AWS (Class A) | EDGE + STORAGE | overlay + S3 |
| Payee → endorsement mirror (Sept 3 `tg_mirror_payee_to_endorsement`) | **NEEDS PORTING TO AWS** | SCHEMA/DATABASE | **DDL/function body not in overlay** |
| Deposit ops / CheckAlt submit UI | ALREADY IN AWS (handlers; execution flags false) | EDGE + CONFIGURATION | overlay; do not enable execution |
| Moov onboarding / recipient `/pay-setup` / disbursement UI | ALREADY IN AWS (sandbox_parity; flags false) | EDGE + CONFIGURATION | overlay; sandbox isolation is intentional |
| MortgageOps **Bill** (`bill-mortgage-handling`) | **NEEDS PORTING TO AWS** | EDGE + SCHEMA | fee line-item rows overlay; **do not enable Stripe/Moov charge** |
| Stripe usage / credit top-up / maintenance subscription | INTENTIONALLY SUPERSEDED BY AWS (fail-closed on #132) | EDGE + CONFIGURATION | billing rows overlay; live Stripe stays off |
| QuickBooks connect/payment | INTENTIONALLY SUPERSEDED BY AWS (fail-closed) | EDGE + CONFIGURATION | n/a |
| Realtime subscriptions | INTENTIONALLY SUPERSEDED BY AWS (15s polling) | CODE ONLY | n/a |

---

## 3. Database (tables, columns, functions, triggers, RLS)

Live bridge schema (2026-09-06): **181** listed relations; `mode: read_only`.

| Item | Status | Layer | Data delta? |
|---|---|---|---|
| Returned-check columns on `check_intake_items` + `checkalt_deposits` + enum `returned` | ALREADY IN AWS (in Sept 1 dump window; live columns confirmed) | SCHEMA/DATABASE | **overlay captures values only if RDS columns exist** (apply intersects writable columns). Rehearsal 2026-09-06 count/PK/financial recon **PASS** — does not prove every `returned_*` value was copied. Spot-check before T0. |
| `financial_stepup_log` | ALREADY IN AWS (`37_financial_stepup_log.sql`; 2/2 overlay) | SCHEMA/DATABASE | captured |
| `profiles.preferred_auth_method` / `passkey_enrolled_at` / `totp_enrolled_at` / `password_login_disabled` | INTENTIONALLY SUPERSEDED BY AWS (column present live; **not** added to AWS; write allowlist `clientIgnored`) | SCHEMA + CONFIGURATION | **do not add** for cosmetic parity |
| `user_passkeys` / `webauthn_challenges` | LOVABLE/SUPABASE-SPECIFIC — DO NOT PORT DIRECTLY | SCHEMA | excluded from copy; Cognito owns credentials |
| Sept 3 `tg_mirror_payee_to_endorsement` (rename deletes stale unsigned rows; no duplicate endorsements) | **NEEDS PORTING TO AWS** | SCHEMA/DATABASE | **code change required before cutover** — overlay does not replace function bodies. Staging trigger **count** matches live (211); body may still be pre-Sept-3. |
| Email-queue type fix (Sept 4 Lovable) | INTENTIONALLY SUPERSEDED BY AWS (`process-email-queue` SES/sink) | EDGE | queue rows overlay |
| Live views (`check_dashboard_counts`, deposit KPI views, `tenants_public`, …) | ALREADY IN AWS (present as views on dump/TEMPLATE; listed as live-only vs Sept 4 **tableCounts** because those are views) | SCHEMA | views are not overlayed as tables |
| RLS `auth.uid()` policies | LOVABLE/SUPABASE-SPECIFIC — DO NOT PORT DIRECTLY | SCHEMA | AWS uses Cognito → `identity_accounts` → `request.app_user_id` |
| `pg_cron` / `pg_net` / vault / pgmq | LOVABLE/SUPABASE-SPECIFIC — DO NOT PORT DIRECTLY | SCHEMA + EDGE | EventBridge + Secrets Manager + SES |
| New live **base tables** since AWS inventory | none found (bridge “live-only” set is views + `financial_stepup_log`) | — | existing 161-table overlay still the data path |

---

## 4. Edge Functions / backend

Live published SPA invokes **69** named functions. On `origin/main`, **66** have a Class A handler, provider catalog/parity handler, or Cognito/public replacement.

**Live invokes with no AWS handler name:**

| Function | Status | Layer | Notes |
|---|---|---|---|
| `check-endorsement` (authenticated invoke) | **NEEDS PORTING TO AWS** | EDGE | Public GET exists; in-app invoke hits `/functions/v1/check-endorsement` → `provider_disabled` / 403 |
| `check-reconciliation` | **NEEDS PORTING TO AWS** | EDGE | Class A ops writer → `check_reconciliation_alerts` |
| `admin-reset-totp` | **NEEDS PORTING TO AWS** (behavior) / **DO NOT PORT DIRECTLY** (Supabase `auth.admin.mfa.deleteFactor`) | EDGE + AUTH | Wire Cognito admin MFA/WebAuthn reset to the same UI invoke |
| `bill-mortgage-handling` | **NEEDS PORTING TO AWS** | EDGE | Class C; Stripe best-effort + `platform_fee_line_items`; keep flags false |
| `send-payment-direction-request` | **NEEDS PORTING TO AWS** | EDGE | GitHub SPA; SES Class A equivalent of `send-transactional-email` |

`passkey-register-*` / `passkey-auth-*`: **INTENTIONALLY SUPERSEDED BY AWS** (Cognito WebAuthn).  
Moov/CheckAlt names: **ALREADY IN AWS** (`sandbox_parity`); production execution **OFF**.  
Class A mailer/OCR/PDF/HomeownerOps/tenant invite/domain/BYOK: **ALREADY IN AWS**.

Migration bridges `aws-staging-db-bridge` / `aws-staging-storage-bridge`: **LOVABLE/SUPABASE-SPECIFIC** — keep until after cutover; do not remove.

---

## 5. Storage

| Item | Status | Layer | Data delta? |
|---|---|---|---|
| Production objects (1,411 / 2,565,912,220 bytes at 2026-09-06 rehearsal) | ALREADY IN AWS | STORAGE | append-only COPY; `RECONCILE_TO_LIVE=1` |
| New objects after rehearsal | ALREADY IN AWS (process) | STORAGE | final-delta COPY only; no app code |
| Homeowner uploads / endorsement packets / claim-files | ALREADY IN AWS | STORAGE + EDGE | COPY + `/storage/*` |
| `user_passkeys` files N/A | — | — | credentials are not storage objects |

No new live buckets are required for parity.

---

## 6. Email / SMS / documents

| Item | Status | Layer | Data delta? |
|---|---|---|---|
| SES transactional + queue + unsubscribe | ALREADY IN AWS | EDGE + CONFIGURATION | queue/suppression overlay |
| SMS sink | ALREADY IN AWS | EDGE + CONFIGURATION | audit only until Telnyx/Pinpoint approved |
| PDF / endorsement packet / invoice generate | ALREADY IN AWS (Class A) | EDGE + STORAGE | generated objects via S3 |
| `send-payment-direction-request` | **NEEDS PORTING TO AWS** | EDGE | see §4 |
| Production Resend webhooks | LOVABLE/SUPABASE-SPECIFIC | EDGE | SES/SNS on AWS |

---

## 7. Moov and CheckAlt

| Item | Status | Layer | Data delta? |
|---|---|---|---|
| All production-required Moov/CheckAlt **function names** | ALREADY IN AWS | EDGE | sandbox isolation intentional |
| Production execution | INTENTIONALLY SUPERSEDED BY AWS (flags false) | CONFIGURATION | do not enable for this parity port |
| CheckAlt VOID IQA | NEEDS HUMAN REVIEW (UAT tracker #125; **not** an application-port gap) | CONFIGURATION | leave #125 open |
| `moov-account-file-view` URL vs path | INTENTIONALLY SUPERSEDED / documented behavioral difference | EDGE | n/a |
| Recipient onboarding (Sept 1–2 Lovable) | ALREADY IN AWS | EDGE + CODE | overlay |

---

## 8. Authentication / account management

| Item | Status | Layer | Data delta? |
|---|---|---|---|
| Cognito EMAIL_OTP + WebAuthn (CheckOps / WhiteLabel / MortgageOps) | INTENTIONALLY SUPERSEDED BY AWS | EDGE + CONFIGURATION | do not import production users in this audit |
| Lovable magic-link / `preferred_auth_method` | INTENTIONALLY SUPERSEDED BY AWS | CODE + SCHEMA | ignore column |
| SimpleWebAuthn `passkey-*` + `user_passkeys` | LOVABLE/SUPABASE-SPECIFIC — DO NOT PORT DIRECTLY | SCHEMA + EDGE | Cognito credentials |
| Admin “Reset 2FA” button (`admin-reset-totp`) | **NEEDS PORTING TO AWS** as Cognito admin reset | EDGE + AUTH | no Supabase factor rows to copy |
| Production Cognito MFA | currently OFF | CONFIGURATION | **NEEDS HUMAN REVIEW**: button behavior at DNS cut if MFA stays off |
| Recovery hash redirect / reset password | ALREADY IN AWS (Cognito confirm-forgot) | CODE | n/a |
| Tenant invite / create-tenant-user | ALREADY IN AWS (Cognito Admin) | EDGE | membership overlay |

---

## 9. Tenant / admin / security / compliance

| Item | Status | Layer | Data delta? |
|---|---|---|---|
| Admin tenants / mortgage hire / financial model pages | ALREADY IN AWS | CODE + EDGE | overlay |
| Domain verify/check | ALREADY IN AWS | EDGE + CONFIGURATION | n/a |
| OpenAI BYOK | ALREADY IN AWS (Secrets Manager) | EDGE + CONFIGURATION | do not copy vault rows |
| Step-up audit `financial_stepup_log` | ALREADY IN AWS | SCHEMA + CODE | overlay |
| `check-reconciliation` Loss Prevention | **NEEDS PORTING TO AWS** | EDGE | alerts table exists |
| GLBA purge / storage-backup crons | LOVABLE/SUPABASE-SPECIFIC / Class D | EDGE | not required for SPA parity |

---

## 10. API integrations / configuration

| Item | Status | Layer | Data delta? |
|---|---|---|---|
| `.env.production` remains Supabase | INTENTIONALLY SUPERSEDED BY AWS until T6 | CONFIGURATION | do not switch in this audit |
| `VITE_AUTH_PROVIDER=cognito` on staging | ALREADY IN AWS | CONFIGURATION | n/a |
| Provider flags all false on prep | ALREADY IN AWS | CONFIGURATION | keep |
| Freedom embed bootstrap | ALREADY IN AWS | CODE ONLY | n/a |
| Cross-app ingest bridge secret | ALREADY IN AWS (PR #132) | CONFIGURATION + EDGE | n/a |

---

## Controlled delta implementation plan (do **not** implement yet)

Work from **`origin/main`** (has #132). New PR only. Do **not** merge #125. Do **not** overlay staging Lambda as production. Do **not** apply financial grants.

1. **Safe Class A ports** (same dispatch pattern as `app-services.mjs`):
   - `check-reconciliation` — service-role-equivalent RDS writes to `check_reconciliation_alerts` only; reuse `get_stuck_checks` / `get_all_checks_safety_net` via existing RPC allowlist.
   - `send-payment-direction-request` — SES/sink template; no provider HTTP.
   - Authenticated `check-endorsement` — record in-person/staff endorsement **without** calling `advance_check_on_endorsement_complete` / CheckAlt.
   - Public `/public/endorsement` submit + `/public/signature-submit` — persist signature; keep deposit-stage cascade denied until a later financial night.
2. **Schema (AWS SQL, not a blind Supabase migration replay):**
   - Replace `public.tg_mirror_payee_to_endorsement()` with the Sept 3 body (`20260903184833_…sql`) on RDS.
   - Spot-check `check_intake_items.returned_*` / `checkalt_deposits.return_*` exist on the cutover target; add AWS DDL only if a column is missing (overlay will not invent columns).
3. **Auth/security:**
   - New `admin-reset-totp` AWS handler: Cognito `AdminSetUserMFAPreference` / delete software token + WebAuthn credential for the mapped `application_user_id`. Do **not** call Supabase Auth MFA APIs. No-op with a clear error if the user has no Cognito MFA factor (current production pool MFA OFF).
4. **Financial/provider (handler only, flags false):**
   - `bill-mortgage-handling` — persist `platform_fee_line_items` when `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` is false? **No.** Implement the function body behind the existing provider/financial flag gate; return `403 production_execution_blocked` / `provider_disabled` until the later T7 night. That is still a **port** (named handler + tests) so the SPA does not look like an unknown 403.
5. Tests: Class A unit tests + fail-closed financial tests. No live Moov/CheckAlt/Stripe.
6. Do not copy `user_passkeys`, `preferred_auth_method`, Resend, or bridge functions into AWS.

---

## Timed rehearsal validity

The 2026-09-06 freeze-free rehearsal (**45 min** customer-facing / **25–35 min** freeze-critical) remains **valid for timing and data-path mechanics**.

| After these parity ports | Repeat full timed rehearsal? |
|---|---|
| Class A / endorsement / payment-direction / Cognito admin-reset **code only** | **No** — does not change overlay/COPY duration |
| Sept 3 trigger function replace | **No** for the 45-min window; run an isolated RDS function-body check, not a full storage re-hash |
| New columns on overlayed tables (only if spot-check finds a miss) | **Partial** — isolated overlay recon for those tables; not a full 11-minute storage hash |
| Enabling Moov/CheckAlt/financial grants | Out of scope; would be a **later night**, not this parity PR |

Do **not** treat this FAIL as a reason to discard the measured 2:55 DB capture / 42 s overlay numbers.

---

## Numbered FAIL list (must port before PASS)

### Safe / non-financial

1. Port **authenticated** `check-endorsement` (in-app + in-person) to AWS `/functions/v1/check-endorsement` without deposit-stage / provider cascade.
2. Enable **public endorsement submit** and **`/public/signature-submit`** on AWS (today `writes_disabled` on `origin/main`); keep `advance_check_on_endorsement_complete` denied.
3. Port **`check-reconciliation`** to Class A (write `check_reconciliation_alerts` only).
4. Port **`send-payment-direction-request`** to SES/sink Class A (GitHub SPA still invokes it).
5. Apply Sept 3 **`tg_mirror_payee_to_endorsement`** function body on AWS RDS (schema/function; overlay will not do this).
6. Before T0, **spot-check** AWS target columns `check_intake_items.returned_*` and `checkalt_deposits.return_*` so overlay does not silently drop return metadata.

### Auth / security

7. Replace **`admin-reset-totp`** with a **Cognito** admin MFA/WebAuthn reset handler (same invoke name). Do not port Supabase `auth.admin.mfa.deleteFactor`. Confirm intended UX while production Cognito MFA is OFF.

### Financial / provider

8. Add an AWS **`bill-mortgage-handling`** handler behind existing financial/provider flags (persist-or-deny explicitly). Do **not** enable Stripe/Moov charges, do **not** apply `64_financial_activation_grants.sql`, do **not** merge #125.

---

## Explicit non-goals (not FAIL items)

- Moov/CheckAlt **execution** (handlers exist; flags stay false)
- Copying SimpleWebAuthn / `preferred_auth_method` / Supabase RLS
- Stripe/QBO live charges (fail-closed is intentional)
- Realtime websocket (15s polling accepted)
- Removing DB/storage bridges
- Importing production Cognito users
- DNS/auth cutover
- Merging outstanding PRs for parity
