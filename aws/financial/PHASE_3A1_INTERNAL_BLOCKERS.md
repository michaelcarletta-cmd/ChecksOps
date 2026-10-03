# MONEY MOVEMENT LAUNCH GATE — PHASE 3A.1

**CLEAR INTERNAL BLOCKERS — STOP FOR REVIEW**

Financial activation was not started. Holds remain down. No production secret was created. SQL 64/65 were not applied. CheckAlt was not called.

## 1. Count drift verdict

**COUNT DRIFT EXPLAINED**

Phase 2.6 expected 58 `checkalt_deposits` rows. Phase 3A saw 69 Freedom rows. Live read-only inspect (Freedom admin, `BEGIN READ ONLY`):

| Bucket | Count |
| --- | --- |
| Total Freedom rows | 69 |
| With `checkalt_reference` | **58** — this is the restore expectation |
| Additional, no reference | **11** |
| Orphaned (no check row) | 0 |
| Created after AWS cutover (2026-09-06 20:00Z) | 0 |
| Created on/after Phase 2.7 dark deploy | 0 |

The additional 11 are **Lovable-era failed submit attempts** (status `error`, `submitted_at` null, no reference). All predate AWS cutover (created 2026-07-17 through 2026-07-22). Each points at a valid Freedom check that later reached `deposited` / `funds_released` and also has a referenced row. None were created by recent AWS work (`checksops` still has INSERT=false).

Seven checks have multiple deposit rows (failed retries + a later referenced row). That is historical Lovable retry behavior, not AWS duplication. **Do not delete, update, or repair.**

## 2. The additional 11 (sanitized)

All Freedom tenant `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`. No bank/account data.

| Deposit id | Check id | Status | Amount | Created | Check exists |
| --- | --- | --- | --- | --- | --- |
| `8ebcf1db-…e972` | `aad35598-…2146` | error | 780.00 | 2026-07-17T18:17Z | yes |
| `c00d449d-…a1b93b0` | `aad35598-…2146` | error | 780.00 | 2026-07-17T19:31Z | yes |
| `1326c3df-…0dead` | `aad35598-…2146` | error | 780.00 | 2026-07-17T19:58Z | yes |
| `9810721c-…d3de` | `969c3a7d-…300b` | error | 9443.25 | 2026-07-21T18:07Z | yes |
| `416ee49a-…675b8` | `969c3a7d-…300b` | error | 9443.25 | 2026-07-21T18:30Z | yes |
| `f5235653-…0233` | `73a324f5-…88a2d` | error | 6786.85 | 2026-07-21T19:36Z | yes |
| `fbcf0429-…70f7a3` | `1ff0a2e2-…88acb7` | error | 4925.93 | 2026-07-22T17:37Z | yes |
| `a6257446-…aacd9` | `32895d43-…7137a2` | error | 13937.57 | 2026-07-22T17:39Z | yes |
| `acc891d4-…fe1e1` | `73a324f5-…88a2d` | error | 6786.85 | 2026-07-22T18:05Z | yes |
| `8661a1f7-…262d` | `1ff0a2e2-…88acb7` | error | 4925.93 | 2026-07-22T18:34Z | yes |
| `af6f9bd7-…e4e555` | `1ff0a2e2-…88acb7` | error | 4925.93 | 2026-07-22T18:44Z | yes |

## 3. SQL 65 after 69-row review

Still **NOT_APPLIED**. Writer columns/indexes/functions/policies absent. Grants remain SELECT-only.

`ADD COLUMN IF NOT EXISTS` is non-destructive on all 69 rows, including the 11 NULL-reference error rows. The unique idempotency index is `WHERE idempotency_key IS NOT NULL`, so existing NULL keys do not collide.

Compatibility: **SCHEMA SAFE**. Count drift is explained and is not an apply-time schema conflict. **Do not apply in this phase.**

## 4. Frontend PR

- PR **#178** — `cursor/mm-phase3a1-stepup-spa-9053`
- SHA `f2d2d60fe3618eb3ddc76157452cfa39fac5da9d`
- **Do not merge until review.**

## 5. SPA authorization tests

- `aws/tests/frontend-financial-stepup.test.mjs`: missing check fail-closed, correct check passed, changing check requires new auth, stale cache cannot authorize another check, browser amount/tenant ignored
- `npm run test:aws-api`: **433 passed, 0 failed**
- Backend #175 bindings unchanged (TOTP/dual-control still server-derived)

**SAFE TO MERGE/DEPLOY SPA AUTHORIZATION FIX** after human review.

SPA-only deploy must not change Lambda config, flags, SQL, or secrets.

## 6. TOTP readiness (read only)

`mcarletta@freedomadj.com`

| Check | Result |
| --- | --- |
| Application user | `7dbb3009-f059-4767-b5dc-1c5c72379330` |
| Freedom membership | yes, tenant role admin |
| Financial role | yes (admin) |
| Cognito | confirmed, enabled, pool `us-east-1_h00WorYMT` |
| TOTP enrolled | **no** (`UserMFASettingList` empty, preferred MFA unset) |

Dual-control is not available (only one Freedom financial user). Do not lower the TOTP requirement.

### Human enrollment procedure (do not run now)

1. Sign in as `mcarletta@freedomadj.com` with the existing EMAIL_OTP / passwordless login. Do not enable preferred SOFTWARE_TOKEN_MFA (that would change login).
2. Open Account Security / `TotpManagerCard`.
3. Start AWS associate (`POST /prep/auth/mfa/associate`). Scan the otpauth URI / enter the setup key in the authenticator app.
4. Confirm with a 6-digit code (`POST /prep/auth/mfa/verify`) **without** treating that as a check-bound financial step-up.
5. Re-check `AdminGetUser` → `SOFTWARE_TOKEN_MFA` present, preferred MFA still unset.
6. Later financial step-up uses `POST /prep/auth/mfa/step-up` with `check_intake_item_id`. The server binds tenant and `amount_cents` from the check.

Do not enroll or reset from this agent.

## 7. Auto-approve verdict

**AUTO-APPROVE BLOCKER** (before any later activation). Do not change the setting in this phase.

Live Freedom `checkalt_tenant_accounts.auto_approve_enabled=true`.

Current AWS production submit (`checkalt-submit.mjs`) **loads** the flag and **does not use it**. It cannot:

- bypass Review or Endorsing
- bypass financial step-up
- auto-submit to CheckAlt
- auto-call `/fincapture/deposit/approve`
- change a check stage

While flags stay false, it causes **no action**.

The Lovable `checkalt-submit-deposit` edge function **does** call CheckAlt `/fincapture/deposit/approve` after a successful process when this bit is true (unless flagged or over ceiling). That is why the live `true` is a blocker before activation: it is production state waiting to be consumed if anyone hits Lovable logic or ports it onto AWS.

## 8. Cached JWT verdict

**LEGACY CLEANUP — NOT ACTIVATION BLOCKER**

`loadProductionCheckAltConfig` sets `cached_jwt: null` and `allowConfigJwt: false`. `getCheckAltJwt` only reads `checkalt_config.cached_jwt` when `allowConfigJwt` is true. The AWS production adapter does not consume the stored JWT. Value was not printed. Do not use it as a credential source.

## 9. Controlled ≤$5 test-check procedure (do not create yet)

Use the normal Freedom Check Command Center intake. Do not insert SQL or fabricate deposit rows.

1. Freedom admin (after TOTP enrollment, or with a second financial user for dual-control) signs in.
2. Command Center → upload a **real** ≤$5 controlled check: valid front JPEG and a rear **deposit** JPEG (not SVG-only).
3. Complete Review so `reviewed_at` is set.
4. Complete every payee endorsement (`signed` or `waived`).
5. Advance to Ready for Deposit / `approved_for_deposit` through the existing workflow.
6. Confirm no `checkalt_deposits` row and no `checkalt_reference`.
7. Stop. Do not click CheckAlt deposit until a later approved phase.

Do not reuse the three existing ready Freedom checks ($1,546.72 / $9,984.11 / $13,257.25).

## 10. Draft CheckAlt vendor request (do not send)

Subject: ChecksOps production FinCapture confirmation — host, credentials, merchant, webhook

Please confirm the following for ChecksOps / Freedom Adjustment production FinCapture. Do not send new secrets in email if a secure vault drop is preferred; we only need confirmation of names and host.

1. Production API host is `api2.checkalt.com` (HTTPS). Please confirm this is the correct production FinCapture origin (not `uatapi.checkalt.com`).
2. How should we receive the production API username and password for `POST /public/fincapture/authenticate`? We will store them only as `CHECKALT_USERNAME` / `CHECKALT_PASSWORD`.
3. Please confirm the production FI key we should send as `fiKey` (we already have a 36-character value in our config; we will not paste it here).
4. What production **merchant** header should ChecksOps send? Our live row currently says `lockbox5`. Is that correct for production, or is `lockbox5` UAT-only?
5. Production webhook: signing method and secret provisioning. Intended callback (not configured yet): `https://checksops.com/prep/webhooks/checkalt`.
6. Confirm the Freedom production depositor / SSO destination. We have a registered depositor whose deposit account ends in **4573**. Is that the correct production deposit destination?

We will not enable production CheckAlt execution until this is confirmed.

## 11. Blockers remaining before Phase 3B

Still closed (cannot clear internally):

1. Production username / password / webhook secret not in AWS
2. `checksops/production/providers` must not be created until those values are verified
3. Merchant `lockbox5` on production host — vendor must confirm
4. No ≤$5 Freedom candidate — create via the procedure above, later
5. TOTP not enrolled for the only Freedom financial user; dual-control unavailable
6. Freedom `auto_approve_enabled=true` — **AUTO-APPROVE BLOCKER** before activation
7. SPA #175 binding not in the live bundle until #178 is reviewed, merged, and SPA-only deployed

Cleared / no longer blocking internally:

- Production host **VERIFIED** (`api2.checkalt.com`)
- Count drift **EXPLAINED**
- SQL 65 schema still safe and non-destructive on all 69 rows (do not apply yet)
- Cached JWT is legacy and unused by AWS
- Frontend check-binding PR is written and tests passed (**do not merge yet**)

## Holds (unchanged)

`productionExecution=false`; provider/CheckAlt/Moov/financial flags false; webhook dry-run true; SQL 64/65 `NOT_APPLIED`; `PROVIDER_SECRETS_ARN` unset; no production provider secret.
