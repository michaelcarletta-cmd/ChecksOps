# ChecksOps AWS production launch-readiness audit

**2026-09-09.** READ-ONLY. STOP FOR REVIEW. No code, migration, flag, DNS, WAF, Gate 3D, Cognito, RDS, or provider execution changes were made.

API perimeter is treated as complete per the privileged-operator Gate 3D validation. This audit does **not** re-open perimeter work.

Hard holds observed live:

| Hold | Live |
|---|---|
| `productionExecution` | **false** |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_CHECKALT_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `financialActivationSqlApplied` | **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |
| Gate 3D | CloudFront `/prep/health` 200; raw execute-api 403; OPTIONS 204 |
| Execute-api endpoint | still enabled (`DisableExecuteApiEndpoint` not set true) |

No secret values, hashes, prefixes, OTPs, Cognito tokens, or session credentials are recorded here.

Authenticated staff login was **not** completed this turn (would require EMAIL_OTP). Privileged-operator Gate 3D already proved one authenticated production request through CloudFront. Core authenticated pages (`/:slug/checks`, WalletOps, settings) therefore remain **code-and-route verified**, not session-walked.

---

## Live snapshot

| Surface | Result |
|---|---|
| SPA | CloudFront `E1B0ZWWO5559U5` aliases `checksops.com` + `www.checksops.com`, Deployed, WAF attached |
| Bundle | `/assets/index-pCMVLFzc.js` — Cognito adapter, same-origin `/prep`, no `supabase.co`, no execute-api hostname |
| `VITE_APP_URL` in bundle | `https://checksops.com` (RP ID `checksops.com`) |
| Login session key | still named `checksops.aws.staging.auth` |
| Prep Lambda | `checksops-production-prep-api`, nodejs22.x, VPC 2 subnets, `CHECKSOPS_ENV=production-prep` |
| DB | `/prep/db-health` TLS+auth OK, PostgreSQL 18.3, database `checksops`, role `checksops`, `transactionReadOnly=on` for the health probe |
| Cognito on Lambda | pool id + client id **set**; `COGNITO_WEBAUTHN_ORIGIN=https://checksops.com`; `COGNITO_WEBAUTHN_RP_ID=checksops.com` |
| Application writes | `AWS_WRITES_ENABLED=true`, check-workflow / storage / application-workflow writes **true** (non-financial) |
| Provider secrets on Lambda | **none** of the Moov/CheckAlt key names are present |
| Temp Step 3 / Steps12 roles | assume `AccessDenied` (consistent with deleted) |

`/prep/health` still reports `database: not-connected` even though `/prep/db-health` is healthy. That string is hardcoded in `aws/functions/api/index.mjs`.

---

## 1. Database

**Connectivity:** PASS. Production Lambda reaches RDS. Secret ARN configured. Probe user is `checksops`, not `checksops_admin`.

**Schema:** Core tables present. Catalog: 181 public tables, 165 triggers, 997 functions. Restore sentinel present.

**RLS:** 178/181 tables have RLS enabled. App role does not bypass RLS. Fail-closed: without Cognito identity, core tables return **0** rows (`failClosedWithoutIdentity=true`). Tables without RLS: `_checksops_restore_complete`, `identity_accounts` (intentional), `spatial_ref_sys`. No tenant-sensitive table is missing RLS.

**Skipped restore FKs:** 47 public FKs to `auth.users` remain absent (expected). Identity is Cognito `sub` → `identity_accounts.application_user_id` → `auth.uid()` shim (`canExecuteAuthUid=true`, result null without session).

**Remaining Supabase catalog:** function bodies still reference `net` (4), `cron` (2), `vault` (5), `pgmq` (5). EXECUTE not granted to `checksops`. 47 functions still mention `auth.uid()`.

**Row counts:** Unauthenticated probe cannot reconcile restore counts (0 is the fail-closed pass). Last documented expected restore targets remain in `aws/functions/api/db-readonly-validate.mjs` (for example tenants 6, claims 180, check_intake_items 182). **Table-owner count reconciliation was not re-run this audit.**

**Payee-rename trigger:** 2026-09-06 parity record said live `tg_mirror_payee_to_endorsement` still lacked the Sept 3 rename-delete body. This audit did not dump function bodies. Treat overlay as **unverified**.

---

## 2. Authentication

| Flow | Finding |
|---|---|
| Passwordless EMAIL_OTP | Live `POST /prep/auth/passwordless/start` reaches prep (`missing_email` on empty body). Login UI: “Email me a verification code”. |
| Passkeys / WebAuthn | Server RP is `checksops.com`. Login UI shows passkey on apex. SPA enables passkeys only when `hostname === checksops.com`, so **www is not a WebAuthn origin**. |
| Forgot/reset password | `/forgot-password` redirects to `/login`. AWS path is EMAIL_OTP, not Supabase magic-link. Staging password UAT toggle is still rendered because `isAwsStaging()` is true for any Cognito SPA. |
| Cognito mappings | Lambda pool/client configured. `/prep/identity/me` without token → `missing_cognito_token`. Mapping code still refuses `sub === application_user_id`. |
| Platform owner | `/admin/tenants` unauthenticated → “Access Restricted / master merchant”. |
| Session | Cognito tokens in `localStorage` key `checksops.aws.staging.auth` (mortgage: `.mortgage-ops`). Logout is adapter `signOut`. |
| API through CloudFront only | Live bundle has no execute-api URL. Raw execute-api `/prep/health` is **403** (Gate 3D). |

Cognito MFA/TOTP step-up is stubbed on the AWS adapter (“Supabase MFA/TOTP is not available on AWS staging Cognito”). Privileged financial step-up remains a **provider-activation** prerequisite, not a current app-use blocker while money movement is off.

---

## 3. Core workflows (no financial execution)

Public / unauthenticated:

| Workflow | Result |
|---|---|
| Landing / dashboard marketing | Loads. Amber AWS staging banner. |
| Login / mortgage login / tenant login | Load; Cognito EMAIL_OTP + passkey controls. Authenticated Check Command Center **not walked**. |
| `/sign` `/endorse` | Token-required error states, not crashes. Public APIs reach prep. |
| Intake / review / endorsing / stakeholders / mortgage tracking | Code is on AWS adapter + write allowlist; **requires authenticated session** to prove. |
| Storage sign | `/prep/storage/sign` → `missing_cognito_token` (authorizer not blocking CloudFront). |
| Tenant / users / settings / WalletOps / Security & Compliance | Routes exist under `/:slug/...`; unauthenticated → tenant login. AWS compliance fetch: `src/lib/aws/tenantCompliance.ts` → `/tenants/:id/security-compliance`. |
| Notifications / reporting | Read RPCs allowlisted (`get_total_unread_check_messages`, dashboard counts). Realtime channels are **no-ops** (15s polling waiver still applies). |
| Deposit / WalletOps money buttons | Flags false; financial RPCs classified `financial_sensitive` and stay disabled. |

Non-financial application writes are enabled on the Lambda (`AWS_WRITES_ENABLED=true`). That is required for intake/review/messages. It is **not** provider execution.

---

## 4. AWS API parity

Live SPA talks to same-origin `/prep` only.

| Topic | Finding |
|---|---|
| Browser 4xx/5xx | Public token-less `/sign` `/endorse` are in-app errors. Console: CSP `frame-ancestors` ignored on `<meta>` (not 4xx). |
| Unsupported RPCs | Financial/deposit RPCs remain disabled by design (`SAFE_WRITE_RPC_CLASSIFICATION`). |
| PostgREST | AWS adapter translates `.from().select()` to `/data/query`. Complex embeds still a residual risk for tables not in `allowed-tables.json`. |
| Missing routes | `GET /prep/providers/readiness` → 404. Webhooks exist: `/prep/webhooks/moov` and `/checkalt` return `invalid_signature` without HMAC (good). |
| Frontend bypass | No live `supabase.co` or execute-api in the production bundle. |
| Remaining Lovable call | `ingest-shared-check` may POST `https://{source_project_ref}.supabase.co/functions/v1/push-check-status` for Freedom partner status backfill. |
| Health vs db-health | `/prep/health` hardcoded `database: not-connected`. |

---

## 5. Production UI

Walked on `https://checksops.com` (see recording).

- Amber banner on **every** page: “AWS staging — Cognito + RDS. Production ChecksOps is unchanged.” Root: `AwsStagingBanner` + `isAwsStaging()` true whenever `VITE_AUTH_PROVIDER=cognito`.
- Login copy still says “AWS staging: passkeys use Cognito WebAuthn…” and offers **“Use staging password (master UAT)”**.
- Mortgage Desk and Freedom login also say “AWS staging”.
- `/forgot-password` → `/login`.
- `/admin/tenants` access-restricted without session (expected).
- `www.checksops.com/login` canonicalizes toward apex; WebAuthn RP is apex-only.
- No supabase/execute-api console calls observed.
- Authenticated empty tables / wrong counts **not measured** (no session).

---

## 6. Provider readiness (read-only)

Do not create transfers, deposits, ACH/RTP, stakeholders, or live provider objects. Flags remain false.

**Moov**

- Code: `aws/functions/api/providers/moov.mjs`, parity handlers, webhook `/webhooks/moov`, readiness helpers.
- Production Lambda: **no** `MOOV_*` / `AWS_MOOV_WEBHOOK_SECRET` env keys.
- Secrets Manager list (names only): no secret whose name contains `moov`.
- Webhooks: deployed, dry-run `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`, unsigned POST → `invalid_signature`.
- Sandbox certification historically PASS on **staging**, not production.
- KYC/KYB, wallet create, payouts: blocked by flags; UI (WalletOps) will show not-ready / fail-closed.

**CheckAlt**

- Code: Architecture A + `providers/checkalt.mjs` + parity client. Production path expects registered FinCapture user, not `CHECKALT_UAT_*`.
- Production Lambda: **no** `CHECKALT_*` env keys.
- Secrets Manager list: no secret name containing `checkalt`.
- Webhook `/webhooks/checkalt` same dry-run/HMAC behavior.
- Deposit/image flow must stay off. UAT deposit-account binding remains an external prerequisite from `PROVIDER_CERTIFICATION_READINESS.md`.

**Shared before controlled live certification**

1. Load production (not staging) Moov/CheckAlt secrets into a production Secrets Manager object / Lambda env — values never in git.
2. Dual-run webhooks while dry-run stays true (`WEBHOOK_TRANSITION.md`).
3. Keep `AWS_PROVIDER_EXECUTION_ENABLED` / Moov / CheckAlt / financial grants **false** until a separate approval.
4. Cognito step-up (TOTP or WebAuthn) before privileged money movement.
5. Do not apply `64_financial_activation_grants.sql`.

---

## Prioritized issues

### P0 — blocks normal production application use

None proven that prevent login-or-die. Perimeter, RDS connectivity, Cognito passwordless UI, and public sign/endorse error handling work. Authenticated Check Command Center was not session-tested here; if that walk fails, it would become P0.

### P1 — required before calling production “launch-clean” or before provider activation

| ID | Symptom | Root cause | Where | Safest fix | Kind | Prod write? |
|---|---|---|---|---|---|---|
| P1-1 | Production site labeled “AWS staging”; staging password UAT control visible | `isAwsStaging()` means Cognito SPA, not staging host; banner/copy not split for production | `src/lib/awsStaging.ts`, `src/components/AwsStagingBanner.tsx`, `src/pages/checkops/CheckOpsLogin.tsx` | Rename gate (`isAwsCognitoSpa`) and ship production copy; hide master-UAT password toggle when origin is `checksops.com` | code-only + SPA rebuild/deploy | SPA publish only |
| P1-2 | `/prep/health` says DB not connected | Hardcoded `database: 'not-connected'` | `aws/functions/api/index.mjs` | Report `connected` from `probeIsHealthy` or drop the field and use `/db-health` | code-only | Lambda deploy |
| P1-3 | Passkeys do not apply on `www` | WebAuthn RP / SPA check is `checksops.com` only | `awsStaging.ts`, Cognito pool RP, `auth-webauthn.mjs` | Keep apex as RP; ensure www always redirects before WebAuthn; do not add www as a second RP without pool change | AWS config + SPA | no DB |
| P1-4 | Moov/CheckAlt cannot certify on production | No production provider secret names on Lambda or in Secrets Manager (names search) | `provider-secrets.mjs`; prep Lambda env | Create production secret object; wire names only; keep flags false | AWS config | no financial rows |
| P1-5 | Partner shared-check status may still call Lovable | `ingest-shared-check` backfill URL `*.supabase.co/functions/v1/push-check-status` | `aws/functions/api/ingest-shared-check.mjs` | Replace with AWS partner callback or disable backfill when source is retired | code-only | no |
| P1-6 | Payee rename/delete trigger overlay unverified on live RDS | Last parity note: live trigger lacked Sept 3 body | `aws/write-path/sql/38_parity_payee_mirror_and_returns.sql` | Read-only `pg_get_functiondef` as admin, then isolated overlay if still stale | migration | yes, function body only if approved |
| P1-7 | Authenticated app surfaces not re-walked | EMAIL_OTP mailbox not available to this agent | Check Command Center, review, intake, settings, WalletOps | Privileged CloudShell passwordless walk of `/:slug/checks` and settings | operational | no |
| P1-8 | Cognito TOTP step-up stubbed | Adapter MFA methods return unavailable | `src/integrations/aws/client.ts`, `auth-mfa.mjs` | Enable Cognito MFA **after** perimeter; not needed while money movement is off | AWS config | Cognito pool MFA later |
| P1-9 | Production webhook dual-run not started | Dry-run on; provider URLs historically Lovable | `WEBHOOK_TRANSITION.md` | Extra AWS subscriber, keep dry-run | provider-side | no ledger apply |

### P2 — polish / non-blocking

| ID | Symptom | Root cause | Where | Safest fix | Kind | Prod write? |
|---|---|---|---|---|---|---|
| P2-1 | Session key named `checksops.aws.staging.auth` | Staging-era constant | `src/lib/awsStaging.ts` | New key + one-time migrate/copy | code-only | no |
| P2-2 | `CHECKSOPS_ENV=production-prep` | Prep-era env | Lambda env | Rename label only after review | AWS config | no |
| P2-3 | Readiness JSON still `productionCutoverForbidden/DnsChanged/AuthSwitched=false` | Hardcoded snapshot | `ops-readiness.mjs` | Reflect live truth without flipping financial holds | code-only | no |
| P2-4 | CSP `frame-ancestors` ignored on `<meta>` | Delivered in HTML meta | SPA index | Move to CloudFront response header | AWS config | no |
| P2-5 | Realtime is a no-op | Adapter `channel()` empty | `integrations/aws/client.ts` | Keep 15s polling (`REALTIME_POLLING_WAIVER.md`) | none | no |
| P2-6 | 47 skipped `auth.users` FKs; leftover net/cron/vault/pgmq functions | Restore model | catalog | Leave; do not grant EXECUTE | none | no |
| P2-7 | `/prep/providers/readiness` 404 | Not routed | `index.mjs` | Optional alias to `/financial/status` | code-only | no |

---

## What remains before provider live certification (not this phase)

1. Fix P1-1 SPA copy so production does not look like staging.
2. Confirm authenticated Check Command Center (P1-7).
3. Confirm payee trigger overlay (P1-6).
4. Load production Moov/CheckAlt secrets without enabling flags (P1-4).
5. Webhook dual-run dry-run (P1-9).
6. Separate approval to enable provider execution and financial grants — **not authorized here**.

---

## STOP

Do **not** activate money movement. Do **not** apply `64_financial_activation_grants.sql`. Do **not** change Gate 3D. Do **not** disable execute-api. Do **not** rotate RDS secrets. Do **not** modify CloudFront/WAF unless a perimeter regression appears.

This audit did not fix anything.
