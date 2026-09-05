# Production-prep live resources (no cutover)

Snapshot of AWS objects for production **prep**. None of these are wired to `checksops.com` DNS or Lovable auth.

Account `806168576068`, region `us-east-1`. Re-verified 2026-09-05 (this PR).

| Resource | Id / name | Cutover status |
|---|---|---|
| Cognito pool | `us-east-1_h00WorYMT` (`checksops-production`) | Prepared, **0 users**, not switched |
| Staging Cognito (do not reuse) | `us-east-1_vPmQ7cL1F` | Live staging only |
| Cognito client | `3ja9fqaq2fjkv3i6up2varcqpe` (`checksops-production-web`) | Prepared, not in `.env.production` |
| Frontend bucket | `checksops-production-frontend-806168576068` | Placeholder `index.html` only |
| CloudFront | `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net` | **Aliases quantity 0.** Deployed. Default cert. |
| ACM | `arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` | **`ISSUED`** — operator CNAMEs present; not attached to CloudFront |
| API log group | `/aws/lambda/checksops-production-prep-api` | Retention 30d; metric filter `checksops-production-prep-api-errors-filter` |
| API Lambda/HTTP | `checksops-production-prep-api` / `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` | CREATE_COMPLETE. Flags all false. **No VPC.** Reuses staging execution role via PassRole (dedicated role blocked on `iam:CreateRole`). Do not point DNS here. |
| Artifacts bucket | `checksops-production-prep-artifacts-806168576068` | Holds `checksops-production-prep-api.zip` |
| CFN `checksops-production-prep` | CREATE_COMPLETE | No apex/www aliases |
| CFN `checksops-production-prep-api` | CREATE_COMPLETE | Flags false; staging role PassRole workaround |
| CFN `checksops-production-prep-alarms` | not present | Deploy blocked: `cloudwatch:PutMetricAlarm` denied. Template ready. |
| Production DNS | apex + `www` → `185.158.133.1` | Unchanged (Lovable) |
| Staging API | `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging` | `/health` 200, flags false |

Apex/`www` A records remain `185.158.133.1`. Staging CloudFront `E1CG52WRQZI7X1` still aliases only `staging.checksops.com`.
