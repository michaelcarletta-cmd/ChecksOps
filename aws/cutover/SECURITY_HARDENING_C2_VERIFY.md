# C2 read-only verification: PASS

**Generated:** 2026-09-06T20:11:20Z  
**Mutated AWS infra:** no  
**STOP FOR REVIEW.**

Financial and provider activation remain **NOT AUTHORIZED**. This verification did not change IAM, Lambda, RDS, flags, CloudFormation, or secrets. Established Cognito smoke rotated tester passwords only.

A prior verify at 20:05Z **FAIL**ed because prep still used leftover `checksops-production-prep-api-role` and authenticated reads returned `503`. That leftover attach has been corrected.

## Verdict

| Item | Result |
|---|---|
| C1 RDS protection | **PASS** |
| C2 reviewed production role attached | **PASS** |
| Authenticated production data path | **PASS** |
| Financial / provider holds | **PASS** (OFF / NOT_APPLIED) |

**SECURITY HARDENING BATCH 1: PASS**

---

## Confirmations (2026-09-06T20:11Z)

| Check | Result | Evidence |
|---|---|---|
| Prep role `checksops-production-api-execution` | **PASS** | `arn:aws:iam::806168576068:role/checksops-production-api-execution` |
| Staging role unchanged | **PASS** | `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` |
| Roles separated | **PASS** | prep ≠ staging |
| Prep has no `PROVIDER_SECRETS_ARN` | **PASS** | unset |
| Staging still has provider secret + sandbox | **PASS** | ARN set; sandbox `true` |
| `/health` HTTP | **PASS** | 200, `status=ok`, `environment=production-prep` |
| `/health` `database` field | hardcoded `not-connected` in `aws/functions/api/index.mjs` (not a live probe) | |
| `/db-health` live probe | **PASS** | `authentication=ok`, `select1=ok`, `currentDatabase=checksops`, `currentUser=checksops`, PostgreSQL 18.3 |
| Cognito authentication | **PASS** | tester + C1C |
| Authenticated RDS read | **PASS** | tester 194 intake rows; mapped UUIDs match |
| Non-financial write | **PASS** | `check_message_reads` upsert 200, 1 row |
| Tenant isolation | **PASS** | tenants differ; C1C check rows 0 |
| Historical / current image sign | **PASS** | both signed; distinct samples |
| Public apex / www | **PASS** | 200 CloudFront |
| `/ops/readiness` holds | **PASS** | `holds.ok=true` |
| VPC / subnets / SGs | **PASS** | unchanged |
| C1 deletion protection / 35-day PITR / private / encrypted | **PASS** | Multi-AZ still OFF |
| CloudWatch Lambda Errors | **PASS** | 0 |
| Moov / CheckAlt / provider / financial | **OFF** | |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** | |

Provider-secret deny: agent still cannot `iam:GetRole` / simulate. Proof is compositional: live prep uses the reviewed template role (template omits `checksops/staging/providers`); prep has no `PROVIDER_SECRETS_ARN`; staging alone retains that secret on the SAM role.

## Remaining (not Batch 1 blockers)

- Leftover unused IAM role `checksops-production-prep-api-role` still exists; do not attach it.
- `/health` always prints `database: not-connected`; use `/db-health` or authenticated queries.
- Multi-AZ remains OFF (cost/interruption tradeoff).
- Phase 1 WAF / MFA / CORS / RLS are out of this batch.

**STOP FOR REVIEW.**
