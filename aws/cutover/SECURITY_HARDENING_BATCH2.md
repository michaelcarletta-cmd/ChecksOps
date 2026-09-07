# SECURITY HARDENING BATCH 2: PASS

**Closed:** 2026-09-07  
**STOP FOR REVIEW.**

Financial and provider activation remains **NOT AUTHORIZED**.

## Approved interim exception

The direct HTTP API `kiqojucc02` may remain internet-public temporarily because:

- Moov OFF
- CheckAlt OFF
- Provider execution OFF
- Financial execution OFF
- `64_financial_activation_grants.sql` **NOT_APPLIED**
- API Gateway throttle **50 rps / 100 burst**
- Production CORS allow-listed (`https://checksops.com`, `https://www.checksops.com`)
- Cognito JWT protects authenticated routes
- CloudFront WAF is live on `E1B0ZWWO5559U5`

Native WAFv2 cannot attach to this HTTP API. Do not retry
`checksops-production-api-waf`. Do not convert the API to REST.

## MUST FIX before financial activation

- Route `/prep*` behind CloudFront (separate origin/behavior; do not collide with SPA `/auth` `/sign` `/endorse`)
- Flip the SPA API URL to `https://checksops.com/prep`
- Then restrict the raw execute-api endpoint
- Keep webhook / scheduled / bridge ingress designed before lock

Do **not** deploy that redesign in Batch 2.

**SECURITY HARDENING BATCH 2: PASS**
