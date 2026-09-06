# Final DNS cutover readiness

**Generated:** 2026-09-06T13:30:21Z  
**Decision:** **FINAL DNS CUTOVER READINESS: GO**  
**STOP FOR REVIEW** before any Cloudflare DNS change.

Successful AWS DB / storage / identity / application work from T0 remains in place. This wave completed CloudFront production-domain preparation and a final pre-DNS Lovable comparison. It did **not** start a new migration.

## Holds still in force

- No Cloudflare DNS change
- No Route53 for `checksops.com`
- No Moov / CheckAlt / provider execution / financial execution
- `64_financial_activation_grants.sql` remains `NOT_APPLIED`
- `identity_accounts` was not overlaid
- Both Lovable migration bridges remain available
- Lovable `185.158.133.1` remains the documented rollback target

## Pre-DNS checklist

| Check | Result |
|---|---|
| DB reconciliation | **PASS** — 0 count diffs, 0 PK mismatches on critical tables |
| Storage reconciliation | **PASS** — 1,411/1,411 hash match, 0 new, 0 missing, 0 conflicts |
| CloudFront deployment | **Deployed** `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net` |
| Aliases | `checksops.com`, `www.checksops.com` |
| ACM | `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` ISSUED, attached, SANs cover apex + www |
| Cognito identity mapping | **8** production-pool users; ninth UUID `dd24eea5-5d12-47d1-999e-d5930c278b7d` not imported |
| Moov | **OFF** (staging + prep) |
| CheckAlt | **OFF** (staging + prep) |
| Provider execution | **OFF** (staging + prep) |
| Financial execution | **OFF** (`AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`) |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |
| DB bridge | available, `read_only`, writes false |
| Storage bridge | available, `sign_only` |
| Public DNS | still `A 185.158.133.1` for apex and www |
| Rollback target | Lovable `185.158.133.1` |

## Final Lovable source comparison

Lovable remained writable after the T0 overlay. Immediate pre-DNS read-only comparison:

- Bridge mode `read_only`, sum rows 12,401, identity map 8
- Critical PK fingerprints matched: tenants 6, profiles 8, user_roles 10, tenant_users 7, intake 194, endorsements 533, claims 183, deposit items 125, disbursement splits 117, ledger events 716
- Count diffs: none
- **Source unchanged.** No delta overlay applied. `identity_accounts` not touched.
- Images: 194/194 front/rear paths, 91 older than 60 days
- Storage inventory still 1,411 approved objects (claim-files 1254, endorsement-packets 131, plus the same small buckets). 28 staging-only UAT objects left in place. 2,565,912,220 production bytes on S3.

## Authenticated AWS smoke (after final delta)

Prep API `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` against production pool `us-east-1_h00WorYMT`:

- Cognito `USER_PASSWORD_AUTH` for tester + C1C admin — mapped application UUIDs match
- Tester 194 intake rows / 1 tenant; C1C 0 of tester’s checks / different tenant
- Historical and current `claim-files` front images both signed (distinct checks)
- Non-financial write: `check_message_reads` upsert **PASS** (1 row)
- `/ops/readiness` holds.ok
- Financial prepare/simulate still blocked

## CloudFront verification (no DNS change)

- Distribution status `Deployed`, enabled
- Viewer cert ACM `arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3`, SNI, TLSv1.2_2021
- `https://dmgs35lzv89ms.cloudfront.net/` returns 200 HTML
- `Host: checksops.com` and `Host: www.checksops.com` against the distribution return 200
- TLS for both names succeeded via `curl --resolve` to a CloudFront A record (public DNS unchanged)

## Cloudflare records to change after review

Authoritative DNS is Cloudflare, not Route53. Current public records:

| Type | Name | Current target | Proxy |
|---|---|---|---|
| A | `@` (`checksops.com`) | `185.158.133.1` | unchanged (Lovable) |
| A | `www` | `185.158.133.1` | unchanged (Lovable) |

No AAAA or CNAME is published today.

**Initial cutover (after review only):**

| Type | Name | New target | Proxy |
|---|---|---|---|
| CNAME (Cloudflare flattening at apex) | `@` / `checksops.com` | `dmgs35lzv89ms.cloudfront.net` | **DNS only (grey cloud)** |
| CNAME | `www` | `dmgs35lzv89ms.cloudfront.net` | **DNS only (grey cloud)** |

Leave proxy **disabled** on the first cutover so browsers use the attached ACM certificate on CloudFront (SNI). Do not orange-cloud until a later review. Keep a note of Lovable `185.158.133.1` as the rollback A target. Do not create these records in Route53.

## After DNS (not this wave)

1. Confirm public apex/`www` resolve to CloudFront, not `185.158.133.1`.
2. Re-run post-cutover checks on the public hostname.
3. STOP. Do not activate Moov, CheckAlt, provider execution, financial execution, or financial grants.
