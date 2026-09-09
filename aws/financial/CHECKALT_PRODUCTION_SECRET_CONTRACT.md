# Production CheckAlt secret contract

**DO NOT CREATE this secret in this phase.**
**DO NOT load credential values.**
**DO NOT copy UAT credentials into production names.**
**DO NOT print secret values.**

## Location

| Item | Value |
| --- | --- |
| Secrets Manager id | `checksops/production/providers` |
| Lambda env | `PROVIDER_SECRETS_ARN` |
| JSON object | one secret document containing the names below |

Production CheckAlt execution reads **only** these production names. `CHECKALT_UAT_*` and `CHECKALT_SANDBOX_*` cannot satisfy the production path.

## Required names (never values)

| Name | Purpose |
| --- | --- |
| `CHECKALT_USERNAME` | FinCapture API login userName for `POST /public/fincapture/authenticate` |
| `CHECKALT_PASSWORD` | FinCapture API login password |
| `CHECKALT_FI_KEY` | Financial institution key sent as `fiKey` |
| `CHECKALT_BASE_URL` | Production FinCapture HTTPS origin. Must not be `https://uatapi.checkalt.com` |
| `CHECKALT_WEBHOOK_SECRET` | HMAC for `/webhooks/checkalt` (webhooks remain dry-run for the first transaction) |

## Not selected by the browser

Merchant, FI, depositor `sso_user_id`, and destination deposit account number are loaded server-side from `checkalt_config` / `checkalt_tenant_accounts` for the **check's** tenant.

## Fail closed

If `PROVIDER_SECRETS_ARN` is unset, the secret is missing, or any required production name is absent, the production adapter refuses before HTTP. UAT keys in `checksops/staging/providers` are ignored.
