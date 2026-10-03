# Money Movement Launch Gate — Phase 2.5

**2026-09-09.** Pre-merge / activation readiness review of draft PR #175.

READ-ONLY. STOP FOR REVIEW. PR #175 remains **unmerged**. SQL 64 and SQL 65 were **not** applied. No production provider secret was created. CheckAlt was **not** called. No deposit was submitted. No production check row was mutated. Webhook configuration was not changed. No financial/provider flag was enabled.

Reviewed commit: `302bf8c5` on `cursor/checkalt-production-dark-8b74`.

## Holds (live production Lambda + `/prep/financial/status`)

| Hold | Live |
|---|---|
| `productionExecution` | **false** |
| `AWS_CHECKALT_ENABLED` | **false** |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | **true** |
| SQL 64 | **NOT_APPLIED** |
| SQL 65 | **NOT_APPLIED** |
| `PROVIDER_SECRETS_ARN` | **unset** |
| `checksops/production/providers` | **does not exist** (name search) |
| CheckAlt env names on Lambda | **absent** |

Secrets Manager name search (values not read): `checksops/staging/providers` exists; `checksops/production/cloudfront-origin-verify` exists; no production CheckAlt/Moov secret name.

## Merge decision

**NOT SAFE TO MERGE #175 YET.**

Dark-path **runtime** is currently unreachable with holds off (verified by code + PR tests + live flags). That is not enough. SQL 65 as written has a fail-open GUC guard, and the submit/authz path can still issue a second FinCapture `process` POST for historical production rows or reuse a TOTP from another check.

Exact changes required on #175 are listed at the end. Do not apply SQL. Do not create secrets. Do not lift flags.

CI on #175: `aws-migration-guards` **SUCCESS**, Vercel **SUCCESS**. Local re-run of `aws/tests/api-checkalt-production.test.mjs`: **16/16 pass**.

---

## 1. SQL 65 vs live production RDS (read-only)

Live source: `GET https://checksops.com/prep/db-readonly-validate` as role `checksops` (no identity GUC). Table-owner `information_schema` column dump is **not** exposed by any existing public endpoint; column inventory below is reconstructed from restore migrations + AWS overlays and is consistent with live privileges/RLS.

### Live `checkalt_deposits`

| Item | Live |
|---|---|
| Present | yes |
| Owner | `checksops_admin` |
| RLS | **enabled**, not forced |
| Application privileges | SELECT **yes**; INSERT/UPDATE/DELETE **no** |
| RLS matrix | SELECT policy yes; INSERT/UPDATE/DELETE policies **no** |
| Unauthenticated count | **0** (fail-closed). Expected restore count 58 as table owner |
| PK | `id uuid` |
| Unique | `checkalt_reference` (from create table) |
| Indexes | `idx_checkalt_deposits_check_intake`, `_status`, `_tenant`, `_return_window` (overlay) |
| Triggers | `update_checkalt_deposits_updated_at`; `checkalt_deposits_fund_on_clear` (wallet enqueue on status=cleared — remains dormant while Moov/financial flags are off) |
| Tenant column | `tenant_id uuid` |
| Check column | `check_intake_item_id uuid` (not `check_id`) |
| Provider reference | `checkalt_reference text` |
| Status | `status text` (`pending` / `submitted` / `pending_approval` / `cleared` / `returned` / `rejected` / `error` / …) |
| Amount | `amount numeric` (dollars). **No** live `amount_cents` / `idempotency_key` / `provider_http_attempted_at` |

Expected live columns (migrations + overlays; not a live `information_schema` dump):

`id`, `check_intake_item_id`, `claim_check_id`, `tenant_id`, `checkalt_reference`, `status`, `return_reason`, `amount`, `submitted_at`, `cleared_at`, `returned_at`, `last_status_payload`, `last_polled_at`, `submitted_by`, `created_at`, `updated_at`, `approved_by`, `approved_at`, `reject_code`, `reject_notes`, `status_unresolved`, `return_code`, `return_window_until`.

Existing 58 rows: `idempotency_key` will be NULL after ADD COLUMN. Unique partial index will **not** collide.

SELECT policy live: `aws_select_checkalt_deposits` (`aws_is_cross_tenant_reader() OR aws_can_access_tenant(tenant_id)`). Write policies intentionally absent (`24_complete_write_policies.sql` lists `checkalt_deposits` as server-side default deny).

`checkalt_config` singleton columns used by SQL 65 function exist in migrations (`merchant`, `fi_key`, `base_url`, `default_enabled`, `depositor_account_id`, `business_unit`). Live values were **not** selected (would expose merchant/FI). Function `aws_checkalt_production_config()` / `aws_financial_execution_active()` do **not** exist live.

### Statement-by-statement

| SQL 65 statement | vs live | Verdict |
|---|---|---|
| `ALTER TABLE … ADD COLUMN IF NOT EXISTS` idempotency_key/amount_cents/provider_http_attempted_at/failure_class/last_error | columns absent; nullable ADD does not rewrite existing values | **PASS** (when applied later) |
| `CREATE UNIQUE INDEX … (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL` | no such index; existing NULLs excluded | **PASS** |
| `CREATE INDEX idx_checkalt_deposits_idempotency_key` | absent | **PASS** |
| `CREATE OR REPLACE FUNCTION aws_financial_execution_active()` | absent | **NEEDS CHANGE** — returns NULL when GUCs unset; see §2 |
| `GRANT EXECUTE … TO checksops, authenticated` on that function | n/a | **PASS** after NULL-safe rewrite |
| `CREATE OR REPLACE FUNCTION aws_checkalt_production_config()` SECURITY DEFINER `row_security=off` | absent | **NEEDS CHANGE** — fail-open when GUCs unset leaks merchant/FI/base_url to `checksops` |
| INSERT/UPDATE policies `TO authenticated` + `aws_financial_execution_active()` + `aws_can_access_tenant(tenant_id)` | no write policies today; `GRANT authenticated TO checksops` is live | **PASS** after GUC fix; policies correctly ignore browser ids |
| `GRANT SELECT, INSERT, UPDATE … TO checksops` | live INSERT/UPDATE **false** | **PASS as later apply** — this is the intended writer grant. Do **not** apply until the GUC guard is fixed. DELETE remains ungranted. |

SQL 65 does not `UPDATE` existing rows, drop columns, or rewrite `checkalt_reference` / `status`.

---

## 2. Isolated SQL 65 apply ×2 (local Postgres, not production)

Cluster: user-owned PostgreSQL 16 on `localhost:55432`, database `sql65_iso`. Production-compatible `checkalt_deposits` + two legacy rows (cleared + submitted, different tenants, existing references). SQL 65 applied **twice**.

| Check | Result |
|---|---|
| Second apply | idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE` / DROP+CREATE policy) |
| Legacy row fingerprint | **0 drift** (reference, status, amount, payload, tenant, check id unchanged) |
| New columns on legacy rows | all NULL |
| Unique index | duplicate `(tenant_id, key)` rejected; same key on another tenant allowed; multiple NULL keys allowed |
| Unrelated tenant | submitted / `99900011` / `12.34` unchanged |
| GUC unset | **`aws_checkalt_production_config()` returned merchant + fi_key + base_url** |

Root cause: `aws_financial_execution_active()` is `setting = '1' AND setting = '1'`. Unset `current_setting(..., true)` is NULL, so the AND is NULL. `IF NOT NULL` in PL/pgSQL does **not** enter `RAISE`. Combined with `SECURITY DEFINER` + `row_security=off`, this bypasses `checkalt_config` SELECT RLS.

**Safest fix (SQL 65 only):**

```sql
IF NOT COALESCE(public.aws_financial_execution_active(), false) THEN
  RAISE EXCEPTION ...;
END IF;
```

and/or define `aws_financial_execution_active()` as `COALESCE(... = '1' AND ... = '1', false)`.

Isolated test did **not** modify production.

---

## 3. Production authorization

Traced path (PR #175):

1. Cognito ID token → `identity_accounts.application_user_id` (`withIdentityWrite`). Browser `user_id` / `sub` refused when they disagree (`refuseSubAsApplicationId`, `identity_spoof_denied`).
2. Check loaded by `check_intake_item_id`. Tenant comes from **`check_intake_items.tenant_id`**.
3. `tenant_users` membership of that check tenant (`membershipForTenant`). Browser `tenant_id` mismatch → `cross_tenant_denied`.
4. Roles = `tenant_users.role` ∪ `user_roles.role`. `FINANCIAL_ROLES = {owner, admin, manager}`. **operator is denied**.
5. Step-up: TOTP row in `financial_stepup_log` (`deposit.submit`, 30 min) **or** dual-control from a **different** user (`checkalt.dual_control`, 24 h, same `metadata.check_id`).
6. `productionCheckAltExecutionAllowed()` requires `AWS_PROVIDER_EXECUTION_ENABLED` ∧ `AWS_CHECKALT_ENABLED` ∧ `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` ∧ NOT sandbox. Default all false → handler returns `null` → existing stub/parity path. Ambiguous production+sandbox → 409, no HTTP.
7. Writer GUCs: `request.app_user_id`, `request.financial_execution=1`, `request.aws_financial_permissions_activated` = `'1'` only if the flag is true. RLS policies require both `'1'`.
8. `auth.uid()` is the live GUC shim (`aws/identity/sql/02_auth_uid_guc.sql`). `aws_is_authenticated()` is `auth.uid() IS NOT NULL`.

### Forbidden-path results

| Path | Result |
|---|---|
| Browser `tenant_id` authorizes | **No.** Check tenant + membership. Mismatch 403. |
| Browser `user_id` authorizes | **No.** Cognito mapping only. Mismatch 403. |
| Browser amount controls provider amount | **No.** `rejectUntrustedAmountFields`; cents from `check.amount` only. |
| Operator executes | **No.** `roleAllowsFinancial` excludes operator. Tested in PR. |
| Same user both sides of dual-control | **No.** `excludeUserId` on consume. |
| Dual-control / TOTP for tenant A used on tenant B | **No.** Lookups are `tenant_id = check.tenant_id`. |
| Dual-control for check A used on check B | **No.** Consume requires `metadata.check_id`. |
| TOTP for check A used on check B (same tenant) | **YES — gap.** After a check-scoped miss, `authorizeCheckAltProduction` accepts **any** successful `deposit.submit` TOTP for that user+tenant in 30 minutes (`checkalt-authz.mjs`). |
| Dual-control reused after amount change (same check) | **YES — gap.** Amount is stored in metadata and **not** compared to current `check.amount` / cents. 24 h TTL. |
| Browser `tenant_id` written into TOTP log | `recordStepUpLog` uses body `tenant_id` without membership check. Does not by itself authorize another tenant (consume uses check tenant), but should derive tenant from the check. |

`evaluateFinancialAuthorization().canExecuteProduction` stays false; CheckAlt uses a separate evaluator. Dual-control POST `/financial/checkalt-dual-control` can INSERT `financial_stepup_log` with flags off (documented as not money movement). That write is not CheckAlt HTTP.

---

## 4. CheckAlt request contract (code only — not called)

Adapter: `checkalt-client.mjs` + `checkalt-submit.mjs` + `checkalt-secrets.mjs`. Matches Lovable `supabase/functions/checkalt-submit-deposit` / `_shared/checkalt.ts` (Clearingworks FinCapture).

### Auth

`POST {CHECKALT_BASE_URL}/public/fincapture/authenticate`

Headers: `Content-Type: application/json`, `merchant: {checkalt_config.merchant}` (RDS, not secret, not browser).

Body: `{ userName: CHECKALT_USERNAME, password: CHECKALT_PASSWORD }`.

JWT is process-local cache only (`allowConfigJwt: false`). Production `checkalt_config.cached_jwt` is not used.

### Process

`POST {CHECKALT_BASE_URL}/fincapture/deposit/process`

Headers: `Authorization: Bearer {jwt}`, `merchant: {merchant}`, `Content-Type: application/json`.

Body keys (Lovable set; no `testDeposit`, no `checkNumber`, no `data:` image prefix):

| Field | Source | Units |
|---|---|---|
| `fiKey` | `CHECKALT_FI_KEY` secret (not RDS `checkalt_config.fi_key`, not browser) | CheckAlt FI UUID |
| `ssoKey` | `checkalt_tenant_accounts` for **check tenant**: cached `last_register_payload.sso_key`, else `getUserAccountInformation`, else `sso_user_id` | depositor SSO |
| `depositAccountNumber` | `checkalt_tenant_accounts.deposit_account_number` | account number |
| `captureDateTime` | server `new Date().toISOString()` | ISO-8601 |
| `userAmount` | `round(check_intake_items.amount * 100)` integer cents | e.g. `12.34` → `1234` |
| `frontImage` | S3 claim-files JPEG, server Base64 | raw JPEG b64 |
| `rearImage` | S3 `back_image_deposit_path` or allowed prepared path | raw JPEG b64 |
| `performRiskAssessment` | `true` | boolean |

No CheckOps `id` / `check_intake_item_id` is sent. Provider reference is response `referenceNumber` / `reference`.

### Host allowlist

`CHECKALT_BASE_URL` must be `https` with empty path: `api.checkalt.com`, `api2.checkalt.com`, or `*.checkalt.com` excluding `uat` / `sandbox`. `https://uatapi.checkalt.com` is refused.

**VENDOR BLOCKER (activation, not dark deploy):** which production host CheckAlt assigned (api vs api2 vs tenant hostname) is **not** proven from live RDS in this review. Confirm with CheckAlt before loading `CHECKALT_BASE_URL`. Do not guess. Do not copy UAT.

Poll (no new deposit): `POST /fincapture/deposit/item` `{ fiKey, ssoKey, referenceNumber }` then `/fincapture/deposit/history`. History match `checkId == row.check_intake_item_id` **OR** `userAmount == amount_cents` — amount-only match can attach the wrong item. Fix: require check id **and** amount, or reference only.

---

## 5. Idempotency failure modes

Key: `sha256(tenant_id|checkalt_deposit|check_id|amount_cents|USD)`. Persist-before-HTTP. Claim: `UPDATE … SET provider_http_attempted_at = now() WHERE attempted_at IS NULL AND reference IS NULL`. `shouldReconcileInsteadOfPost` if reference, terminal status, or attempted_at + queued/pending/submitting/error.

| State | Next invoke |
|---|---|
| **A.** queued committed, HTTP never called (`attempted_at` NULL) | New claim allowed. **One** process POST. Correct. |
| **B.** `attempted_at` set, network fails before response | Reconcile / history. **No** process POST. |
| **C.** Provider accepts, Lambda times out | Row has `attempted_at`, no reference. Reconcile. **No** process POST. |
| **D.** Provider accepts, RDS reference update fails | Returns `failure_class=db_after_provider`; retry reconciles. **No** process POST. |
| **E.** Double submit | Unique `(tenant_id, key)` → 23505; only one claim. **No** second POST. **Requires SQL 65 index.** Without SQL 65, two inserts can both POST. |
| **F.** Poll before reference | Poll never INSERTs; history only. **No** process POST. |

### Gap — historical production rows

The 58 restored `checkalt_deposits` rows have **no** `idempotency_key`. Submit looks up **only** by the new key, not by `check_intake_item_id` / existing `checkalt_reference`. A Freedom check that already reached CheckAlt can get a **second** `POST /fincapture/deposit/process`.

This violates “no second process POST after HTTP may have reached CheckAlt.”

**Safest fix:** before insert, select existing rows for that `check_intake_item_id` (same tenant) where `checkalt_reference IS NOT NULL` OR `provider_http_attempted_at IS NOT NULL` OR status ∈ submitted/pending_approval/cleared/rejected/returned/duplicate/submitting; reconcile those; never process-POST.

---

## 6. Production configuration — names only

| Name | Expected | Source when later loaded |
|---|---|---|
| `CHECKALT_USERNAME` | required | **CheckAlt** production API login |
| `CHECKALT_PASSWORD` | required | **CheckAlt** |
| `CHECKALT_FI_KEY` | required | **CheckAlt** (may equal RDS `checkalt_config.fi_key`; adapter uses the **secret**) |
| `CHECKALT_BASE_URL` | required, approved host | **CheckAlt** — confirm exact origin |
| `CHECKALT_WEBHOOK_SECRET` | required name; webhooks stay dry-run | **CheckAlt** + AWS operator |
| `PROVIDER_SECRETS_ARN` | Lambda env → `checksops/production/providers` | **AWS operator** — create later, not now |
| `merchant` | not a secret name | **RDS** `checkalt_config.merchant` |
| `default_enabled` / depositor / business_unit | not secrets | **RDS** `checkalt_config` |
| `sso_user_id` / `deposit_account_number` | not secrets | **RDS** `checkalt_tenant_accounts` for Freedom (and only that tenant) |

UAT names (`CHECKALT_UAT_*`, `CHECKALT_SANDBOX_*`) cannot satisfy production. Do not copy staging secret `checksops/staging/providers` into production names.

---

## 7. First low-value test check — criteria only

Do **not** select or mutate a production check in this review.

| Must be true | Why |
|---|---|
| Freedom tenant (`freedom` / Freedom Adjusters) | Requested first tenant |
| Owner/admin/manager actor; not operator | Authz |
| Fully reviewed; endorsements complete; `check_stage` / status **Ready for Deposit** / `approved_for_deposit` | Product gate |
| Front **and** rear deposit-ready JPEGs in claim-files (not SVG) | Image fail-closed |
| `checkalt_tenant_accounts` for Freedom: `enabled`, `sso_user_id`, `deposit_account_number` | Destination not browser-chosen |
| **Zero** `checkalt_deposits` rows for that `check_intake_item_id` (any status/reference) | Until historical-row lookup is fixed |
| No in-flight `idempotency_key` / `submitting` row | No ambiguous replay |
| Amount below cap | Limits cash at risk |

**Recommended first-test maximum: $5.00 (500 cents).** Prefer the smallest Freedom ready-for-deposit check ≤ $5. If none exist, **do not raise the cap** and do not use a larger production check.

Still blocked until: #175 fixes land, SQL 65 (fixed) applied, production secret created, flags separately approved. Not this review.

---

## 8. What is already good (do not regress)

- Flags default false; production handler returns `null`; public invoke stays stubbed.
- UAT secrets / UAT host cannot satisfy production.
- Browser amount, images, merchant, FI, account, tenant, user are rejected or ignored.
- Operator denied; dual-control cannot be self-approved.
- New-key A–F behavior is correct **if** SQL 65 unique index exists.
- Poll never inserts.
- SQL 65 ADD COLUMN / indexes are non-destructive and twice-apply safe.
- No production credentials required to **deploy** dark Lambda/SPA (secret missing → 503 before HTTP **if** flags were on).

---

## Required changes on PR #175 (do not merge until these land)

1. **SQL 65 GUC fail-closed** — `COALESCE(aws_financial_execution_active(), false)` before `aws_checkalt_production_config()` returns. Add an isolated test that unset GUCs raise `42501` and do not return merchant/FI.
2. **Historical-row idempotency** — lookup by `check_intake_item_id` (+ tenant) before insert; never process-POST when a prior reference or HTTP attempt exists. Add a test with a legacy row (`idempotency_key` NULL, `checkalt_reference` set).
3. **Step-up scope** — remove tenant-wide TOTP fallback; require `metadata.check_id` (and `amount_cents` or `amount_dollars`) to match the check being submitted. Dual-control consume must match current server cents. Derive TOTP log tenant from the check, not browser `tenant_id`.
4. **History reconcile** — match on check id **and** amount (or reference only), never amount alone.
5. Keep holds false. Do not apply SQL. Do not add `PROVIDER_SECRETS_ARN`.

Kind: **code-only + SQL file edit**. No production write required to land the fixes on #175.

---

## STOP

Do not merge #175. Do not apply SQL 64 or 65. Do not create `checksops/production/providers`. Do not call CheckAlt. Do not move money. Gate 3D and execute-api remain untouched.
