# MONEY MOVEMENT LAUNCH GATE — PHASE 3A

**PRODUCTION CONFIGURATION, EXECUTION STILL OFF — STOP FOR REVIEW**

This file is the Phase 3A stop report. Live values are filled after the read-only inventory invoke. No production secret is created. SQL 65 is not applied. Flags stay down.

## Hard holds (must remain)

- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- `AWS_CHECKALT_ENABLED=false`
- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_MOOV_ENABLED=false`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`
- `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`
- SQL 64 `NOT_APPLIED`
- SQL 65 `NOT_APPLIED`
- `PROVIDER_SECRETS_ARN` unset
- `checksops/production/providers` not created
- no CheckAlt production HTTP
- no deposit submit / process call
- no Gate 3D / CloudFront / WAF change

## Secret contract (names only — do not create)

| Item | Value |
| --- | --- |
| Secret id | `checksops/production/providers` |
| Lambda env | `PROVIDER_SECRETS_ARN` only |
| Names | `CHECKALT_USERNAME`, `CHECKALT_PASSWORD`, `CHECKALT_FI_KEY`, `CHECKALT_BASE_URL`, `CHECKALT_WEBHOOK_SECRET` |

UAT names (`CHECKALT_UAT_*`, `CHECKALT_SANDBOX_*`) cannot satisfy production.

## Planned webhook (do not configure vendor-side)

`https://checksops.com/prep/webhooks/checkalt`  
Keep dry-run true.

## Live inventory

Filled by `aws/cutover/scripts/phase3a-inventory.mjs` after code-only Lambda deploy + direct invoke.

See `/opt/cursor/artifacts/phase3a-inventory.json` for the sanitized machine record.
