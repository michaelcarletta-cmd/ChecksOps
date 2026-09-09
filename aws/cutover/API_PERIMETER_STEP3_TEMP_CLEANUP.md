# API Perimeter Step 3 — temporary role cleanup INCOMPLETE

**2026-09-09.** STOP FOR REVIEW. Gate 3D enforcement remains **PASS**. Temporary Step 3 Cursor access was **not** fully removed.

Secret value, hash, prefix, CloudFront header value, OTP, Cognito token, and session credentials are **not** recorded here.

## Confirm-first (before delete)

| Check | Result |
|---|---|
| AWS account | `806168576068` |
| Stack `checksops-cursor-api-perimeter-step3-temp-role` | **CREATE_COMPLETE** |
| Stack resources | Only `AllowPolicy`, `DenyPolicy`, `ApiPerimeterStep3Role` / `ChecksOpsCursorApiPerimeterStep3Temp` |
| Runtime resources in stack | **none** (no Lambda, secret, CloudFront, API, Cognito, RDS, DNS) |
| `ORIGIN_VERIFY_REQUIRE` | **true** |
| `holds.ok` | **true** |
| `productionExecution` | **false** |
| Provider / financial flags | **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |
| CloudFront `/prep/health` | 200 |
| OPTIONS `/prep/health` | 204 |
| Raw execute-api `/prep/health` | 403 |
| Fabricated origin header | 403 |
| Execute-api enabled | **true** |
| WAF / CloudFront | Unchanged / Deployed |
| Permanent Lambda + execution role | Exist |

Confirm-first `ok=true`. Stack was temporary Cursor Step 3 access only.

## Delete attempt

`ChecksOpsCursorCloudStaging` called `DeleteStack` on **only** `checksops-cursor-api-perimeter-step3-temp-role`.

CloudFormation reached `DELETE_FAILED`. Resource `ApiPerimeterStep3Role` failed:

`iam:DetachRolePolicy` on `ChecksOpsCursorApiPerimeterStep3Temp` is denied for staging.

Policies stayed `CREATE_COMPLETE`. Role still exists and still assumes. Steps12Temp retry was `AccessDenied`. Step3Temp was **not** broadened. No production runtime resource was deleted.

## After the failed delete

| Surface | Result |
|---|---|
| Stack | **DELETE_FAILED** |
| `ChecksOpsCursorApiPerimeterStep3Temp` | **still exists / assumable** |
| Permanent `checksops-production-origin-verify` Lambda | Exists |
| Permanent execution role `checksops-production-origin-verify` | Exists |
| `ORIGIN_VERIFY_REQUIRE` | **true** |
| CloudFront apex + www `/prep/health` | 200 |
| OPTIONS | 204 |
| Raw execute-api | 403 |
| Fabricated header | 403 |
| Execute-api enabled | **true** |
| WAF | Unchanged |
| CloudFront | Deployed |
| Header strip | Still configured |
| `holds.ok` | **true** |
| `productionExecution` | **false** |
| Provider / financial flags | **false** |
| Financial activation SQL | **NOT_APPLIED** |
| SPA / Cognito / RDS / DNS / Moov / CheckAlt | Not modified |

## Privileged operator — finish this stack only

Do **not** retain production resources. Do **not** delete the origin-verify Lambda, its execution role, the origin-verify secret, CloudFront, WAF, or HTTP API.

```
aws cloudformation delete-stack \
  --region us-east-1 \
  --stack-name checksops-cursor-api-perimeter-step3-temp-role
```

Caller needs `iam:DetachRolePolicy`, `iam:DeleteRole`, and `iam:DeletePolicy` on the Step 3 temp role and its two managed policies. Wait `DELETE_COMPLETE`. Then `iam get-role --role-name ChecksOpsCursorApiPerimeterStep3Temp` should be `NoSuchEntity`.

## Remaining temporary security resources

| Resource | Status |
|---|---|
| `checksops-cursor-api-perimeter-step3-temp-role` | **DELETE_FAILED** — needs privileged retry |
| `ChecksOpsCursorApiPerimeterStep3Temp` | Still assumable |
| `ChecksOpsCursorApiPerimeterSteps12Temp` | Still assumable; its stack name does not exist |
| `ChecksOpsCursorSecurityHardeningTemp` | Assume `AccessDenied` |
| `ChecksOpsCursorCloudTrailCwLogsTemp` | Assume `AccessDenied` |
| Hardening / CW Logs temp stacks | `does_not_exist` |

## Return

| Item | Result |
|---|---|
| Stack deletion | **DELETE_FAILED** |
| Temporary role deletion | **NOT DELETED** |
| Permanent origin-verify runtime | **intact** |
| Gate 3D enforcement | **still true** |
| CloudFront / raw / fabricated / OPTIONS | 200 / 403 / 403 / 204 |
| Financial / provider holds | **intact** |

## STOP

Do **not** retry this delete as staging. Do **not** broaden staging or Step3Temp. Do **not** disable execute-api. Do **not** modify SPA, prep, RDS, Cognito, WAF, or DNS. Do **not** activate Moov or CheckAlt. Do **not** apply `64_financial_activation_grants.sql`.
