# Security Hardening #2–#6 handoff — blocked on role create

**Date:** 2026-09-07  
**STOP FOR REVIEW.** Do **not** deploy the role. Do **not** start #2–#6.

## Root cause

CloudFormation stack `checksops-cursor-security-hardening-role`
**CREATE_FAILED** and rolled back:

`Maximum policy size of 10240 bytes exceeded for role
ChecksOpsCursorSecurityHardeningTemp`

The role **does not exist**. The unsplit inline document was 12,575
characters compact / 16,954 pretty.

## Fix in this package (not yet deployed)

`aws/production/cursor-security-hardening-role.yaml` now attaches five
inline policies. Same Allow/Deny statements. Live OIDC trust:

- provider `api.cursor.com`
- aud `sts.amazonaws.com`
- sub `user:325724407`

| Policy | Purpose |
|---|---|
| `HardeningAllowCfnSns` | #2 stacks + SNS |
| `HardeningAllowConfigPosture` | #3 Config + #4 GuardDuty/Hub |
| `HardeningAllowFlowAlarms` | #5 Flow Logs + #6 alarms |
| `HardeningAllowReadonly` | CloudTrail / logs bucket / RDS / Lambda flags |
| `HardeningDenyGuardrails` | Financial/app/IAM/stack/bucket Denies |

## Deployments

| # | Service | Result |
|---|---|---|
| 1 | CloudTrail | **PASS** (prior) — not modified |
| 2–6 | SNS → Config → GuardDuty/Hub → Flow → alarms | **NOT STARTED** |

Money flags remain **false**. `64_` remains **NOT_APPLIED**. Trail stack
left **CREATE_FAILED**. `ChecksOpsCursorCloudStaging` was not modified.
