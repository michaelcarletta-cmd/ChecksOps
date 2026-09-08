# Gate 1 / Step 1 PASS

**2026-09-08T15:13Z.** STOP FOR REVIEW. **Do not start Step 2.**

Assumed
`arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorApiPerimeterSteps12Temp/checksops-api-perimeter-g1`.

## Safety gates before change

Live execute-api `/prep/ops/readiness` and `/prep/financial/status`:

- `productionExecution=false`
- `AWS_MOOV_ENABLED=false`
- `AWS_CHECKALT_ENABLED=false`
- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- `financialActivationSqlApplied=false`
- `holds.ok=true`
- `64_financial_activation_grants.sql` still `DO NOT APPLY` / `NOT_APPLIED`

## Deployed

- CloudFront Function `checksops-production-spa-fallback` (`cloudfront-js-2.0`) LIVE
- Associated **only** with the S3 default behavior (`viewer-request`)
- Origin `ProductionPrepHttpApi` → `kiqojucc02.execute-api.us-east-1.amazonaws.com`, OriginPath empty, no custom headers
- Behaviors `/prep` and `/prep/*`
- CachingDisabled `4135ea2d-6df8-44a3-9df3-4b5a84be39ad`
- AllViewerExceptHostHeader **`b689b0a8-53d0-40ab-baf2-68738e2966ac`** (AWS managed ID; the package originally cited a non-existent ID and `UpdateDistribution` correctly rejected it)
- Methods GET/HEAD/OPTIONS/PUT/POST/PATCH/DELETE
- CustomErrorResponses Quantity **0**
- Status **Deployed** (InProgress → Deployed ~15:12:37Z)
- Invalidation `I74WXZE5SG7PGQD0TI0SXBHKE5` for `/prep` and `/prep/*` **Completed**

## Preserved

- WAF `arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7`
- Aliases `checksops.com`, `www.checksops.com`
- ACM `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3`
- Logging `cloudfront/E1B0ZWWO5559U5/`
- S3 origin `ProductionSpaS3` OAC `E35N26NNHZAG11`
- Default methods GET/HEAD/OPTIONS only

## Validation

| Check | Result |
|---|---|
| `https://checksops.com/prep/health` | JSON 200, `status=ok`, `x-amz-cf-id` present, not HTML |
| `https://www.checksops.com/prep/health` | JSON 200 |
| `https://checksops.com/prep/missing` | JSON 404 `not_found`, never SPA HTML |
| `/login` | HTML 200, assets referenced |
| `/sign` | HTML 200 |
| `/pricing` deep link | HTML 200 |
| `/assets/index-C24V_ODo.js` | `text/javascript` 200 |
| execute-api `/prep/health` | JSON 200 (rollback path live) |
| `/prep/ops/readiness` via CloudFront | `holds.ok=true`, flags false |
| `/prep/financial/status` via CloudFront | `productionExecution=false` |

SPA bundle is **unchanged** (still `index-C24V_ODo.js` calling execute-api). That is expected for Step 1.

## Not done

- Step 2 SPA rebuild
- Origin-verify secret / header
- API Gateway authorizer
- `DisableExecuteApiEndpoint`
- Lambda / RDS / Cognito / WAF / DNS / security monitoring
- Role deletion (leave `ChecksOpsCursorApiPerimeterSteps12Temp`)
