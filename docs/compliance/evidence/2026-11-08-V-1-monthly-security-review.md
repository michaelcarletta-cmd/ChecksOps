# Monthly security review, November 2026 (row V-1)

**Read:** 2026-11-08 22:24 UTC, read-only as `user/claude-code` (Security Hub `GetFindings`,
GuardDuty `ListFindings`, Inspector `ListFindingAggregations`, `npm audit --package-lock-only` on
every lockfile at main `014d3dfa2`)
**Reviewer:** Michael Carletta, CEO, signs off below
**Matrix rows:** CC4.1, CC4.2, CC7.1; risk R11

## Findings by source (account `806168576068`, `us-east-1`)

| Source | Critical | High | Medium | Low | Notes |
|---|---|---|---|---|---|
| Security Hub (active, workflow NEW or NOTIFIED, compliance FAILED) | **0** | **0** | 118 | 32 | AWS Foundational Security Best Practices |
| GuardDuty (unarchived, severity 4+) | **0** | **0** | — | — | |
| Inspector (EC2, ECR, Lambda, Lambda code) | **0** | **0** | 0 | 0 | |

**Result: no critical or high finding open anywhere.** Same as the 2026-11-06 read
(`docs/compliance/SOC2_CONTROL_MATRIX.md` "Closed").

### Medium and low: the largest groups (Security Hub control id, count)

| Control | Count | What it is | Decision |
|---|---|---|---|
| CloudFormation.4, .3 | 18, 17 | Stacks without a service role or termination protection | **Accept for now**: stacks deploy through the guarded workflows; termination protection is a cheap later win |
| SecretsManager.1 | 15 | Secrets without automatic rotation | **Plan**: rotate the database admin and app secrets first (they back the SQL runner and the API) |
| S3.9 | 11 | Buckets without server access logging | **Plan**: turn on for the production files bucket (CloudTrail data events are the alternative) |
| S3.5 | 9 | Buckets that do not refuse non-TLS requests | **Plan**: add a TLS-only statement to each production bucket policy, starting with the files bucket; the new `us-east-2` copy has one from the start (`ops/security/FILES_BUCKET_REPLICATION_2026_11.md`) |
| EC2.15 | 6 | Subnets that assign public IPs | Review: default-VPC subnets; production runs in private subnets |
| S3.13 | 6 | Buckets without a lifecycle rule (low) | Accept |
| APIGateway.8 | 3 | Routes without an authorization type | **Expected**: the API checks Cognito tokens in the Lambda (`withIdentity`), and public token routes (sign, endorse, invoice) are public by design |
| RDS.9, RDS.10, RDS.23 | 2, 2, 2 | Database logs to CloudWatch, IAM database auth, default port | Plan RDS.9 (Postgres logs to CloudWatch); accept RDS.10 and RDS.23 |
| Cognito.1, Cognito.4 | 2, 2 | Cognito threat protection not in full-function mode | **Review**: complements the login MFA now required (2026-11-06) |
| CloudFront.15, CloudFront.4 | 2, 2 | TLS policy; no origin failover (low) | Plan CloudFront.15 (TLS 1.2 2021 policy); accept CloudFront.4 |

Nothing above is changed by this record. Each "Plan" item becomes its own owner-approved
change.

## Dependencies (`npm audit`, every lockfile at main `014d3dfa2`)

| Lockfile | High | Moderate | Low |
|---|---|---|---|
| `aws/functions/api` (production API) | 0 | 0 | 0 |
| `aws/identity/oneshot`, `aws/rls/oneshot` | 0 | 0 | 0 |
| root (website and build tools) | **0** | 20 | 4 |
| `mobile` (build tooling) | 0 | 3 | 0 |

**The two high alerts are closed.** `xlsx` was replaced by `exceljs` (#1675) and shipped to
production on 2026-11-07 (website upload run 42322639757, lock #1678). The moderate and low entries
are the same build and dev tools triaged on 2026-11-06
(`docs/compliance/evidence/2026-11-06-V-1-dependency-triage.md`). The patch-level ones (`fflate`,
`yaml`, `@babel/core`, `@tootallnate/once`, mobile `@capacitor/cli`) are refreshed in a separate
PR. (npm counts one entry per affected package; GitHub's Dependabot count is per advisory.)

## Sign-off

Reviewed by: ______________________ (Michael Carletta, CEO)  Date: __________

Next review due: 2026-12-31 (monthly).
