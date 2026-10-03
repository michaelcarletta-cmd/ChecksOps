# MONEY MOVEMENT LAUNCH GATE — PHASE 3A.2

**SPA DEPLOY + AUTHORIZATION READINESS — STOP FOR REVIEW**

Financial activation was not started. Holds remain down. No production secret was created. SQL 64/65 were not applied. CheckAlt was not called. Auto-approve was not changed. TOTP was not enrolled by the agent.

## 1. #178 merge SHA

PR **#178** was already merged when this phase started. The agent did not merge again.

| Item | Value |
| --- | --- |
| PR | https://github.com/michaelcarletta-cmd/ChecksOps/pull/178 |
| Authorized head | `f2d2d60fe3618eb3ddc76157452cfa39fac5da9d` |
| Merge commit on `main` | `c3b4dab402e79327abe96e8f0f45e9a3bf37ba6e` |
| Merge subject | Merge pull request #178 from michaelcarletta-cmd/cursor/mm-phase3a1-stepup-spa-9053 |

`f2d2d60` is an ancestor of `origin/main`.

## 2. Production SPA-only deploy

| Item | Value |
| --- | --- |
| Build | `vite build --mode aws` with `VITE_AUTH_PROVIDER=cognito`, `VITE_APP_URL=https://checksops.com`, `VITE_CHECKSOPS_API_URL=/prep`, production pool/client |
| New production bundle | `/assets/index-koccVdU9.js` |
| SHA-256 | `a582ca9e519b80ec81adde7848e8d201877540c067c2aeff15b4686ca34c9a90` |
| Bytes | 891338 |
| Previous live bundle | `/assets/index-BIF51Tn1.js` |
| Bucket | `checksops-production-frontend-806168576068` |
| CloudFront | `E1B0ZWWO5559U5` / `checksops.com` and `www.checksops.com` |
| Invalidation | `I85YVDHAZULTSAFSH48MUKRBNR` `/*` (created InProgress; apex and www already serve `index-koccVdU9.js`) |
| Live proof | `https://checksops.com/assets/index-koccVdU9.js` status 200, SHA matches build |

GetInvalidation is denied to `ChecksOpsCursorCloudStaging`. CreateInvalidation succeeded. Live HTML already references the new hashed bundle.

## 3. #178 production validation

Live path is present. No provider transaction was performed.

| Check | Result |
| --- | --- |
| Live index contains `/auth/mfa/step-up` | yes (1) |
| Live index contains `check_intake_item_id` | yes (3) |
| Live index contains `deposit.submit` | yes (2) |
| `CheckCommandCenter-rPnaCLkd.js` `deposit.submit` | yes (1) |
| `DepositOperationsConsole-P4AvqAxo.js` `deposit.submit` | yes (1) |
| `CheckAltSettings-Dtesec2g.js` `deposit.approve` | yes (1) |
| Staging execute-api / staging pool / raw execute-api | **absent** |
| `/prep/health` | 200 |
| OPTIONS `/prep/health` | 204 |
| Raw execute-api `/prep/health` | **403** |
| Unauth `POST /prep/functions/v1/checkalt-submit-deposit` | 403 `provider_disabled` |
| Unauth `POST /prep/functions/v1/checkalt-approve-deposit` | 403 `provider_disabled` |

Source + unit tests (`aws/tests/frontend-financial-stepup.test.mjs`, 5/5 pass):

- missing `checkId` fails closed (`check_intake_item_id is required`)
- check-specific cache key `user|action|checkId`
- stale authorization cannot authorize another check
- browser tenant is not authority
- browser amount / `amount_cents` are dropped from the step-up body; server `#175` derives tenant + amount from the check row

`recordCheckAltDualControl` is unused in the shipped bundle (tree-shaken). Dual-control is not available (one Freedom financial user). TOTP is the production step-up path.

Login and MFA are same-origin `/prep`. Cognito pool/client IDs are not inlined (config object unused / tree-shaken). That is expected: the browser does not call Cognito IdP directly.

## 4. Lambda unchanged

| Item | Before | After |
| --- | --- | --- |
| Function | `checksops-production-prep-api` | same |
| `CodeSha256` | `oOUpj9UwvxXHNkhmCEYxNpXeUVcVnUUDWW5n7rOIzUc=` | **identical** |
| `LastModified` | `2026-09-09T18:24:55.000+0000` | **identical** |
| `PROVIDER_SECRETS_ARN` | unset | unset |
| CheckAlt username/password/FI env | unset | unset |

No `lambda:UpdateFunctionCode` or `UpdateFunctionConfiguration` was called.

## 5. Holds unchanged

Live `/prep/ops/readiness` + Lambda env after deploy:

| Hold | Value |
| --- | --- |
| `AWS_CHECKALT_ENABLED` | `false` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `AWS_COGNITO_MFA_PREFERRED` | `false` (`cognitoMfaPreferred: false`) |
| `productionExecution` | `false` |
| SQL 64 | `NOT_APPLIED` |
| SQL 65 | `NOT_APPLIED` (inventory: no idempotency columns/indexes/writer functions; grants SELECT-only) |
| `checksops/production/providers` | does not exist |
| `financialActivationSqlApplied` | `false` |
| Freedom `auto_approve_enabled` | still `true` (not changed) |

## 6. TOTP enrollment — STOP for human

Target: `mcarletta@freedomadj.com`

| Check | Result |
| --- | --- |
| Application user | `7dbb3009-f059-4767-b5dc-1c5c72379330` |
| Freedom membership | active, tenant `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` (live inventory) |
| Freedom role | `admin` (also platform `{admin}`, financial) |
| Cognito pool | `us-east-1_h00WorYMT` |
| Cognito status | `CONFIRMED`, enabled, email verified |
| Live Cognito username/sub | `a45884b8-d051-70b3-b19d-ca704964c6e8` (created 2026-09-06T12:10:20Z) |
| Pre-T0 documented sub | `54a8b4c8-60d1-7028-cfbb-0eb2baee5592` — **no longer in the pool** (`expected-mappings.mjs` is stale) |
| TOTP enrolled | **no** (`UserMFASettingList` empty, preferred MFA unset) |

The agent did **not** associate TOTP, store a secret, set `SOFTWARE_TOKEN_MFA` preferred, or change role.

`identity_accounts.cognito_sub` was not re-selected in this phase (that would need new Lambda SQL). Production login is `cognito_sub → identity_accounts → 7dbb3009`. **Sign in first.** If you reach Freedom admin on `checksops.com`, the mapping is valid and you may enroll. If login returns `identity_not_linked`, stop and do not enroll.

### Exact human UI steps

1. Sign in at `https://checksops.com` as `mcarletta@freedomadj.com` using the **existing** email OTP / password / passkey path. Do **not** expect a TOTP prompt at login. Login MFA preference stays email OTP (`AWS_COGNITO_MFA_PREFERRED=false`).
2. Confirm you are Freedom admin (Command Center / tenant switcher). That is the mapping check.
3. Open `https://checksops.com/account/security` (Sign-in security).
4. On **Authenticator (TOTP)** click **Set up authenticator**.
5. The app calls `POST /prep/auth/mfa/associate`. Cognito generates the secret. Add that secret to **your** authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password, or iPhone Passwords). Do not paste it into chat, email, or a shared store.
6. Enter the current 6-digit code and click **Verify and enroll**. That calls `POST /prep/auth/mfa/verify` **without** a check-bound financial action.
7. Confirm the badge changes to **Enrolled**. The toast should say login still uses email OTP / password / passkey.
8. Stop. Do **not** click a deposit button. Do **not** set preferred MFA. A check-bound `POST /prep/auth/mfa/step-up` test comes later, after you confirm enrollment, and still without calling CheckAlt.

## 7. Auto-approve remediation verdict — DO NOT APPLY

**PRE-ACTIVATION BLOCKER.** Freedom `checkalt_tenant_accounts.auto_approve_enabled=true` (reconfirmed live).

Safest later change: one-row SQL on the Freedom tenant account. Do **not** use the Settings UI on AWS — `checkalt_tenant_accounts` is a `financial_or_provider` table and is not on the AWS write allowlist, so `TenantAutoApproveCard` would fail closed.

### Proof (code, not a live write)

| Claim | Evidence |
| --- | --- |
| AWS production submit does not require `true` | `checkalt-submit.mjs` never reads `auto_approve_enabled`. Config loads the column and ignores it. |
| `false` does not unregister Freedom | Register / SSO / deposit account are `sso_user_id`, `deposit_account_number`, `enabled`, `registered_at`. Live row: enabled, registered, SSO length 9, account last-4 `4573`. Separate columns. |
| `false` does not change deposit account / SSO | UPDATE touches only `auto_approve_enabled`. |
| `false` stops legacy automatic approve | Lovable `supabase/functions/checkalt-submit-deposit/index.ts` calls `/fincapture/deposit/approve` only when `auto_approve_enabled` is true. |
| Manual / controlled AWS flow remains | AWS submit never auto-approves. Manual approve remains `checkalt-approve-deposit` + step-up. Production handler today is submit+poll only; approve stays behind holds until a production approve handler is authorized. |

### Exact later SQL (not run)

```sql
BEGIN;

UPDATE public.checkalt_tenant_accounts
SET auto_approve_enabled = false
WHERE tenant_id = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a'
  AND auto_approve_enabled IS TRUE;

-- expect 1 row

COMMIT;
```

Do not also flip `checkalt_config.auto_approve_enabled` (platform default is already false). Do not touch `enabled`, `sso_user_id`, or `deposit_account_number`.

### Rollback (not run)

```sql
BEGIN;

UPDATE public.checkalt_tenant_accounts
SET auto_approve_enabled = true
WHERE tenant_id = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a'
  AND auto_approve_enabled IS FALSE;

-- expect 1 row

COMMIT;
```

## 8. Legacy money-path verdict

**LEGACY MONEY PATH BLOCKER**

| Path | This phase |
| --- | --- |
| Production Cognito SPA (`checksops.com` / `www`) | `supabase.functions.invoke` → same-origin `POST /prep/functions/v1/checkalt-*` → Lambda. Live unauth submit/approve: 403 `provider_disabled`. After future AWS activation this is the controlled path. |
| Lovable `nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/checkalt-submit-deposit` and `checkalt-approve-deposit` | Not called by the Cognito SPA. Function source still in repo and still auto-approves when the Freedom flag is true. This agent cannot resolve that hostname (egress). Production browsers can. If those functions remain deployed with production CheckAlt credentials, they can execute `/process` and `/approve` **without** AWS flags, Cognito step-up, or SQL 65. |

Classification:

- New Cognito SPA: **unreachable** for Lovable CheckAlt.
- Direct or leftover Lovable function invoke: **capable of production execution** if the functions are still live. That is the blocker.
- Do **not** delete or disable the Lovable functions in this phase.

One authoritative production money path requires a later, separately authorized disable of the Lovable CheckAlt submit/approve functions (or their production credentials) **and** Freedom `auto_approve_enabled=false`.

## 9. CheckAlt vendor blockers (external — do not create secrets)

Keep these as external blockers. Do not copy UAT.

- production username
- production password
- production webhook secret / signing method
- confirmation merchant `lockbox5` is production
- confirmation account ending `4573` is the correct production destination

Secret contract when later authorized: `checksops/production/providers` via `PROVIDER_SECRETS_ARN` only. Planned webhook (not configured): `https://checksops.com/prep/webhooks/checkalt`.

## 10. Blockers remaining before Phase 3B

1. Human TOTP enrollment for `mcarletta@freedomadj.com` (steps above). Confirm production login as Freedom admin first. Then a later check-bound step-up test **without** CheckAlt.
2. Freedom `auto_approve_enabled=false` (SQL above). Not applied in 3A.2.
3. **LEGACY MONEY PATH BLOCKER** — Lovable CheckAlt submit/approve can still execute independently if those functions remain live.
4. Vendor production credentials + webhook signing + merchant/account confirmation.
5. Create `checksops/production/providers` and set `PROVIDER_SECRETS_ARN` — not authorized.
6. SQL 65 — understood, schema-safe, **NOT_APPLIED** until credentials + authorization prerequisites are ready.
7. Money holds remain down (`AWS_CHECKALT_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`).
8. Dual-control is unavailable (only one Freedom financial user). TOTP is the only production step-up.

SPA authorization deploy is **done**. SQL 65 is no longer a count-drift blocker (58 referenced + 11 Lovable-era failed submits + 0 orphans + 0 AWS-created).

## STOP

Do not enroll TOTP from the agent. Do not change auto-approve. Do not apply SQL 65. Do not create secrets. Do not lift flags. Do not call CheckAlt. Do not move money.
