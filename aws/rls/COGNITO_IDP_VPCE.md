# Cognito JWKS via PrivateLink (staging)

Lambda `checksops-staging-api` runs in private subnets without a NAT gateway. `aws-jwt-verify` fetches:

`https://cognito-idp.us-east-1.amazonaws.com/us-east-1_vPmQ7cL1F/.well-known/jwks.json`

## Solution

Interface VPC endpoint `com.amazonaws.us-east-1.cognito-idp` (PrivateLink):

- Endpoint: `vpce-01e64f35c26956533` (available)
- Private DNS: enabled (`cognito-idp.us-east-1.amazonaws.com`)
- Subnets: `subnet-03989e61c0468268a` (us-east-1b), `subnet-0b498a80f0688a913` (us-east-1c)
  - Cognito IdP is not offered in the Lambda AZs (us-east-1a / us-east-1f); same-VPC ENIs in supported AZs are enough
- Security group: `sg-027b566af3c0590f4` — inbound TCP 443 from API Lambda SG `sg-0fe2698f236959353` only
- Lambda egress: TCP 443 to that SG (already present for Secrets Manager). No `0.0.0.0/0`, no NAT
- RDS stays private (`PubliclyAccessible=false`)

## Validation (Lambda in VPC)

| Check | Result |
| --- | --- |
| `GET /authorization/jwks-check` (no authorizer, no token) | 200, JWKS HTTP 200, 2 keys, 407ms |
| Same path with probe Cognito ID token | 200, `verifiedInLambda: true`, sub `2418c458-…9415d` |
| Same path with garbage Bearer | 401 |
| `GET /authorization/probe` and `/authorization/isolation` without token | API Gateway 401 |
| Protected routes still use JWT authorizer `5kyjfy` | yes |

API Gateway JWT authorizer remains on `/identity/me`, `/authorization/probe`, and `/authorization/isolation`. `/authorization/jwks-check` has **no** authorizer so Lambda must retrieve JWKS itself.

## Removed 2026-11-17: JWKS now goes through the NAT

Everything above describes the state from 2026-09-02 to 2026-11-17 and is kept as history. The
endpoint `vpce-01e64f35c26956533` no longer exists.

Owner, 2026-11-17: "do 4 and 5", in reply to a cost review whose item 5 was "Drop the Cognito
interface endpoint and use the NAT" (about $15/month: two endpoint interfaces at $0.01/hour).
This section records item 5 only. Run by Claude through boto3 as `user/claude-code`. No guarded
workflow covers VPC endpoints, and this endpoint was created by hand outside any stack.

Why it was redundant: it was created on 2026-09-02, when the Lambdas had no NAT. A NAT has
carried their egress since 2026-09-03 (`ops/security/NAT_GATEWAY_COST_PLAN_2026_11.md`). The Lambda
security group `sg-0fe2698f236959353` allows TCP 443 to `0.0.0.0/0`, and
`checksops-production-prep-api` carries that group as well as the production one.

Read first (read-only):
- `DeleteVpcEndpoints`, `CreateVpcEndpoint` and `ModifyVpcEndpoint` dry runs all returned
  `DryRunOperation`, so a rollback by re-creating the endpoint was available.
- Baseline `GET /staging/authorization/jwks-check` on `checksops-staging-api`: 200, JWKS HTTP 200,
  2 keys. `GET /staging/providers/egress`: 200, Moov and CheckAlt UAT reachable.

Applied, in two steps so that addresses already resolved kept working:
1. 16:56:01 UTC `ModifyVpcEndpoint` `PrivateDnsEnabled=false`. From then on
   `cognito-idp.us-east-1.amazonaws.com` resolves to the public address and leaves through the NAT.
2. 17:01:40 UTC (about) `DeleteVpcEndpoints` `vpce-01e64f35c26956533`, after the endpoint's
   `NewConnections` metric had no data points from 16:57 while production served about 250
   requests with HTTP 200. `Unsuccessful` was empty; state `deleting` at 17:02:00.

**What it cost in production.** The DNS switch in step 1 was not clean:
- `checksops-production-prep-api`: 22 invocations between 16:56:13 and 16:56:20 UTC took about
  6.0 s each, and the API access log shows **19 responses with HTTP 401** in that minute
  (14 `/prep/data/query`, 4 `/prep/data/rpc`, 1 `/prep/functions/v1/moov-wallet-sync`), all from
  one client address. Lambda `Errors` stayed 0 and there was no 5xx from this.
- `checksops-staging-api`: one of the probes (16:56:48) returned 503 after an 8 s JWKS timeout.
- Nothing like it afterwards: 44 of the next 44 staging probes passed before the delete and 30 of
  30 after it, and production returned 200s at its normal latency from 16:58.

The 13 HTTP 403 and 4 HTTP 503 on `/prep/data/query` at 16:59–17:00 are at the rate the access
log shows for the previous 26 hours (for example 61 × 403 in the 18:00 hour of 2026-11-16, and
1 to 8 × 503 in most active hours), so they are not attributed to this change.

Not verified: why the switch caused timeouts while the endpoint still existed, and whether any
caller other than the one address was affected. The `networking` text returned by
`/authorization/jwks-check` ("cognito-idp interface VPC endpoint (PrivateLink), not NAT") and the
JWKS row in `aws/rls/RLS_COMPAT.md` are now out of date; changing them is a code change for its own
PR.

Rollback, if ever wanted: re-create the endpoint with the settings at the top of this file. Enabling
private DNS again is another DNS switch and should be expected to cost the same few seconds.
