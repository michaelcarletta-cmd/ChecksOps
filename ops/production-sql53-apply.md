# SQL53 dedicated production apply path

## SQL53_PRODUCTION_EXECUTOR_READY: YES

Prepared and tested. This package does not execute production SQL.

## Scope

Creates only `public.save_claim_settlement_breakdown(uuid,uuid,jsonb)` from
`aws/workflows/sql/53_claim_settlement_breakdown.sql`.

Does not modify the staging executor, production API Lambda, IAM trust, or
unrelated workstreams. Does not create Cursor OIDC access.

## Exact later execution procedure

Do not run these steps until a separate execute authorization sets
`ops/deployment-guard/sql53-production-apply.json` `execute` to `true`.

1. Fresh-fetch `origin/main` and confirm the source SHA is still
   `5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197`.
2. Collect a fresh read-only production catalog that shows
   `exists: false` for the settlement function, the 17 settlement columns,
   the 3 ledger triggers, and the three preserved function hashes.
3. Build a `sql53-production-apply` manifest with:
   - `target_environment=production`
   - `target_component=production-sql`
   - `authorization_phrase=CREATE_SAVE_CLAIM_SETTLEMENT_BREAKDOWN`
   - matching `production_fingerprint` and `immediately_before_fingerprint`
   - `staging_acceptance.ok=true` plus a reference (see
     `ops/deployment-guard/sql53-staging-acceptance.json`)
   - `approval.approved=true` for **this** workstream
   - `inspect` from step 2
   - a new `one_use_id`
4. Issue an exclusive lease and single-use receipt:

```bash
node scripts/deployment-guard/preflight.mjs \
  --acquire-lease --receipt \
  --input <sql53-production-apply-manifest.json>
```

5. Apply through the dedicated CLI only, on a host that already has private
   reachability into `vpc-09f2268778966ce97`. Do not apply from GitHub-hosted
   runners or `checksops-production-prep-api`. Issue the receipt and apply on
   the same host so the local issuer key, lease, and official
   `consumeReceiptOnce` registry stay together.

```bash
CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 \
CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt.json> \
CHECKSOPS_SQL53_PRODUCTION_ADMIN_SECRET_ARN=arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops_admin/1790081257144 \
node scripts/deployment-guard/sql53-production-apply.mjs \
  --apply --input <sql53-production-apply-manifest.json>
```

On `i-0c35557c4e5385406`, also set
`AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com`.
The staging Secrets Manager endpoint in `vpc-09f2268778966ce97` has private
DNS enabled and only admits staging, so the default hostname times out from
the runner. The production endpoint admits `checksops-sql53-temporary-runner`.

Stage runner source with `.github/workflows/sql53-temporary-transfer.yml`
(dispatch on `main`). It uploads `sql53/source-<sha>.tar.gz` plus a `.sha256`
sidecar, with `pg` and `@aws-sdk/client-secrets-manager` at lockfile versions.

`CHECKSOPS_SQL53_PRODUCTION_DATABASE_URL` remains accepted if the URL already
exists. The CLI may instead load the existing production admin secret. Do not
create a new secret, role, or Cursor OIDC trust. Do not put `issuer.key` on
Lambda.

GitHub workflow `.github/workflows/sql53-production-apply.yml` is evaluate-only.

## Rollback

If and only if inspect previously showed `exists=false` and this apply created
the function:

```sql
DROP FUNCTION IF EXISTS public.save_claim_settlement_breakdown(uuid, uuid, jsonb);
```

Do not drop tables, columns, triggers, or the other SQL53 functions.

## Remaining blocker for live execute

`execute: false` on the production apply pin. Independent execute
authorization is still required. Apply from a privately routed host that can
already read the existing production admin secret. Do not move issuer.key,
leases, or receipts onto Lambda.
