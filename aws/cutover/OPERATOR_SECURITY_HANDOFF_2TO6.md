# Security Hardening #2–#6 handoff — STOP after #4 PASS

**Date:** 2026-09-07  
**STOP FOR REVIEW.** `#4` GuardDuty + Security Hub is **PASS**.
Temporary role **not** deleted. Trail stack left `CREATE_FAILED`. Money
flags remain **false**. `64_` remains **NOT_APPLIED**. **#5–#6 not
started.**

Caller: `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorSecurityHardeningTemp/checksops-sec-hard`

## Gates (this run)

| Check | Result |
|---|---|
| `GetCallerIdentity` is the temp role | **PASS** |
| Moov / CheckAlt / Provider / Financial | All **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |

## Deployments

| # | Service | Result |
|---|---|---|
| 1 | CloudTrail | **PASS** (prior). Still logging. |
| 2 | SNS | **PASS**. Email still `PendingConfirmation`. |
| 3 | AWS Config | **PASS**. Still `recording: true`, `lastStatus: SUCCESS`. |
| 4 | GuardDuty + Security Hub | **PASS**. Stack `checksops-production-security-posture` `CREATE_COMPLETE`. |
| 5–6 | Flow / Alarms | **NOT STARTED** |

## #4 evidence

| Item | Value |
|---|---|
| Stack | `checksops-production-security-posture` `CREATE_COMPLETE` |
| Detector ID | `298dc17133dd46b1b2cf755bc1380e1f` (exactly one) |
| Status | `ENABLED` |
| Finding publishing | `FIFTEEN_MINUTES` |
| `EBS_MALWARE_PROTECTION` | `DISABLED` |
| Hub ARN | `arn:aws:securityhub:us-east-1:806168576068:hub/default` |
| `ControlFindingGenerator` | `SECURITY_CONTROL` |
| `AutoEnableControls` | `true` |
| Default standards | CIS AWS Foundations 1.2.0, AWS FSBP 1.0.0 — both **PENDING** first enable |
| Detection only | No WAF/SG/NACL/remediation change |

Warning: Security Hub standard subscriptions are present but still
`PENDING` (normal after first enable). GuardDuty default features besides
EBS malware (CloudTrail/DNS/Flow/S3/EKS audit/RDS login/Lambda network)
came up ENABLED; runtime/malware/AI features stay DISABLED.

## Holds

- Trail stack still `CREATE_FAILED`
- Bucket policy SHA-256 unchanged `3eda5eb41fbfa499…`; PAB all-block
- No staging / app / Cognito / CloudFront / WAF / DNS / RDS change
- Public `/` `/login` `/endorse` `/sign` and API `/health` `/db-health`
  `/ops/readiness` `/financial/status` 200; `productionExecution` false
- Temp role kept
