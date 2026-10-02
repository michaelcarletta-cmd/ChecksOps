# Feature Verification — production baseline record

**Recorded:** 2026-09-23T18:41Z  
**Workstream:** Feature Verification / Mortgage Ops / role testing  
**Nature:** Read and test only. No implementation change. No production or staging deploy.  
**Machine evidence:** `aws/providers/results/feature-verification-baseline-2026-09-23.json`

This run accepts the live AWS production surface as the current baseline and reconciles **forward**. It does not restore older cutover-prep docs that still describe flags as all-false.

## 1. Current production (do not roll back)

| Item | Live value 2026-09-23 |
|---|---|
| SPA host | `https://checksops.com` and `https://www.checksops.com` |
| SPA bundle | `assets/index-BR49bZTp.js` |
| SPA SHA-256 | `0a6c0437aa42436b30542ee646ca9c9ce65513c3fe9ed7a490ccf18e7de76a09` |
| SPA bytes | 896579 |
| SPA last-modified | 2026-09-23 12:34:55 GMT |
| S3 version | `h11J_MRe5OmOjP5JOe9.1AJqkky_jRky` |
| Compiled auth | `VITE_AUTH_PROVIDER=cognito` (`isAwsStaging()` always true in this build) |
| Compiled API | same-origin `/prep` (no `kiqojucc02` / `execute-api` hostname) |
| WebAuthn app URL | `https://checksops.com` |
| Lambda | `checksops-production-prep-api` |
| Lambda CodeSha256 | `KlG4w4x94w5+SXUP2uiIEw0XaKHFNUgzHPKxZE7i3uY=` |
| Lambda last-modified | 2026-09-23T18:24:08Z |
| Lambda role | `checksops-production-api-execution` |
| Cognito pool | `us-east-1_h00WorYMT` (production pool; not staging `us-east-1_vPmQ7cL1F`) |
| `/prep/health` | 200 `environment=production-prep` `status=ok` |
| `/prep/db-health` | 200 connected `checksops` / `checksops` PostgreSQL 18.3 |
| `/prep/ops/readiness` `holds.ok` | **false** (see flags below) |
| Raw execute-api `/prep/health` | **403** (API-behind-CloudFront; expected) |

### Production flags (accepted current state)

These have **advanced** past the September 5 cutover-prep “all false” documents. Do not turn them off to match old docs.

| Flag | Production Lambda | `/financial/status` note |
|---|---|---|
| `AWS_PROVIDER_EXECUTION_ENABLED` | `true` | `productionExecution=false` still |
| `AWS_CHECKALT_ENABLED` | `true` | every money `activated=false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `true` | `moneyMovementUnlocked=false` |
| `AWS_MOOV_ENABLED` | `false` | unchanged |
| `AWS_MOOV_TRANSFER_POST_ENABLED` | `false` | unchanged |
| `AWS_ENDORSEMENT_AUTO_ADVANCE` | `false` | unchanged |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` | unchanged |
| `AWS_PLAID_ENABLED` | `false` | unchanged |

`/prep/ops/readiness` reports `holds.failures` for the three true flags. That is a **stale hold predicate**, not authorization to disable current production.

`/prep/health` still says `database: not-connected`. `/prep/db-health` is connected. Lightweight health does not open a DB session. Not classified as a defect.

## 2. Staging (preferred for role / Mortgage Ops dry-run)

| Item | Live value 2026-09-23 |
|---|---|
| SPA | `https://staging.checksops.com` → `assets/index-Drua3bVl.js` |
| SPA SHA-256 | `4cc8d418712471ebfceb49bc68ffd463027f2be493f9e5a4a7e0a95a414e52d9` |
| API | `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging` |
| Lambda | `checksops-staging-api` |
| Lambda CodeSha256 | `z9eA6eJK3XZ8EsvDTLYLGZQ6sm3SrPiXybzw434NICI=` |
| Lambda last-modified | 2026-09-23T18:40:53Z (**during this run**; another workstream likely overlaid) |
| Cognito pool | `us-east-1_vPmQ7cL1F` |
| Readiness `holds.ok` | **true** (execution flags false) |
| Email | `AWS_EMAIL_MODE=sink` |
| `AWS_ENDORSEMENT_AUTO_ADVANCE` | `true` (staging only; **not** copied to production) |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` (sandbox only) |

This run did **not** overlay staging and must not replace production with this staging snapshot.

## 3. Mortgage Ops — existing user/role model (no auth redesign)

The accepted mechanism already represents Mortgage Ops:

1. Cognito sub → `identity_accounts.application_user_id` → ChecksOps UUID (`refuseSubAsApplicationId`).
2. Platform roles from `user_roles` (`authorizationSource: user_roles_and_tenant_users`; `cognitoGroupsUsed: false`).
3. Tenant membership from `tenant_users`.
4. Desk portal session key `checksops.aws.staging.auth.mortgage-ops` isolated from CheckOps `checksops.aws.staging.auth`.
5. Hire path: existing `POST /functions/v1/hire-mortgage-agent` (`runHireMortgageAgent`) creates Cognito user + mapping + `mortgage_agent` only. Staff/admin combination is refused.
6. CheckOps login signs out a `mortgage_agent`-only account and points it at `/mortgage-ops/login`.
7. Mortgage Desk allows `mortgage_agent` or `admin`.

**Auth-architecture gap:** none found that would require recreating Lovable authentication or changing Cognito. Authenticated desk queue / hire UAT was **not** completed in this environment (no mailbox; OTP not started). That is a **missing tester session**, not a software defect.

## 4. Automated verification

| Suite | Result | Classification |
|---|---|---|
| Mortgage Ops isolation, library parity, bill-mortgage fail-closed | **33 pass** | actual behavior covered |
| `tenant-documents-mortgage-doc-type.test.mjs` | **fail** (`ERR_UNKNOWN_FILE_EXTENSION` importing `.ts`) | test-harness limitation, not a live workflow defect |
| Portal session isolation + auth embed + authorization probe + privileged-auth | **13 / 13 pass** | actual behavior covered |

Bill-mortgage-handling stays fail-closed (`production_execution_blocked`; no Stripe/Moov). Tenant admins cannot bill the desk. Agents cannot manage another tenant’s document library. Loss-draft writes require membership or an assigned open request.

## 5. Live unauthenticated probes (safe boundary)

| Call | Result | Classification |
|---|---|---|
| `GET /prep/identity/me` | 401 `missing_cognito_token` | expected |
| `POST /prep/functions/v1/hire-mortgage-agent` | 401 `missing_cognito_token` | expected |
| `POST /prep/auth/login` (empty) | 410 `password_auth_disabled` | current production after passwordless promotion; message still says “Staging password login…” — **copy drift**, not a reason to reopen Cognito |
| `POST /prep/financial/prepare` | 401 `missing_cognito_token` | expected; money path not exercised |
| Public `/sign` + `/endorse` SPA | HTML 200 | frozen public flows reachable |
| Public sign/endorse APIs without token | JSON 400, not SPA HTML | expected |
| `GET /mortgage-ops/login` prod + staging | HTML 200 | desk login shipped |
| `GET /mortgage-ops/queue` unauthenticated | SPA HTML (client redirect) | expected |

## 6. Defect classification (no repair in this PR)

| Observation | Class | Action |
|---|---|---|
| Production flags true vs old “all false” docs | production has advanced | record; do not roll back |
| Readiness `holds.ok=false` | stale hold predicate vs accepted flags | post-cutover enhancement; do not flip flags |
| Health `database: not-connected` | health-check design | no repair |
| Password login 410 with “Staging …” wording on production-prep | copy / env-label drift | do not reopen Cognito |
| Production UI still prints “AWS staging” because `isAwsStaging()` means Cognito | post-cutover enhancement | do not rename auth helper in this workstream |
| Session keys still named `checksops.aws.staging.auth*` on production | naming leftover | no repair |
| `locked-components.json` still cites `index-reP2FWHf.js` | lock-file evidence stale vs live `index-BR49bZTp.js` | documentation drift; do not rewrite lock tooling here |
| Mortgage-ops lock `SOURCE_LOCKED_NOT_ACTIVE` / SQL 29 “do not apply from this PR” | apply proof unrecorded | tenant/SQL configuration evidence missing; **do not apply SQL 29 from Feature Verification** |
| Node cannot import `.ts` in one unit file | test harness | out of scope |
| Staging Lambda mutated at 18:40Z | other workstream | do not overlay; do not promote staging → production |
| Authenticated Mortgage Ops queue / hire / role matrix | missing tester session | continue on staging with an existing mapped agent; do not create a new Cognito architecture |

No item above is an **actual software defect** that blocks the shipped Cognito + `user_roles` + `tenant_users` Mortgage Ops model and requires a frozen-component repair.

## 7. Explicit non-actions

- No Cognito / `/prep` / RDS / S3 / Textract / branding / public sign-endorse / homeowner / SES / CheckAlt / Moov code changes.
- No real CheckAlt deposit or approval.
- No Moov fund or transfer.
- No production flag changes.
- No Freedom production data copy into another tenant.
- No Supabase/Lovable cleanup (separate workstream).
- No hire of a Mortgage Ops user.

## 8. Next Feature Verification steps (still verification)

1. Use an **existing** staging mapped `mortgage_agent` (or master owner) and complete EMAIL_OTP against the staging sink — do not invent a new IdP.
2. Exercise desk queue / request detail / directory **read** paths on staging.
3. Exercise hire only if an existing admin session already can call `hire-mortgage-agent`; prefer a staging-only email.
4. Role-matrix: CheckOps member, mortgage_agent-only, admin, and a second tenant — staging records only.
5. Stop before any financial button past the existing fail-closed boundary.

If a later authenticated run finds a defect that would require changing Cognito, `/prep`, or a money path: **stop and report** before deployment.

## 9. Browser walkthrough (safe boundary, 2026-09-23)

No email typed. No OTP started. No money buttons.

| URL | Result |
|---|---|
| `https://staging.checksops.com/mortgage-ops/login` | Mortgage Desk card: passkey + “Email me a verification code”. No password field. |
| `https://staging.checksops.com/mortgage-ops/queue` | Unauthenticated → remains on / redirects to login. |
| `https://staging.checksops.com/login` | ChecksOps passwordless (passkey + email code). Copy states password sign-in is disabled. |
| `https://checksops.com/mortgage-ops/login` | Same desk controls as staging. Banner still says “AWS staging” because `isAwsStaging()` means Cognito. |
| `https://checksops.com/login` | Production ChecksOps passwordless. Same leftover “AWS staging” banner. |
| `https://www.checksops.com/mortgage-ops/login` | Apex/www desk login reachable; EMAIL_OTP available. Passkey UI depends on final hostname matching RP `checksops.com`. |

Classification of the leftover “AWS staging” banner on production: **post-cutover copy enhancement**, not a login-blocking software defect. Do not rename the Cognito helper or reopen branding in this workstream.
