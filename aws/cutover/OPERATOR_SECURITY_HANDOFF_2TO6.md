# Security Hardening #2–#6 handoff — blocked on role create

**Date:** 2026-09-07  
**STOP FOR REVIEW.** Do **not** deploy the role. Do **not** start #2–#6.

## Root cause

Two CloudFormation creates of `checksops-cursor-security-hardening-role`
**CREATE_FAILED** and rolled back:

`Maximum policy size of 10240 bytes exceeded for role
ChecksOpsCursorSecurityHardeningTemp`

That quota is the role’s **aggregate inline-policy** size. Splitting the
same statements into five inline policies still summed over 10,240. The
role **does not exist**.

## Fix in this package (not yet deployed)

`aws/production/cursor-security-hardening-role.yaml` now:

- Creates **six customer-managed policies** in the same stack
- Attaches them via `ManagedPolicyArns`
- Puts **zero** inline policies on the role (aggregate inline = 0)
- Keeps live OIDC trust `api.cursor.com` / `sts.amazonaws.com` /
  `user:325724407`
- Keeps the same Allow/Deny statements (no broadening)

## Deployments

| # | Service | Result |
|---|---|---|
| 1 | CloudTrail | **PASS** (prior) — not modified |
| 2–6 | SNS → Config → GuardDuty/Hub → Flow → alarms | **NOT STARTED** |

Money flags remain **false**. `64_` remains **NOT_APPLIED**. Trail stack
left **CREATE_FAILED**. `ChecksOpsCursorCloudStaging` was not modified.
