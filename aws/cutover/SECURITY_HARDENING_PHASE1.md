# ChecksOps Security Hardening Phase 1

**Generated:** 2026-09-06T17:28:40Z  
**Decision:** **CHECKSOPS SECURITY HARDENING READINESS: FAIL**  
**STOP FOR REVIEW.**

Public production cutover has passed. Financial and provider activation is **not** authorized. This phase is an audit and plan only.

No production infrastructure was changed. Moov, CheckAlt, provider execution, financial execution, and `64_financial_activation_grants.sql` were not activated.

## Verdict

The AWS production path is **not ready** for Moov/CheckAlt/financial activation or for treating current controls as sufficient for check images, banking metadata, and tenant financial workflows.

Holds that remain healthy do **not** make this a PASS. Category A still has CRITICAL and HIGH gaps.

## Method

Read-only inspect of account `806168576068` / `us-east-1` at 2026-09-06T17:28:40Z plus repo IaC and API code. GuardDuty, Security Hub, AWS Config, VPC Flow Logs, and KMS alias listing were **IAM-denied** for this role and are treated as unverified.

Live resources:

| Layer | Resource |
|---|---|
| CloudFront | `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net` |
| ACM | `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` ISSUED |
| Prep API | `checksops-production-prep-api` |
| Staging API | `checksops-staging-api` |
| Cognito | `us-east-1_h00WorYMT` |
| RDS | `checksops-staging` PostgreSQL 18.3 |
| Files | `checksops-staging-privatefilesbucket-erzqsolpucjp` |
| Frontend | `checksops-production-frontend-806168576068` |
| VPC | `vpc-09f2268778966ce97` |

## Holds still in force (do not lift)

| Hold | Live |
|---|---|
| Moov | OFF (prep + staging) |
| CheckAlt | OFF |
| Provider execution | OFF |
| Financial execution | OFF (`AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`) |
| Staging sandbox execution | **ON** (`true` on staging Lambda only) |
| `64_financial_activation_grants.sql` | NOT_APPLIED |
| Both migration bridges | preserved (`read_only` / `sign_only`) |
| Lovable `185.158.133.1` | documented rollback target |

## What is already sound

- CloudFront HTTPS redirect, ACM attached, aliases `checksops.com` / `www.checksops.com`
- RDS not publicly accessible; storage encrypted with KMS key `ce55869a-433c-42e4-9b9a-3e0cf2c1d4b3`
- S3 public-access blocks on files and frontend buckets; files versioning enabled
- Cognito deletion protection ACTIVE; password min 12 with complexity; `PreventUserExistenceErrors=ENABLED`; Advanced Security **ESSENTIALS**
- API identity chain `Cognito sub → identity_accounts.application_user_id` (sub ≠ application UUID)
- Financial authz keeps `activated: false`; `canExecuteProduction` stays off while flags are false
- Tenant isolation smoke PASS after public cutover
- API DB client uses TLS `rejectUnauthorized: true` and refuses `checksops_admin`
- SAM template forbids `Environment=production`

---

## Findings

Severity is relative to a platform that stores check images, banking information, tenant financial data, and (later) payment workflows.

### CRITICAL

| ID | Finding | Evidence |
|---|---|---|
| C1 | Production application data lives on RDS instance `checksops-staging` with **deletion protection OFF** | Live `DeletionProtection=false` |
| C2 | Prep API and staging API share one IAM role; staging has **sandbox provider execution ON** | Both use `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi`; staging `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true` |
| C3 | Public production edge has **no WAF** and **no API Gateway throttle / usage plan** | CloudFront `WebACLId` empty; templates have no `Throttling*` |
| C4 | Production Cognito **MFA is OFF** for users who can see check images and financial records | Live `MfaConfiguration=OFF`; `AWS_COGNITO_MFA_PREFERRED=false` |

### HIGH

| ID | Finding | Evidence |
|---|---|---|
| H1 | RDS backup retention **1 day**, **not Multi-AZ**, no documented PITR/RPO for production overlay data | Live `BackupRetentionPeriod=1`, `MultiAZ=false` |
| H2 | HTTP API and Lambda CORS are `AllowOrigins: '*'` | `aws/template.yaml`, `aws/production/api-cfn.yaml`, API `access-control-allow-origin: *` |
| H3 | CloudFront **access logging is OFF** | Live `Logging.Enabled=false` |
| H4 | Check-image presigns allowed up to **4 hours** | `aws/functions/api/storage.mjs` `MAX_EXPIRES = 14400` |
| H5 | Production and staging share one VPC and one RDS | Prep VPC `vpc-09f2268778966ce97`; DB name `checksops-staging` |
| H6 | RLS write coverage is incomplete; FORCE RLS is off | `WRITE_AUTHORIZATION.md`: 108 tenant write tables still pending; `relforcerowsecurity=false` |
| H7 | GuardDuty / Security Hub / Config / VPC Flow Logs **not verifiable** and absent from IaC | Live List/Describe IAM-denied; repo has zero GuardDuty/Security Hub resources |
| H8 | Incident response still assumes Supabase/Lovable containment | `docs/INCIDENT_RESPONSE.md` detect/contain/preserve steps |
| H9 | S3 check images use SSE-S3 AES256, not a dedicated CMK | Live `SSEAlgorithm=AES256` on files bucket |
| H10 | No Secrets Manager rotation for DB or provider secrets | No rotation in templates; 5 secrets visible to this role |

### MEDIUM

| ID | Finding | Evidence |
|---|---|---|
| M1 | SPA CSP is **frame-ancestors only** and still allows `*.lovable.app` | `index.html` |
| M2 | No CloudFront response-headers policy (HSTS, X-Frame-Options, full CSP) | `prep-stack.yaml` has none |
| M3 | Cognito allows `ALLOW_USER_PASSWORD_AUTH` (used for operator smoke) | Live client `ExplicitAuthFlows` |
| M4 | RDS IAM authentication is OFF | Live `IAMDatabaseAuthenticationEnabled=false` |
| M5 | Prep CloudWatch log retention 30 days vs WISP long-term audit claim | `aws/production/prep-stack.yaml` |
| M6 | pgsodium / field-level PII encryption was not rebuilt on AWS | `aws/db-copy/lib/catalog.mjs` |
| M7 | Possible leftover restore IAM role with admin DB secret | `aws/db-copy/analysis/IAM_ROLE_CLEANUP.md` |
| M8 | Lambda SG allows `0.0.0.0/0:443` for provider HTTPS | `aws/template.yaml` |
| M9 | Tenant security compliance audit stream is a stub on AWS | `tenant-security-compliance.mjs` `auditEvents: []` |

### LOW

| ID | Finding | Evidence |
|---|---|---|
| L1 | Access/ID tokens are 60 minutes | Production client / staging template |
| L2 | Example production alarm/CFN files are marked do-not-deploy | `aws/production/cloudwatch.yaml` |
| L3 | Advanced Security is ESSENTIALS, not full Plus threat protection | Live `UserPoolTier=ESSENTIALS` |

---

## A. Must fix before Moov / CheckAlt / financial activation

Do **not** apply `64_financial_activation_grants.sql` or flip money flags until this list is closed and re-reviewed.

1. **C1** — Turn on RDS deletion protection. Snapshot/PITR policy before any further overlay.
2. **C2** — Dedicated production API IAM role. Staging sandbox execution must not share credentials with the public prep API.
3. **C3** — WAFv2 on CloudFront (and regional ACL on HTTP API): AWS managed common/SQLi rules + rate limit on `/auth/*`, `/storage/*`, `/public/*`.
4. **C3** — API Gateway throttle / usage plan (at least burst + steady-state caps).
5. **C4** — Enforce MFA (or WebAuthn) for admin/staff and any future financial operators. Keep pool MFA off only if an equivalent control is proven.
6. **H1** — Backup retention ≥ 7 days (prefer 35), Multi-AZ or documented PITR restore drill with RPO/RTO.
7. **H2** — Restrict CORS to `https://checksops.com` (and `https://www.checksops.com` if needed).
8. **H3** — CloudFront + API access logs to a locked bucket.
9. **H4** — Cap check-image presign TTL (recommended ≤ 300s for view, never 4h by default).
10. **H5 / H6** — Confirm RLS still enabled after T0 overlay; complete write policies for money/check/deposit tables; consider FORCE RLS on those tables.
11. **H7** — Enable and subscribe GuardDuty + Security Hub (or document an equivalent).
12. **H8** — AWS-specific IR: revoke Cognito refresh, disable API stage, rotate Secrets Manager, snapshot RDS, invalidate CF, DNS rollback to `185.158.133.1`.
13. **H10** — Rotation for RDS app secret and provider secrets; confirm no orphan `checksops_admin` roles.
14. **Financial gates** — Keep flags OFF until A is re-audited. Activation remains a separate human review.

## B. Should fix before broader customer onboarding

1. Dedicated production RDS (stop using an instance named `checksops-staging` as SoR).
2. Dedicated production VPC / SGs / NAT; no shared blast radius with staging sandbox.
3. CMK for check-image S3 (separate key from RDS).
4. Full CSP + HSTS + `frame-ancestors` including `checksops.com`; drop `*.lovable.app` from production HTML.
5. AWS Config recorders + CIS/FSBP conformance pack.
6. SIEM export of Lambda, Cognito, CloudTrail, RDS, S3 data events; retention aligned to WISP/GLBA.
7. Field-level encryption replacement for pgsodium on account/routing-adjacent columns.
8. Reduce or remove `USER_PASSWORD_AUTH` once operator smoke has an SRP/WebAuthn path.
9. Production webhook HMAC secrets distinct from staging; dry-run remains until A is closed.
10. Close tenant-security compliance stub; emit `glba_security_events` / `pii_reveal_logs` on AWS writes.

## C. Longer-term hardening

1. Separate AWS account for production (org SCP: deny money-flag changes without break-glass).
2. Formal IR tabletop on the AWS path; 500-consumer GLBA clock drill.
3. Cognito Advanced Security Plus / threat protection and adaptive auth.
4. Private API options for staff (VPN / SSO) vs public homeowner/endorsement links.
5. DLP on S3 check-image prefixes; object lock / legal hold for disputes.
6. Continuous control monitoring (access-key age, SG 0.0.0.0/0, public buckets).
7. Third-party pentest before advertising payment workflows to new tenants.

---

## Recommended sequence (still no production change in this phase)

1. Review this FAIL and accept Category A scope.
2. Implement A on a reviewed change window (WAF, IAM split, RDS protection/backups, MFA, CORS, logging, presign TTL).
3. Re-run `security-hardening-inspect.mjs` (read-only) and authenticated isolation/image smokes.
4. Only then consider a **separate** financial-activation review. Do not treat this document as activation authority.

## Explicitly not done

- No CloudFront / WAF / IAM / RDS / Cognito / S3 / KMS / Secrets / DNS changes
- No Moov / CheckAlt / provider / financial flag changes
- `64_financial_activation_grants.sql` remains NOT_APPLIED
