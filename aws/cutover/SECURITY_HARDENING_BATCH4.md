# SECURITY HARDENING BATCH 4: PASS

**Closed:** 2026-09-07  
**STOP FOR REVIEW.**

Financial and provider activation remains **NOT AUTHORIZED**.
Moov, CheckAlt, provider execution, financial execution, and
`64_financial_activation_grants.sql` stay **OFF / NOT_APPLIED**.
API-behind-CloudFront remains a later **MUST FIX** and was **not**
deployed. Batch 1/2/3 controls, Cognito login, CloudFront WAF, and both
migration bridges are preserved.

## Verdict

| Check | Result |
|---|---|
| Production RLS re-audit | **181** public tables; **178** RLS enabled; **85** tenant-sensitive all isolated |
| Missing tenant SELECT/INSERT/UPDATE/DELETE | **None** on tenant-sensitive tables |
| FORCE RLS | Evaluated; **not applied** (would break `checksops_admin` bridges) |
| Cross-tenant SELECT | C1C sees **0** Freedom checks; tester sees **0** C1C checks |
| Cross-tenant storage sign | C1C → Freedom image **403 storage_forbidden** |
| Cross-tenant INSERT/UPDATE/DELETE | Denied (allowlist or RLS) |
| View presign TTL | Requested 14400 → issued **300** |
| Upload URL TTL | **60s** (unchanged) |
| Public signing PDF TTL | **1800s** exception (session must stay open) |
| Files bucket | Private, PAB on, BucketOwnerEnforced, SSE-S3, versioning on |
| KMS CMK migration | **Not applied** (unsafe / IAM cannot manage KMS aliases) |
| Secrets in Lambda env | Only `DATABASE_SECRET_ARN` (ARN, not the secret) |
| API / CloudFront logs | No Authorization, tokens, query strings, or bodies |
| Login / public site | Password auth without MFA challenge; `/login` 200 |
| Money flags | All **false** |

**SECURITY HARDENING BATCH 4: PASS**

## Live mutations

| Mutation | Before | After |
|---|---|---|
| Prep Lambda code overlay | Batch 3 zip | `storage.mjs`, `homeowner.mjs`, `documents.mjs`, `rls-audit.mjs`, `db-readonly-validate.mjs` |
| `MAX_EXPIRES` (authenticated view) | 14400 | **300** |
| `/storage/sign-many` default | 1800 | **300** |
| Homeowner/document image TTL | 900 | **300** |
| Public signing document TTL | 14400 | **1800** (documented exception) |
| Frontend `createSignedUrls` default | 1800 | **300** (repo; next SPA deploy) |
| `/db-readonly-validate` write-grant check | error if any DML GRANT | **expected** when RLS is on |
| Expected public triggers | 164 | **165** (live count) |
| FORCE RLS | off | still **off** |
| Bucket default encryption | SSE-S3 | **unchanged** |
| Secrets rotation | disabled | **unchanged** (not enabled) |
| IAM roles | leftover staging roles present | **flagged, not deleted** |
| Lambda env / VPC / role | `checksops-production-api-execution` | **unchanged** |
| Money / provider flags | false | **false** |

No RDS `ALTER TABLE … FORCE`. No CMK create. No secret value read. No
bridge teardown. No API-behind-CloudFront.

## RLS matrix (live `checksops`, 2026-09-07)

App role `checksops` is **not** table owner and has **no** `BYPASSRLS`.
Owners are `checksops_admin` and `rdsadmin`.

| Class | Count |
|---|---|
| Public base tables | 181 |
| RLS enabled | 178 |
| RLS forced | 0 |
| Tenant-sensitive (`tenant_id` / `org_id` / `deposited_by_tenant_id`) | 85 |
| Tenant-sensitive missing RLS | **0** |
| Tenant-sensitive missing SELECT policy | **0** |

Intentionally not RLS-enabled:

| Table | Why |
|---|---|
| `identity_accounts` | Cognito→UUID mapping runs before `request.app_user_id` |
| `spatial_ref_sys` | PostGIS catalog |
| `_checksops_restore_complete` | Restore sentinel |

### FORCE RLS evaluation

`checksops_admin` owns application tables and does **not** have
`BYPASSRLS`. FORCE would apply RLS to that owner and can break the
database/storage migration bridges. The app role already has RLS applied
because it is not the owner. **Do not FORCE from the production Lambda
role.**

## Adversarial isolation

Actors: Freedom tester `abd3c2a0-…` vs C1C admin `fd857564-…`.
Spoofed `user_id` / `tenant_id` ignored.

| Probe | Result |
|---|---|
| Tester SELECT `check_intake_items` | 20 visible (own tenant) |
| C1C SELECT `check_intake_items` | **0** |
| Isolation: tester C1C checks | **0** |
| Isolation: C1C Freedom checks | **0** |
| C1C GET sign of Freedom check image | **403 storage_forbidden** |
| C1C UPDATE Freedom check | denied (`503 data_query_failed` / 0 effect) |
| C1C INSERT Freedom check | **403 operation_not_allowlisted** |
| C1C DELETE Freedom check | **403 operation_not_allowlisted** |
| C1C upsert `check_message_reads` on Freedom check | **403 rls_denied** |
| Tester upsert own `check_message_reads` | **200** |
| Unauthenticated core SELECT | fail-closed **0** rows |

## Presign TTLs

| Workflow | TTL |
|---|---|
| Authenticated `/storage/sign` and `/storage/sign-many` | **≤300s** (client 14400 clamped to 300; live `X-Amz-Expires=300`) |
| Homeowner check-image URLs | **300s** |
| Generated documents | **300s** |
| Upload PUT URL | **60s**, content-type bound, path authorized |
| Public branding `/storage/public` | **300s** |
| Public signing PDF | **1800s** — `Sign.tsx` holds one URL for the session; 300s would expire mid-sign |

## S3 / KMS

Files bucket `checksops-staging-privatefilesbucket-erzqsolpucjp`:

- Public access block: all four **true**
- Object ownership: **BucketOwnerEnforced**
- Versioning: **Enabled**
- Default encryption: **AES256 (SSE-S3)**
- Bucket policy: none (not public)

Other production buckets (frontend, artifacts) are private with PAB on.
CloudFront access-log bucket keeps `BlockPublicAcls=false` /
`BucketOwnerPreferred` so standard CF logging ACLs still work; cookies
are not logged.

**KMS CMK not implemented.** Agent cannot `kms:ListAliases` /
manage keys. Switching default encryption to a new CMK without
`kms:Decrypt` on `checksops-production-api-execution` would break new
object sign/download. Historical objects would stay SSE-S3 unless
rewritten. Leave SSE-S3; revisit with an operator-owned CMK grant
before financial activation if required.

## Secrets Manager

| Secret | Rotation |
|---|---|
| `rds-db-credentials/.../checksops` | **OFF** |
| `rds-db-credentials/.../checksops_admin` | **OFF** (Lambda refuses this ARN) |
| `checksops/staging/providers` | **OFF** |
| `checksops/staging/storage-migration-token` | **OFF** (bridge; keep) |
| `checksops/staging/master-uat-password` | **OFF** |

Rotation was **not** enabled (could lock the app role). Ready for a later
operator rotator, not this batch.

Lambda environment contains no passwords or tokens. Secret-like key:
`DATABASE_SECRET_ARN` only. Cognito pool/client IDs are identifiers.

Repository scan: no `AKIA…` keys or hardcoded AWS secret values in app
source.

## Logging

API Gateway access log format (90-day group
`/aws/apigateway/checksops-production-prep-http`):

`requestId`, `ip`, `method`, `path`, `status`, `protocol`,
`responseLength`, `integrationStatus`, `error` —

No `$context.identity.authorization`, headers, query strings, or bodies.

CloudFront logs: enabled, **cookies false**, prefix
`cloudfront/E1B0ZWWO5559U5/`. WAF still attached.

## Unused / leftover roles (flagged, not deleted)

| Role | Action |
|---|---|
| `checksops-production-api-execution` | **Keep** — live prep Lambda role |
| `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` | **Flag** leftover staging role (last used 2026-09-06). Do not delete without rollback review |
| `checksops-production-prep-api-role` | GetRole denied to the agent; Batch 1 said do not attach. **Do not delete** |
| `checksops-staging-rls-enable` | Already gone |
| Storage / DB migration bridge roles and secrets | **Keep** |

## Remaining blockers before financial activation

1. **MUST FIX:** API-behind-CloudFront + execute-api restriction (not this batch)
2. Operator-owned secrets rotation for the `checksops` RDS secret
3. Optional later: dedicated files-bucket CMK with Lambda decrypt grant (do not rewrite history blindly)
4. Optional later: FORCE RLS only after `checksops_admin` has `BYPASSRLS` or bridges stop using the table owner
5. Review leftover staging IAM roles; do not delete bridges
6. Money/provider flags and `64_financial_activation_grants.sql` stay **OFF / NOT_APPLIED**

**SECURITY HARDENING BATCH 4: PASS**
