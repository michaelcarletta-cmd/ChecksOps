# T0 production AWS cutover

**Authorized:** 2026-09-06 after PRE-T0 GO.  
**T0 clock:** started immediately on authorization (not waiting for 20:00 UTC).

## AWS PRODUCTION CUTOVER: FAIL

Public DNS still points at Lovable (`185.158.133.1`). CloudFront aliases/ACM were not attached (`cloudfront:GetDistributionConfig` denied). Write-freeze could not be enabled from this agent. Do **not** begin Moov/CheckAlt/financial activation.

AWS-side data, identity, and flags-off API work completed and are ready for an operator DNS/CloudFront finish.

## Immediate pre-freeze check

**PASS** at 2026-09-06T11:44:56Z. Bridges healthy, Lovable still source, AWS healthy, all provider/financial flags OFF, DNS Lovable, rollback available.

## Write-freeze

This environment has **no Lovable application freeze control plane** (no freeze API, no Cloudflare/Lovable admin, `write-freeze-drill --freeze` is a refused drill). T0 capture started immediately to minimize source drift. Lovable remains writable until an operator freeze exists.

Bridges stay `read_only` / `sign_only`. Isolated T0 rehearsal DB is `checksops_rehearsal_20260906b`. Timed rehearsal `checksops_rehearsal_20260906` is not recreated. Live `checksops` overlay is gated (`confirmChecksopsOverlay` + isolated recon PASS) and skips `identity_accounts`.

## Isolated final DB delta

**PASS** at 2026-09-06T12:02:23Z on `checksops_rehearsal_20260906b` (template clone + live overlay).  
Counts, financial aggregates, PK fingerprints, membership, FKs, and required-null all matched production. Live `checksops` was not overwritten by this step. RDS `CreateDBSnapshot` is denied for this role; rollback remains Lovable + isolated rehearsal DBs.

Selected live counts: tenants 6, profiles 8, intake 194, endorsements 533, claims 183, deposit items 125, disbursement splits 117, ledger events 716.

Delta versus the Sept 1 dump (not versus the prior isolated rehearsal) includes +12 intake, +31 endorsements, +32 payees, +11 deposit items, +9 disbursement splits, +59 ledger events, +3 claims. Storage object inventory stayed at the approved 1,411 files (no new approved objects since the last copy). New check rows reuse already-copied front/rear images.

## Final storage delta

**PASS** at 2026-09-06T12:05:41Z.

| Metric | Result |
|---|---|
| Approved source objects | 1,411 |
| Hash comparisons | 1,411 compared, 1,411 matched, 0 mismatched |
| Copied new | 0 |
| Missing | 0 |
| Conflicts | 0 |
| Production bytes on S3 | 2,565,912,220 |
| Staging-only UAT left in place | 28 |

## Live `checksops` overlay

**PASS** at 2026-09-06T12:09Z. 161 business tables replaced from the isolated-recon-PASS overlay. `identity_accounts` was not in the migratable set and was left in place. Front/rear image paths: 194/194. Older than 60 days: 91. `64_financial_activation_grants.sql` not applied.

## Identity import

**PASS.** Production pool `us-east-1_h00WorYMT`: 8 users created (`MessageAction=SUPPRESS`), 8 linked, ninth UUID untouched, no invitation emails, staging pool not touched.

## Authentication and application smoke

**PASS** against `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` after VPC/RDS attach (staging execution role) and current API zip.

- Cognito `USER_PASSWORD_AUTH` works for the tester and C1C admin application UUIDs
- DB reads: tester 194 intake rows; mapped application UUIDs match
- Tenant isolation: each user sees one tenant; tenant IDs differ; C1C sees 0 of the tester’s checks
- Historical front image signed from `claim-files`
- Financial prepare/simulate blocked; provider execution / Moov / CheckAlt / financial grants remain false
- `/ops/readiness` holds.ok, WebAuthn RP `checksops.com`

## SPA / CloudFront / DNS

- Cognito production SPA built and uploaded to `s3://checksops-production-frontend-806168576068/`
- `https://dmgs35lzv89ms.cloudfront.net/` returns 200 HTML
- CloudFront aliases remain **0**; ACM cert is **ISSUED** but not attached (GetDistributionConfig denied)
- DNS apex/`www` still `185.158.133.1` (Lovable). No Cloudflare token. Route53 ListHostedZones denied.

## CloudWatch

Prep API log filter (30 min): **0** ERROR/timeout events.

## Holds still in force

- Moov / CheckAlt / provider execution / financial grants stay OFF
- `64_financial_activation_grants.sql` not applied
- Both bridges kept
- PR #125 left open
- Production Cognito MFA stays OFF

## Rollback readiness

**Available (Point A / Point B).** DNS never left Lovable. Revert is: leave apex/`www` on `185.158.133.1`. Isolated rehearsal DBs remain. Bridges remain. Do not delete S3 copies. Disable the 8 production-pool users only if this wave is abandoned.

## Operator finish (not done)

1. Enable Lovable write-freeze if still needed.
2. Attach ACM `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` and aliases `checksops.com` / `www.checksops.com` to CloudFront `E1B0ZWWO5559U5`.
3. Switch Cloudflare apex/`www` to that distribution. Record Lovable `185.158.133.1` first.
4. Re-run post-cutover checks on the public hostname.
5. STOP. Do not activate Moov/CheckAlt/financial grants.
