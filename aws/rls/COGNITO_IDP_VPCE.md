# Cognito JWKS via PrivateLink (staging)

Lambda `checksops-staging-api` runs in private subnets without a NAT gateway. `aws-jwt-verify` fetches:

`https://cognito-idp.us-east-1.amazonaws.com/<pool>/.well-known/jwks.json`

## Solution

Interface VPC endpoint `com.amazonaws.us-east-1.cognito-idp` in the API VPC:

- Type: Interface (PrivateLink)
- Private DNS: enabled
- Subnets: same private subnets as the API Lambda
- Security group: inbound TCP 443 from the API Lambda security group only
- No NAT gateway
- RDS stays private; no 0.0.0.0/0 egress added merely for JWKS

API Gateway JWT authorizer remains on `/identity/me`, `/authorization/probe`, and `/authorization/isolation`. `/authorization/jwks-check` has **no** authorizer so Lambda must retrieve JWKS itself.
