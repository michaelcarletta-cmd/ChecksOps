# Security Hardening #2–#6 handoff — FAIL (assume blocked)

**Date:** 2026-09-07  
**STOP FOR REVIEW.** Temporary role was **not** assumed. **#2–#6 were not
deployed.** Temporary role was **not** deleted. Trail stack left
`CREATE_FAILED`. Money flags remain **false**. `64_` remains
**NOT_APPLIED**.

## Handoff checks

| Check | Result |
|---|---|
| Stack `checksops-cursor-security-hardening-role` CREATE_COMPLETE | **NOT_CONFIRMED** from `ChecksOpsCursorCloudStaging` (`DescribeStacks` → does not exist / not visible) |
| Role `ChecksOpsCursorSecurityHardeningTemp` exists | **NOT_CONFIRMED** (`iam:GetRole` denied on staging) |
| Assume via Cursor OIDC | **FAIL** — `sts:AssumeRoleWithWebIdentity` AccessDenied |
| `GetCallerIdentity` is the temp role (not root, not staging) | **FAIL** — never assumed; this session is still staging when using the default ARN |
| Moov / CheckAlt / Provider / Financial | All **false** (read via staging `GetFunctionConfiguration`) |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** (stub `SELECT 'NOT_APPLIED'`; not executed) |
| Trail stack `checksops-production-security-trail` | Still **CREATE_FAILED** (untouched) |

## Why assume failed

Current `/v1/tokens/oidc` JWT (`aud=sts.amazonaws.com`):

- `iss` = `https://api.cursor.com`
- `sub` = `user:325724407`
- `aud` = `sts.amazonaws.com`

The same token **does** assume `ChecksOpsCursorCloudStaging`.  
The reviewed temp-role trust was the older
`oidc.cursor.sh` + `repo:michaelcarletta-cmd/ChecksOps:environment:staging`
snapshot. That condition does not match live tokens.

Corrected trust (permissions unchanged):
`aws/production/cursor-security-hardening-role-trust.json`

## One-time Console fix

IAM → Roles → `ChecksOpsCursorSecurityHardeningTemp` → Trust
relationships → Edit → paste the corrected JSON → Update. Do not add
policies. Do not edit `ChecksOpsCursorCloudStaging`.

Then reopen the handoff. Do not start #2–#6 until
`GetCallerIdentity` shows `ChecksOpsCursorSecurityHardeningTemp`.

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

1. **This handoff:** temp role trust must accept `api.cursor.com` /
   `user:325724407` before Cursor can deploy #2–#6.
2. **MUST FIX before financial activation:** API-behind-CloudFront (unchanged).
3. Detection services #2–#6 still not live until the handoff is retried.
