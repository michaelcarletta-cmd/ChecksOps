# Security Hardening #2–#6 handoff — STOP after #3 correction (not deployed)

**Date:** 2026-09-07  
**STOP FOR REVIEW.** `#3` Config collision fix is **prepared in git only**.
Temporary role **not** deleted. Trail stack left `CREATE_FAILED`. Money
flags remain **false**. `64_` remains **NOT_APPLIED**. **#4–#6 not
started.** **Do not deploy this correction yet.**

## Handoff gates (unchanged)

| Check | Result |
|---|---|
| Role `ChecksOpsCursorSecurityHardeningTemp` exists | **PASS** |
| Inline policies | **0** |
| Attached managed policies | **6/6** |
| Cursor OIDC assume | **PASS** |
| `GetCallerIdentity` is the temp role (not staging/root) | **PASS** |
| Moov / CheckAlt / Provider / Financial | All **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |
| Trail stack `checksops-production-security-trail` | Still **CREATE_FAILED** (untouched) |
| Live trail `checksops-production-mgmt-events` | Still present (not modified) |

## Deployments

| # | Service | Result |
|---|---|---|
| 1 | CloudTrail | **PASS** (prior). Not modified. |
| 2 | SNS | **PASS**. Operator will confirm `security@checksops.com`. |
| 3 | AWS Config | **CORRECTION PREPARED — NOT DEPLOYED.** |
| 4–6 | GuardDuty / Flow / Alarms | **NOT STARTED** |

## #3 correction (review only)

Modeled on CloudTrail `#1` / `checksops-production-mgmt-events`: new
unique names, existing bucket, do **not** modify
`checksops-production-security-trail`.

| Item | Exact value |
|---|---|
| Recorder name | `checksops-production-config-items` |
| Delivery-channel name | `checksops-production-config-items` |
| IAM role name | `checksops-production-config-items-recorder` |
| IAM role ARN | `arn:aws:iam::806168576068:role/checksops-production-config-items-recorder` |
| Role stack | `checksops-production-security-config-role` ← `security-config-role.yaml` |
| Recorder stack | `checksops-production-security-config` ← `security-config.yaml` |
| Bucket / prefix | `checksops-production-security-logs-806168576068` / `config` |
| Recording | `AllSupported` + global types. No remediation. |

Temp role change is **PassRole / GetRole / Deny-PassRole NotResource**
ARN swap only: old missing
`checksops-production-config-recorder` → new
`checksops-production-config-items-recorder`. No CreateRole for Config.
No other Allow added.

### One-time operator action (after review)

1. Create `checksops-production-security-config-role` (`CAPABILITY_NAMED_IAM`).
2. Update `checksops-cursor-security-hardening-role` with current YAML.
3. Delete empty `ROLLBACK_COMPLETE` `checksops-production-security-config`.
4. **Stop.** Do not create the recorder/channel yet. Do not start #4–#6.

### Rollback (after a later deploy)

`stop-configuration-recorder --configuration-recorder-name checksops-production-config-items`
then `delete-stack checksops-production-security-config`. Keep the role
unless it must also be removed (`delete-stack
checksops-production-security-config-role` only after the recorder stack
is gone). Never delete the trail stack or the logs bucket.

## Holds

- No CloudTrail / bucket / policy / staging / app / Cognito / CloudFront /
  WAF / DNS / RDS / migration-bridge / flag change
- Temp role kept
- Trail stack kept
