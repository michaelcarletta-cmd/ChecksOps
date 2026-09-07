# Security Hardening #2–#6 handoff — FAIL (assume still blocked)

**Date:** 2026-09-07 (retry after reported trust update)  
**STOP FOR REVIEW.** Temporary role was **not** assumed. **#2–#6 were not
deployed.** Temporary role was **not** deleted. Trail stack left
`CREATE_FAILED`. Money flags remain **false**. `64_` remains
**NOT_APPLIED**.

## Handoff checks

| Check | Result |
|---|---|
| Assume `ChecksOpsCursorSecurityHardeningTemp` via Cursor OIDC | **FAIL** — `AssumeRoleWithWebIdentity` AccessDenied |
| `GetCallerIdentity` is the temp role (not root, not staging) | **FAIL** — this probe session is `ChecksOpsCursorCloudStaging` |
| Same token assumes `ChecksOpsCursorCloudStaging` | **PASS** |
| Live token `iss` | `https://api.cursor.com` |
| Live token `aud` | `sts.amazonaws.com` |
| Live token `sub` | `user:325724407` |
| Moov / CheckAlt / Provider / Financial | All **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** (stub; not executed) |
| Trail stack `checksops-production-security-trail` | Still **CREATE_FAILED** (untouched) |
| Stack `checksops-cursor-security-hardening-role` | Still **not visible** to staging (`DescribeStacks` → does not exist) |
| `iam:GetRole` on the temp role from staging | **Denied** (cannot read the live trust from here) |

## Why this retry still fails

The token that assumes staging is unchanged. If the live temp-role trust
were exactly `aws/production/cursor-security-hardening-role-trust.json`,
this assume would succeed. It did not, so the live document still does
not match the token (wrong provider, wrong condition keys, extra
conditions, or the role name/account is not the one being assumed).

Required live trust (no extra `StringEquals` keys):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CursorCloudOidcLiveApiCursorCom",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::806168576068:oidc-provider/api.cursor.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "api.cursor.com:aud": "sts.amazonaws.com",
          "api.cursor.com:sub": "user:325724407"
        }
      }
    }
  ]
}
```

Confirm in Console and paste back if it differs:

1. Role name is exactly `ChecksOpsCursorSecurityHardeningTemp` in account
   `806168576068`.
2. Trusted entity is `api.cursor.com`, **not** `oidc.cursor.sh`.
3. Condition keys are `api.cursor.com:aud` and `api.cursor.com:sub`
   (not `oidc.cursor.sh:…`).
4. `sub` is `user:325724407` (the `user:` prefix is required).
5. There are **no** extra conditions (`environment_id`, `repo_url`, etc.).
6. The account already has OIDC provider `api.cursor.com` (staging assume
   proves that provider works for this token).

Do **not** edit `ChecksOpsCursorCloudStaging`. Do **not** attach extra
policies to the temp role.

## Deployments

| # | Service | Result |
|---|---|---|
| 1 | CloudTrail `checksops-production-mgmt-events` | **PASS** (prior) — not modified |
| 2 | SNS | **NOT STARTED** |
| 3 | AWS Config | **NOT STARTED** |
| 4 | GuardDuty + Security Hub | **NOT STARTED** |
| 5 | VPC Flow Logs | **NOT STARTED** |
| 6 | CloudWatch alarms | **NOT STARTED** |

## Remaining security blockers

1. **This handoff:** Cursor still cannot assume
   `ChecksOpsCursorSecurityHardeningTemp`.
2. **MUST FIX before financial activation:** API-behind-CloudFront
   (unchanged).
3. Detection #2–#6 still not live.
