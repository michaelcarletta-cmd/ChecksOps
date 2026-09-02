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
