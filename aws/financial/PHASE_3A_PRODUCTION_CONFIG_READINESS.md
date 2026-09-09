# MONEY MOVEMENT LAUNCH GATE — PHASE 3A

**PRODUCTION CONFIGURATION, EXECUTION STILL OFF — STOP FOR REVIEW**

Read-only inventory completed 2026-09-09. No production secret was created. `PROVIDER_SECRETS_ARN` was not set. SQL 65 was not applied. Flags were not lifted. CheckAlt was not called. No money moved.

Live machine record: `/opt/cursor/artifacts/phase3a-inventory.json`

## Stop verdict

| Item | Status |
| --- | --- |
| Exact production host | **VERIFIED** — `api2.checkalt.com` |
| Production credential availability | **MISSING** |
| Freedom `checkalt_config` | **PRESENT** — enabled, merchant `lockbox5`, FI key present, webhook secret empty, no username/password columns |
| Freedom `checkalt_tenant_accounts` | **PRESENT** — enabled, registered, SSO present, deposit account last-4 `4573` |
| SQL 65 live compatibility | **SCHEMA_SAFE_COUNT_DRIFT** — writer objects absent; visible rows 69 (58 with reference), not 58 |
| Production SPA step-up | **ABSENT** — live bundle is pre-#175; even `main` is not fully wired |
| Qualifying ≤$5 test check | **NONE** — new low-value controlled test check required |
| Dual-control / TOTP | **NEITHER immediately usable** |
| Phase 3B create secret + apply SQL 65 | **NO** |

## Hard holds (unchanged)

| Hold | Live |
| --- | --- |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `AWS_CHECKALT_ENABLED` | `false` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `PROVIDER_SECRETS_ARN` | unset |
| `checksops/production/providers` | does not exist |
| SQL 64 / SQL 65 | `NOT_APPLIED` |
| CloudFront `/prep/health` | 200 |
| Raw execute-api `/prep/health` | 403 |
| `holds.ok` | `true` |
| `productionExecution` | `false` |
| CheckAlt HTTP | none this phase |

Lambda code-only SHA after inventory deploy: `N0nnEzFJfyhmk5+HPnEwvmGb2r7VzbYpWAW9e5KH8Vw=`. Flags unchanged.

## 1. CheckAlt production credential source

Do not assume `api.checkalt.com`. Public CheckAlt/FinCapture pages do not name the production host. In-repo vendor docs only pin UAT `https://uatapi.checkalt.com`.

**Authoritative live host:** `checkalt_config.base_url` hostname is `api2.checkalt.com`. That matches prior production migration `supabase/migrations/20260717180936_aadfa073-5dc4-477d-80c7-66d022dc5515.sql` (FI key value not printed). Host status: **VERIFIED**. Not a vendor blocker.

| Item | Source | Availability |
| --- | --- | --- |
| Production username | Production path reads `CHECKALT_USERNAME` only from `PROVIDER_SECRETS_ARN` → `checksops/production/providers`. No `username` column on `checkalt_config`. Not on Lambda env. | **MISSING** |
| Production password | Same, `CHECKALT_PASSWORD`. | **MISSING** |
| Production FI key | Live `checkalt_config.fi_key` present (length 36). Also historically written by the 20260717 migration. Production secret name not created. | **PRESENT in RDS** (not in production SM) |
| Exact production base URL | Live `checkalt_config` hostname `api2.checkalt.com` (HTTPS origin). | **VERIFIED** |
| Webhook secret | `checkalt_config.webhook_secret` empty. Production SM name not created. Dry-run stays on. | **MISSING** |
| Merchant identifier | Live `checkalt_config.merchant` = `lockbox5` | **PRESENT, UAT-named** |
| Depositor / SSO user | Freedom `checkalt_tenant_accounts.sso_user_id` present (length 9) | **PRESENT** |
| Deposit account number | Freedom row present, last-4 `4573`, length 10 | **PRESENT** |

`checksops/staging/providers` exists and must not be copied into production names.

**Merchant note:** `lockbox5` is the documented UAT merchant. It is live on the production host. Treat as a configuration question before any execution — not a host-proof failure.

## 2. Live RDS CheckAlt config (read only)

Freedom admin identity (`auth.uid()` match) was used. No rows updated.

`checkalt_config` singleton:

- merchant `lockbox5`
- `default_enabled` **true** (RDS kill switch on; AWS flags still off)
- host `api2.checkalt.com`
- FI key present
- webhook secret empty
- username/password columns absent
- cached JWT **present** (value not returned; production adapter does not use config JWT)
- platform `auto_approve_enabled` false

Freedom `checkalt_tenant_accounts`:

- tenant `Freedom Adjustment` / `freedom` / `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`
- exactly one tenant-account row in the table
- enabled, `registered_at` present
- SSO present
- deposit account last-4 `4573`
- tenant `auto_approve_enabled` **true**

## 3. SQL 65 final pre-apply

`checkalt_deposits` current columns are the Lovable/restore set only. SQL 65 columns/indexes/functions/policies are **absent**:

- no `idempotency_key`, `amount_cents`, `provider_http_attempted_at`, `failure_class`, `last_error`
- no `checkalt_deposits_tenant_idempotency_key_uq` / `idx_checkalt_deposits_idempotency_key`
- no `aws_financial_execution_active` / `aws_checkalt_production_config`
- no writer policies
- grants: `SELECT=true`, `INSERT=false`, `UPDATE=false`, `DELETE=false`, RLS on, owner `checksops_admin`

Visible to Freedom admin: **69** rows, all Freedom, **58 with `checkalt_reference`**, 11 without. Phase 2.6 expected 58 total. Schema is unchanged and `ADD COLUMN IF NOT EXISTS` remains non-destructive. Row-count drift means SQL 65 is **not** “no drift since Phase 2.6.”

**Do not apply yet.**

## 4. Production secret plan (not created)

| Item | Value |
| --- | --- |
| Secret id | `checksops/production/providers` |
| Lambda env | `PROVIDER_SECRETS_ARN` only |
| Names | `CHECKALT_USERNAME`, `CHECKALT_PASSWORD`, `CHECKALT_FI_KEY`, `CHECKALT_BASE_URL`, `CHECKALT_WEBHOOK_SECRET` |

Production Lambda consumes these names only through `PROVIDER_SECRETS_ARN`. UAT keys cannot satisfy that path.

Do not create the secret until username, password, webhook secret, and `CHECKALT_BASE_URL=https://api2.checkalt.com` are verified and explicitly approved.

## 5. Frontend step-up parity

Live SPA entry is `/assets/index-BIF51Tn1.js` (still shows AWS staging banner strings). Lazy scan of the production asset graph found `deposit.submit` and `check_intake_item_id` on the old Lovable submit path only. **No** `/auth/mfa/step-up`, **no** `checkalt-dual-control`, **no** `stepUpAwsTotp`.

`#175` frontend helpers exist on `main` in `src/lib/awsMfa.ts`, but `useFinancialGuard` / `StepUpDialog` still do not pass `checkId`, and `recordCheckAltDualControl` is unused. A SPA-only deploy of current `main` is not enough.

Plan: `aws/financial/PHASE_3A_SPA_STEPUP_DEPLOY_PLAN.md`. Do not change financial flags.

## 6. First test check readiness

No Freedom check meets all first-test rules at ≤ $5. **A new low-value controlled test check is required.**

Three Freedom Ready-for-Deposit checks exist; none qualify:

| Check | Amount | Failures |
| --- | --- | --- |
| `a3a4a153-46e1-4c28-a273-79a9bd04f3a6` | $1546.72 | rear deposit JPEG path missing; above $5 |
| `623442f0-a408-4db5-85be-14bae231a722` | $9984.11 | rear deposit JPEG path missing; above $5 |
| `1db86248-ddae-46dd-a2fc-5694680834e3` | $13257.25 | existing `checkalt_deposits` row + reference; above $5 |

No check was mutated.

## 7. Authorization readiness

Freedom members: 2. Financial owner/admin/manager: **1** — `mcarletta@freedomadj.com`.

Cognito AdminGetUser (no secrets): user confirmed, `UserMFASettingList` empty, TOTP **not enrolled**.

- Dual-control: **not immediately usable** (need a second distinct Freedom owner/admin/manager)
- TOTP: **not immediately usable** (need enrollment; do not enroll/reset this phase)

## 8. Webhook

Keep `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`.

CheckAlt callback should be `https://checksops.com/prep/webhooks/checkalt`.

Vendor-side webhook was **not** configured.

## Remaining blockers

1. Production username / password / webhook secret are not in AWS and are not on `checkalt_config`.
2. `checksops/production/providers` does not exist; do not create it until values are verified.
3. Live merchant is `lockbox5` (UAT name) on production host `api2.checkalt.com`.
4. SQL 65 row count is 69 (58 referenced), not the Phase 2.6 expected 58.
5. Production SPA lacks #175 check+amount step-up; `main` still needs check-id wiring before a SPA-only deploy.
6. No ≤ $5 Freedom candidate; create a new controlled test check.
7. Neither dual-control nor Cognito TOTP is ready (one financial user, TOTP not enrolled).
8. Freedom tenant `auto_approve_enabled` is true — review before any later execution.
9. Cached JWT is still stored on `checkalt_config` (unused by the dark AWS path).

## Phase 3B

**Do not** create the production secret.  
**Do not** apply SQL 65.  
**Do not** lift flags.  
**Do not** call CheckAlt.  
**Do not** move money.

Phase 3B can prepare those steps only after this review accepts the verified host, supplies the missing credential values, and decides how to handle merchant `lockbox5`, the 69-row deposit table, SPA wiring, the ≤$5 test check, and authorization.
