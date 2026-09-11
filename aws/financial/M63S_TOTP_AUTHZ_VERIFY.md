# M6.3S — Verify production financial TOTP authorization test

**STOP FOR REVIEW.** Read-only verification of Michael’s one authorization-only
financial TOTP step-up on Freedom check `3a77367e-5e79-4189-bfcd-225aa077afd8`.

This phase did **not**:
- trigger another TOTP challenge
- request, capture, or log a TOTP code
- submit a deposit
- call CheckAlt or Moov
- change money flags, Cognito MFA, identity mapping, or SQL

---

## Return card

```
STEPUP RESULT: SUCCESS
  2026-09-11T19:06:51.019Z POST /prep/auth/mfa/step-up 200 (697 bytes)
  IP 71.200.255.218  requestId DjGjziFloAMEYwA=  integrationStatus 200
  financial_stepup_log row created_at 2026-09-11T19:06:51.185Z
  id 83d12153-e47a-48c9-9bbf-cbcb8b2bdb80

NEW LOG ROWS: 1
  financial_stepup_log 4 → 5
  Michael rows 3 → 4
  exactly one new successful Michael row since M6.3O (17:41Z)

LOG BINDING: PASS
  application_user_id 7dbb3009-f059-4767-b5dc-1c5c72379330
  tenant_id 2eff5f1a-929d-4ce3-9a8b-cd96b98df42a (Freedom)
  action_key deposit.submit
  check_id 3a77367e-5e79-4189-bfcd-225aa077afd8
  amount_cents 287720 (server-derived; check amount 2877.20)
  source app_financial_totp
  factor_type totp  succeeded true  operation deposit.submit

TIMESTEP CONSUMED: YES
  last_used_timestep null → 59638453
  verified_at still 2026-09-11T14:43:13.231Z
  failed_attempts 0  locked false

CHECK MUTATED: NO
  status deposited  check_stage funds_released
  updated_at still 2026-08-25T13:57:27.691Z

CHECKALT CHANGED: NO
  checkalt_deposits still 69
  0 rows for this check  0 rows for forbidden check 623442f0…
  0 provider_http_attempted_at after M6.3O

MOOV CHANGED: NO
  payment_transfers 0  payment_transfer_groups 0
  moov_invoices 0  moov_invoice_customers 0

PROVIDER CALLS: NONE
  API GW: no deposit/checkalt/moov paths
  Lambda logs: 0 hits for "checkalt" or "moov" after 19:01Z
  money-execution flags remain false

MONEY FLAGS: UNCHANGED (all false)
  AWS_MOOV_ENABLED=false
  AWS_PROVIDER_EXECUTION_ENABLED=false
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false
  AWS_CHECKALT_ENABLED=false
  AWS_PROVIDER_LIVE_READS_ENABLED=true
  AWS_PROVIDER_WEBHOOK_DRY_RUN=true
  CHECKSOPS_ENV=production-prep
  Prep API CodeSha256 l9nHBQHn+cwwroKO9+czOXi2WMjoeChOpgVFtR0Tj7A=

COGNITO MFA: EMPTY
  UserMFASettingList null  PreferredMfaSetting null
  UserLastModifiedDate 2026-09-10T18:56:10.659Z
  AWS_COGNITO_MFA_PREFERRED=false

EMAIL_OTP HEALTHY: YES
  19:06:50Z POST /prep/auth/refresh 200 then GET /prep/identity/me 200 (1159)
  identity_accounts still a45884b8… → 7dbb3009…  linked_at 16:33:20.421Z

MONEY MOVED: NO

SAFE TO PROCEED BACK TO MOOV RECIPIENT ONBOARDING: YES
  under existing holds (money flags stay false; no deposit; no SQL72)

GO/NO-GO: GO to resume Moov recipient onboarding (dark / live-reads)
  NO-GO for enabling money flags, CheckAlt submit, or money movement

STOP FOR REVIEW.
```

---

## Trace (IP 71.200.255.218)

| Time (UTC) | Call | Result |
| --- | --- | --- |
| 19:06:50.140 | `POST /prep/auth/refresh` | 200 / 4157 |
| 19:06:50.725 | `GET /prep/identity/me` | 200 / 1159 |
| 19:06:51.019 | `POST /prep/auth/mfa/step-up` | **200 / 697** |
| 19:06:51.185 | `financial_stepup_log` insert | 1 row |
| 19:06:51.417 | `POST /prep/auth/mfa/status` | 200 / 1074 |

No subsequent deposit, CheckAlt, or Moov HTTP. Polling `data/query` 200 continued.

Incidental: `POST /prep/data/write` 200 at 19:05:35Z (776 bytes), before the
step-up. Selected check `updated_at`, CheckAlt deposits, and Moov tables did
not change. `financial_totp_rate_limits` 5 → 6 is the expected step-up rate
bucket, not money movement.

---

## Compared to M6.3O pre-flight snapshot

| Item | M6.3O (17:41Z) | M6.3S now |
| --- | --- | --- |
| `financial_stepup_log` | 4 | **5** |
| Michael step-up rows | 3 | **4** |
| selected check `updated_at` | `2026-08-25T13:57:27.691Z` | same |
| selected check deposits | 0 | 0 |
| `checkalt_deposits` | 69 | 69 |
| `payment_transfers` | 0 | 0 |
| TOTP `last_used_timestep` | `null` | **59638453** |
| TOTP `verified_at` | `2026-09-11T14:43:13.231Z` | same |

Read-only RDS probe used confirm `M63S_AUTHZ_VERIFY_READONLY` on
`checksops-staging-rehearsal-oneshot`. Original zip restored immediately
(CodeSha256 `Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=`).
