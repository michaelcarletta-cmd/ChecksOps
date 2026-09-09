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
| Parent of merge | `f2d2d60fe3618eb3ddc76157452cfa39fac5da9d` |

`f2d2d60` is an ancestor of `origin/main`.

## 2. Production SPA-only deploy

**Pending fill after deploy.** Target:

| Item | Value |
| --- | --- |
| Build | `vite build --mode aws` with production Cognito + `VITE_CHECKSOPS_API_URL=/prep` |
| Bucket | `checksops-production-frontend-806168576068` |
| CloudFront | `E1B0ZWWO5559U5` / `checksops.com` |
| Invalidation | `/*` |
| Pre-deploy live bundle | `/assets/index-BIF51Tn1.js` (no `/auth/mfa/step-up`) |

Do not change Lambda code/configuration, WAF, origin-verify, SQL, secrets, or flags.

## 3. #178 production validation

Required live path (no provider transaction):

`deposit.submit` → `useFinancialGuard` → `StepUpDialog` → AWS Cognito `POST /prep/auth/mfa/step-up` with `check_intake_item_id`

Source on `main` (`c3b4dab4`):

- `CheckCommandCenter.tsx` calls `guardFinancial("deposit.submit", { checkId })`
- `DepositOperationsConsole.tsx` same
- `CheckAltSettings.tsx` calls `guardFinancial("deposit.approve", { checkId: args.check_intake_item_id })`
- `buildFinancialStepUpRequest` fails closed without a check id
- cache key is `user|action|checkId`; stale cache cannot authorize another check
- `awsStepUpBody` sends `check_intake_item_id` only; browser `amount` / `amount_cents` are dropped
- backend `#175` still derives tenant + `amount_cents` from the server check row

Automated proof (no money movement): `aws/tests/frontend-financial-stepup.test.mjs`.

Live bundle proof is filled after deploy.

## 4. Lambda unchanged

**Pending fill after deploy.** Required: `CodeSha256`, `LastModified`, and flag map identical before and after. `PROVIDER_SECRETS_ARN` remains unset.

## 5. Holds unchanged

Required remaining state (must stay):

| Hold | Required |
| --- | --- |
| `AWS_CHECKALT_ENABLED` | `false` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `AWS_COGNITO_MFA_PREFERRED` | `false` |
| `productionExecution` | `false` |
| SQL 64 | `NOT_APPLIED` |
| SQL 65 | `NOT_APPLIED` |
| `checksops/production/providers` | does not exist |
| `PROVIDER_SECRETS_ARN` | unset |

## 6. TOTP enrollment — STOP for human

Target: `mcarletta@freedomadj.com`

Preconditions (Phase 3A.1 live + this phase Cognito read-only):

| Check | Expected |
| --- | --- |
| Application user | `7dbb3009-f059-4767-b5dc-1c5c72379330` |
| Cognito sub | `54a8b4c8-60d1-7028-cfbb-0eb2baee5592` |
| Pool | `us-east-1_h00WorYMT` |
| Cognito status | `CONFIRMED`, enabled |
| Freedom membership | active, tenant `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` |
| Freedom role | `admin` |
| Mapping | valid (sub ≠ application user id) |
| TOTP enrolled | **no** — `UserMFASettingList` empty, preferred MFA unset |

The agent must **not** associate TOTP, store the secret, set `SOFTWARE_TOKEN_MFA` preferred, or change role.

### Exact human UI steps

1. Sign in at `https://checksops.com` as `mcarletta@freedomadj.com` using the **existing** email OTP / password / passkey path. Do **not** expect a TOTP prompt at login. Login MFA preference stays email OTP (`AWS_COGNITO_MFA_PREFERRED=false`).
2. Open `https://checksops.com/account/security` (Sign-in security). White-label Settings also hosts the same Authenticator card if you are on that shell.
3. On **Authenticator (TOTP)** click **Set up authenticator**.
4. The app calls `POST /prep/auth/mfa/associate`. Cognito generates the secret. The page shows the secret (and copies it only if you click copy). Add that secret to **your** authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password, or iPhone Passwords). Do not paste it into chat, email, or a shared store.
5. Enter the current 6-digit code and click **Verify and enroll**. That calls `POST /prep/auth/mfa/verify` **without** a check-bound financial action.
6. Confirm the badge changes to **Enrolled**. The toast should say login still uses email OTP / password / passkey.
7. Stop. Do **not** click a deposit button. Do **not** set preferred MFA. A check-bound `POST /prep/auth/mfa/step-up` test comes later, after you confirm enrollment, and still without calling CheckAlt.

## 7. Auto-approve remediation verdict — DO NOT APPLY

**PRE-ACTIVATION BLOCKER.** Freedom `checkalt_tenant_accounts.auto_approve_enabled=true`.

Safest later change: one-row SQL on the Freedom tenant account. Do **not** use the Settings UI on AWS — `checkalt_tenant_accounts` is a `financial_or_provider` table and is not on the AWS write allowlist, so the `TenantAutoApproveCard` update would fail closed.

### Proof (code, not a live write)

| Claim | Evidence |
| --- | --- |
| AWS production submit does not require `true` | `checkalt-submit.mjs` never reads `auto_approve_enabled`. Config loads the column and ignores it. |
| `false` does not unregister Freedom | Register / SSO / deposit account are `sso_user_id`, `deposit_account_number`, `enabled`, `registered_at`. Separate columns. AWS register is a different function (`checkalt-register-account`) and does not gate on this bit. |
| `false` does not change deposit account / SSO | UPDATE touches only `auto_approve_enabled` (optional: `auto_approve_max_cents` left alone). |
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

**LEGACY MONEY PATH BLOCKER** — still capable of production CheckAlt independently of the new AWS controls, if the Lovable edge functions remain deployed with production CheckAlt credentials.

| Path | After this SPA deploy | After future AWS activation |
| --- | --- | --- |
| Production `checksops.com` Cognito SPA | `supabase.functions.invoke` → same-origin `POST /prep/functions/v1/checkalt-submit-deposit` → Lambda. Holds return `provider_disabled` / not `productionCheckAltExecutionAllowed`. | This becomes the AWS-controlled path (authz + flags + SQL 65). |
| Lovable `nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/checkalt-submit-deposit` and `checkalt-approve-deposit` | Not called by the Cognito SPA. Still present as repo code. If still deployed, a leftover Lovable session or a direct function call can execute `/fincapture/deposit/process` and, when `auto_approve_enabled=true`, `/approve`. That path does **not** consult AWS flags, Cognito step-up, or SQL 65. | **Independent of AWS controls.** |

Classification:

- Production browser on the new Cognito SPA: **unreachable** for Lovable CheckAlt (adapter forces `/prep`).
- Direct or leftover Lovable function invoke: **capable of production execution** if those functions are still live. That is the blocker.
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

1. Human TOTP enrollment for `mcarletta@freedomadj.com` (steps above). Then a later check-bound step-up test **without** CheckAlt.
2. Freedom `auto_approve_enabled=false` (SQL above). Not applied in 3A.2.
3. **LEGACY MONEY PATH BLOCKER** — Lovable CheckAlt submit/approve can still execute independently if those functions remain live.
4. Vendor production credentials + webhook signing + merchant/account confirmation.
5. Create `checksops/production/providers` and set `PROVIDER_SECRETS_ARN` — not authorized.
6. SQL 65 — understood, schema-safe, **NOT_APPLIED** until credentials + authorization prerequisites are ready.
7. Money holds remain down (`AWS_CHECKALT_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`).
8. Dual-control is unavailable (only one Freedom financial user). TOTP is the only production step-up.

SQL 65 is no longer a count-drift blocker (58 referenced + 11 Lovable-era failed submits + 0 orphans + 0 AWS-created).

## STOP

Do not enroll TOTP from the agent. Do not change auto-approve. Do not apply SQL 65. Do not create secrets. Do not lift flags. Do not call CheckAlt. Do not move money.
