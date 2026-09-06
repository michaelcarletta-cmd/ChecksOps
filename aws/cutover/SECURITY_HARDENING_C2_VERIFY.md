# C2 read-only verification: FAIL

**Generated:** 2026-09-06T20:05:20Z  
**Mutated AWS infra:** no  
**STOP FOR REVIEW.**

Financial and provider activation remain **NOT AUTHORIZED**. This verification did not change IAM, Lambda, RDS, flags, CloudFormation, or secrets. Established Cognito smoke rotated tester passwords only (same method as prior T0 smokes).

## Verdict

| Item | Result |
|---|---|
| C1 RDS protection | **PASS** (re-verified) |
| C2 dedicated reviewed role attached | **FAIL** |
| Authenticated production data path | **FAIL** (`503 data_query_failed`, `/health` `database=not-connected`) |
| Financial / provider holds | **PASS** (still OFF / NOT_APPLIED) |

**SECURITY HARDENING BATCH 1: FAIL**

The CloudFormation stack `checksops-production-api-role` is **CREATE_COMPLETE** and outputs `checksops-production-api-execution`. Live Lambda `checksops-production-prep-api` was **not** switched to that role. It uses the older leftover `checksops-production-prep-api-role` (LastModified `2026-09-06T20:01:41Z`).

Do not treat C2 as closed. In the Lambda console, change **only** the execution role of `checksops-production-prep-api` to `checksops-production-api-execution`. Do not update stack `checksops-production-prep-api`. Do not attach the leftover `checksops-production-prep-api-role`.

---

## C1 re-verify (read-only)

Live `checksops-staging`:

| Control | Live |
|---|---|
| Deletion protection | **ENABLED** |
| Backup / PITR | **35 days**; `LatestRestorableTime` `2026-09-06T19:58:44Z` |
| Publicly accessible | `false` |
| Encrypted | `true` (KMS `ce55869a-433c-42e4-9b9a-3e0cf2c1d4b3`) |
| Multi-AZ | `false` |
| Identifier | `checksops-staging` (unchanged) |

---

## C2 / smoke checklist

| Check | Result | Evidence |
|---|---|---|
| Prep uses `checksops-production-api-execution` | **FAIL** | Live role `checksops-production-prep-api-role` |
| Staging remains on original SAM role | **PASS** | `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` |
| Roles separated | **PASS** (but wrong prod role) | prep ≠ staging |
| Prep has no `PROVIDER_SECRETS_ARN` | **PASS** | unset |
| Staging still has provider secret + sandbox | **PASS** | ARN set; sandbox `true` |
| Reviewed role cannot read `checksops/staging/providers` | **NOT PROVEN on the live role** | Agent denied `iam:GetRole` / `SimulatePrincipalPolicy`. Template for `checksops-production-api-execution` omits providers. Live leftover role policies are unknown. |
| CFN stack from reviewed template | **PASS** | `checksops-production-api-role` CREATE_COMPLETE; output ARN is the reviewed role |
| VPC / subnets / SGs unchanged | **PASS** | `vpc-09f2268778966ce97`; `subnet-0df2518070c5b9ff0`, `subnet-092e4e41821fba6c4`; `sg-0fe2698f236959353` |
| `DATABASE_NAME` / `FILES_BUCKET` / DB secret env | **PASS** | `checksops` / files bucket / secret ARN set |
| Public `checksops.com` / `www` | **PASS** | 200 CloudFront |
| Public API `/health` | **PARTIAL** | HTTP 200, `status=ok`, **`database=not-connected`** |
| `/ops/readiness` holds | **PASS** | `holds.ok=true` |
| Cognito authentication | **PASS** | tester + C1C `USER_PASSWORD_AUTH` succeeded |
| Authenticated RDS read | **FAIL** | both users `503 data_query_failed` |
| Non-financial write | **FAIL** | no check rows to upsert |
| Tenant isolation | **FAIL** | no tenant rows returned |
| Historical / current check-image sign | **FAIL** | no intake rows to sign |
| CloudWatch Lambda Errors | **PASS** (platform) | 0 Errors; 0 `ERROR` filter hits. Failures are application `503`, not crashes |
| Moov / CheckAlt / provider / financial | **OFF** | prep + staging flags false |
| Prep sandbox | **OFF** | `false` |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** | repo stub |

---

## What this means

The leftover role can invoke the function (VPC still attached; short successful Lambda reports) but cannot open the application database. `/health` reports `databaseSecretConfigured=true` and `database=not-connected`. That matches a role missing `secretsmanager:GetSecretValue` (and/or KMS) on the application DB secret.

The reviewed template role is already created by CloudFormation. It was not attached.

## Operator fix (you; this agent will not do it)

1. Lambda → `checksops-production-prep-api` → Configuration → Permissions.
2. Execution role → `checksops-production-api-execution` only.
3. Do not change env vars, VPC, staging, or flags.
4. Ask for another read-only verify.

**STOP FOR REVIEW.**
