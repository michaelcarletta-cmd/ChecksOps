# Production-prep AWS resources

**This directory prepares production Cognito client, frontend hosting, and a separate API stack.**  
It does **not** switch production auth, DNS, webhooks, or flags.

Live staging SAM `aws/template.yaml` still allows **`Environment=staging` only**.

## Live leftover Cognito pool (do not recreate)

A failed first `checksops-production-prep` deploy **retained** pool:

| Item | Value |
|---|---|
| Name | `checksops-production` |
| Id | `us-east-1_h00WorYMT` |
| Users | **0** (do not invite / import) |
| First-auth factors | EMAIL_OTP, PASSWORD, WEB_AUTHN |
| MFA | OFF |
| Deletion protection | ACTIVE |
| Email | `COGNITO_DEFAULT` (SES From still outstanding; agent SES APIs denied) |
| WebAuthn RP ID | `checksops.com` (set; staging remains `staging.checksops.com`) |

Staging pool `us-east-1_vPmQ7cL1F` **must not** be reused. `prep-stack.yaml` takes `ExistingUserPoolId` (default `us-east-1_h00WorYMT`) and only creates the `checksops-production-web` client.

## Stacks

| Stack | Template | What it creates | DNS / auth |
|---|---|---|---|
| `checksops-production-prep` | `prep-stack.yaml` | Cognito **client** on existing pool, frontend bucket, CloudFront **without** apex/www aliases, API log group | Unchanged |
| `checksops-production-prep-api` | `api-cfn.yaml` / `api-template.yaml` (**retired, do not deploy**; see below) | Created the prep Lambda + HTTP API; live has diverged on purpose | URL `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep`, served at `https://checksops.com/prep` |

Leftover OAC name `checksops-production-frontend-oac` exists outside CloudFormation. This stack uses `checksops-production-frontend-oac-prep2`.

## Operator deploy (after review — not cutover)

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-prep \
  --template-file aws/production/prep-stack.yaml
```

The production API stack (`checksops-production-prep-api`) has **no** operator deploy: its
templates are retired (next section).

WebAuthn RP ID `checksops.com` is **already set** on `us-east-1_h00WorYMT` (`SetUserPoolMfaConfig`, MFA OFF). Staging `us-east-1_vPmQ7cL1F` stays `staging.checksops.com`. Do not invite users.

## Retired stack templates (do not deploy)

`api-cfn.yaml` and `api-template.yaml` are **retired**. They describe the flags-off prep API that
`checksops-production-prep-api` was created from (2026-09-05, last stack update 2026-09-24).
Live production has diverged on purpose since then. A read-only comparison on 2026-10-21
(CloudFormation drift detection `7a4e0970-cd48-11f1-867c-0affeceb3cc5`, `DRIFTED`) found:

| | Templates | Live `checksops-production-prep-api` |
|---|---|---|
| Role | staging SAM role / stack parameter `checksops-production-prep-api-role` | `checksops-production-api-execution` |
| Network | no VPC | 2 private subnets, 2 security groups (`vpc-09f2268778966ce97`) |
| Timeout | 29 s | 45 s |
| Environment | 22 variables, every provider and write flag `false` | 50 variables: writes, Moov, CheckAlt, financial permissions, Moov onboarding and fee collection on; database, files, provider and webhook secret references; email settings |
| HTTP API | CORS allow-list `checksops.com`, `www.checksops.com` | CORS `*` at the comparison (allow-list applied later the same day, see below); a custom authorizer, an `OPTIONS /{proxy+}` route, access logs and throttling managed outside the stack |

A stack update from either file would replace the function's role, network and whole
environment map and take production down. Both files therefore carry a CloudFormation `Rules`
assertion that always fails, so a change set built from them is refused before anything changes,
and the deployment guard refuses the stack (`RETIRED_STACKS` in
`scripts/deployment-guard/lib/shared-targets.mjs`). The guardrail tests that keep these files
flags-off, on the staging role and on the CORS allow-list stay in force: the files record the prep
baseline, not live state.

AWS enforces the same on the stack itself since 2026-10-21 (applied by the owner's decision
through the AWS connector and read back):

- **Stack policy** `{"Statement":[{"Effect":"Deny","Action":"Update:*","Principal":"*","Resource":"*"}]}`:
  CloudFormation refuses any stack update that would modify, replace or delete a resource, from
  any template, tool or console. Direct Lambda and API Gateway calls (the guarded workflows) are not
  stack updates and are unaffected. Someone with full CloudFormation permissions can still pass a
  temporary override policy or replace this one; a stack policy cannot be removed, only replaced.
- **Termination protection** on: the stack cannot be deleted until it is turned off.

Live production changes only through the guarded paths:

| Change | Path |
|---|---|
| One API source member | `guarded-production-lambda-overlay.yml` |
| Whole API package (dependencies, new modules) | `guarded-production-lambda-rebuild.yml`, `ops/production-lambda-rebuild.md` |
| Environment variables | `guarded-production-lambda-config.yml`, `ops/lambda-configuration-change.md` |
| Website | `guarded-production-spa-upload.yml` |
| Database | `production-sql-one-shot.mjs`, `ops/production-sql-one-shot.md` |

The CORS allow-list is live since 2026-10-21: the guarded production CORS writer
(`guarded-production-cors.yml`, run 39602211635) changed `AllowOrigins` from `*` to
`https://checksops.com`, `https://www.checksops.com` and nothing else; see
`ops/production-cors-allowlist.md`. Bringing the stack back under CloudFormation (importing the
live state) would be its own reviewed workstream.

Do **not** overlay `checksops-staging-api` from production work.

## ACM (checksops.com + www)

See `ACM_DNS_VALIDATION.md`. Cert is `PENDING_VALIDATION`. **Do not add Cloudflare records from this agent.** CloudFront aliases for apex/www wait until the cert is `ISSUED` **and** a cutover decision.

## Frontend deploy target

Build with `.env.production.aws.example` values filled privately (not committed). Upload to the production-prep bucket. Do **not** copy over `.env.production`. Do **not** change `checksops.com` DNS.

## Safety

Keep false: `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_COGNITO_MFA_PREFERRED`.

Do not apply `64_financial_activation_grants.sql`.
