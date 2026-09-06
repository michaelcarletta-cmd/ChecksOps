# AWS public production cutover

**Generated:** 2026-09-06T14:40:36Z  
**Decision:** **AWS PUBLIC PRODUCTION CUTOVER: FAIL**  
**STOP FOR REVIEW.**

Public DNS has **not** moved from Lovable to CloudFront. AWS application, identity, storage, and flags-off holds remain healthy. This script did not change Cloudflare or Route53 and did not activate providers or financial execution.

## Rollback recommendation

**DO NOT immediately roll back DNS.**

Public apex and www still resolve to Lovable `A 185.158.133.1` on 1.1.1.1, 8.8.8.8, and Cloudflare DoH (TTL 3600). Rolling back would be a no-op. Confirm the grey-cloud CNAME change in the Cloudflare dashboard; it is not published on the public internet.

`185.158.133.1` remains reachable as the rollback target (Host `checksops.com` still 301s to `https://checksops.com/`).

## Public site (real hostnames, no `--resolve`)

| Check | Result |
|---|---|
| `checksops.com` A @1.1.1.1 / @8.8.8.8 | `185.158.133.1` (Lovable) |
| `www.checksops.com` A | `185.158.133.1` (Lovable) |
| www CNAME | none |
| `https://checksops.com` | 200, `server: cloudflare`, `cf-ray`, `x-deployment-id`, `/~flock.js` |
| `https://www.checksops.com` | 302 to `https://checksops.com/` via Cloudflare |
| Public TLS | Google Trust Services **WE1**, not Amazon ACM |
| Production SPA from AWS | **NO** — Lovable asset `index-U9NpDj7H.js` + flock |
| CloudFront hostname `https://dmgs35lzv89ms.cloudfront.net/` | 200, Cognito + prep API bundle `index-C24V_ODo.js` |

## AWS-side validation (still healthy)

| Check | Result |
|---|---|
| Cognito production login | **PASS** |
| Authenticated API | **PASS** |
| Tenant isolation | **PASS** (tester 194 checks; C1C 0) |
| Database reads | **PASS** |
| Non-financial write (`check_message_reads`) | **PASS** |
| Historical check + front/rear images | **PASS** |
| Current check + front/rear images | **PASS** |
| Endorsement workflow live | **PASS** (`/public/endorsement` and `/functions/v1/check-endorsement` return `Token required`; no submit) |
| Signature workflow live | **PASS** (`/public/signature-document` returns `validate_token`; 2 `signature_requests` readable) |
| CloudFront `E1B0ZWWO5559U5` | **Deployed**, aliases + ACM attached |
| Prep API / Lambda | **PASS** (`production-prep`, DB `checksops`) |
| CloudWatch errors (30 min) | **0** |

## Holds confirmed

- Moov OFF
- CheckAlt OFF
- Provider execution OFF
- Financial execution OFF
- `64_financial_activation_grants.sql` **NOT_APPLIED**
- Both migration bridges preserved (`read_only` / `sign_only`)
- Lovable `185.158.133.1` remains the rollback target

## Next operator step

1. In Cloudflare, publish DNS-only (grey cloud) CNAMEs:
   - `@` / `checksops.com` → `dmgs35lzv89ms.cloudfront.net`
   - `www` → `dmgs35lzv89ms.cloudfront.net`
2. Confirm 1.1.1.1 / 8.8.8.8 no longer return `185.158.133.1`.
3. Re-run `aws/cutover/scripts/t0-public-cutover.mjs` (via `assume-and-run.mjs`).
4. Do not activate Moov, CheckAlt, provider execution, or financial grants.
