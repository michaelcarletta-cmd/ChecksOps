# Production SQL 53 read-only diagnostic (source-only)

This adds an owner-gated catalog inspect that is separate from
`GET /db-readonly-validate` and `staging_admin`. It is not authorized to
run. Do not overlay, dispatch, or open a production SQL session from this
pull request.

## Path

- Module: `aws/functions/api/sql53-production-readonly-inspect.mjs`
- Transport: temporary owner-authorized **direct Lambda invoke only**
- Payload: `{ "diagnostic": "sql53-production-readonly-inspect", "authorization": "<owner-chosen one-time token>" }`
- Exact two keys. Extra fields, headers, or API Gateway events are refused.
- The in-repo phrase `OWNER_AUTHORIZED_PRODUCTION_SQL53_READONLY_INSPECT` is a
  diagnostic marker only. Using it as the token is refused.

There is no HTTP route. `GET /sql53-production-readonly-inspect` is not
registered and must 404 through the production catch-all API.

The existing staging validator endpoint is unchanged and still skips
`inspectPinnedSqlObjects` when `CHECKSOPS_ENV=production`.

## Authorization

The in-repo owner phrase is not a credential. Copying it from git, a
workflow, or this document cannot authorize the diagnostic. All of these
must match or the handler refuses before loading credentials:

1. Direct invoke of `checksops-production-prep-api` with IAM
   `lambda:InvokeFunction` on that function only. API Gateway events are
   refused.
2. `CHECKSOPS_ENV=production`
3. `AWS_LAMBDA_FUNCTION_NAME=checksops-production-prep-api`
4. Temporary Lambda env `CHECKSOPS_SQL53_READONLY_INSPECT_AUTHORIZATION`
   is an owner-chosen token of at least 32 characters and is not the
   published diagnostic marker
5. Temporary Lambda env `CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT` is a
   valid RFC 3339 timestamp no more than two hours in the future
6. Invoke field `authorization` equals that same owner-chosen token
7. Live `secrets.mjs` SHA-256 equals the official host-compare pin

The environment variables are a one-shot window. Use only the guarded writer
below; do not set them manually or leave them as a permanent production access
mechanism.

## Production RDS proof

Lambda name plus `secrets.mjs` hash is not enough. Staging and production
both use database name `checksops`. After credentials load and before
connect, the secret host first label must be `checksops-production` and
the hostname must end with `.rds.amazonaws.com`. Staging hosts are
refused. A complete response reports `rdsIdentifier` only, never the
hostname.

## What it returns

Existence and SHA-256 only for:

- `public.save_claim_settlement_breakdown(uuid,uuid,jsonb)`
- `public.sync_homeowner_ledger_from_check()`
- `public.aws_can_write_claim(uuid)`
- `public.hle_on_check_intake_insert()`
- 17 `claim_settlements` columns
- 3 `check_intake_items` ledger triggers

Queries run only inside `BEGIN READ ONLY` and only if they match the
allowlisted official catalog SQL. Function bodies, passwords, and
hostnames are not returned. Query errors fail closed instead of reporting
`exists: false`.

## Future overlay

Do not replace the live ZIP. Do not overlay `origin/main` `index.mjs` or
`db-readonly-validate.mjs`. Add the new member onto a freshly downloaded
live package and surgically patch live `index.mjs` with the direct-invoke
hook only. See
`ops/deployment-guard/production-sql53-readonly-diagnostic.json`.

## Guarded temporary configuration writer (source-only)

`scripts/deployment-guard/sql53-temporary-lambda-config.mjs` is the only
approved source path for the temporary authorization window. It is
production-only and fixed to `checksops-production-prep-api`. Its apply path
requires a valid single-use HMAC receipt and active release lease for
`production/checksops-production-prep-api`, `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1`,
an explicit `--apply` plus `apply: true`, production approval for the same
workstream, and a staging acceptance reference. A fresh `--fingerprint-only`
read produces the `preflight_live_fingerprint` required in the signed
preflight manifest. The future operator flow is:

1. Read the current production fingerprint with
   `node scripts/deployment-guard/sql53-temporary-lambda-config.mjs --fingerprint-only`.
2. Put that exact fingerprint in the official preflight manifest for
   `target_environment=production`,
   `target_component=checksops-production-prep-api`,
   `deployment_type=lambda-sql53-temporary-config`, and
   `owned_components=["checksops-production-prep-api"]`. Include the matching
   `function_name`, the identical fingerprint in both
   `production_fingerprint` and `immediately_before_fingerprint`, the matching
   production approval marker, staging acceptance reference, and passing
   accepted-contract results required by the official preflight. Issue the
   lease and receipt only through
   `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input <manifest.json>`.
3. For a later, separately authorized execution, pass an input containing
   `apply: true`, the same workstream/commit, the production approval and
   staging acceptance reference to
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 node scripts/deployment-guard/sql53-temporary-lambda-config.mjs --apply --input <apply.json>`.

The writer generates the one-time token itself (it is never supplied in a
manifest or written to output). Its default authorization window is five
minutes; a requested window cannot exceed two hours.

The writer compares the receipt fingerprint with a live configuration
fingerprint, repeats the read immediately before the write, and uses the live
`RevisionId` as compare-and-swap. It generates a one-time authorization token,
adds only `CHECKSOPS_SQL53_READONLY_INSPECT_AUTHORIZATION` and
`CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT` to a copy of the current
environment map, invokes only the exact `{diagnostic, authorization}` payload,
then attempts cleanup in a `finally` path. Cleanup rereads current state,
uses the latest `RevisionId`, preserves other variables/settings, retries
boundedly, and independently verifies that both temporary keys are absent.
Any incomplete cleanup or unexpected drift is reported as failure. Never
manually retry a failed/uncertain apply; reconcile live state and issue a fresh
receipt instead.

This PR is source-only. It does not create roles, change IAM, configure
credentials, call AWS, invoke Lambda, or contact the database.

### Future execution identity and IAM requirements

Create a dedicated role named
`ChecksOpsProductionSql53ConfigWriter` in account `806168576068`. The writer
verifies an assumed-role session of exactly that role before reading or
changing Lambda configuration. Its future identity must not be the staging
Lambda execution/deployment role, and the staging role must not be broadened.
The trust policy must name a separately owner-approved principal explicitly;
do not use wildcard principals, a staging role, or broad repository
GitHub-OIDC trust. That principal has not been authorized or configured by
this source-only change.

The role's complete future identity policy is limited to these actions on this
single unqualified function resource in `us-east-1`:

```text
arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api
```

```text
lambda:GetFunctionConfiguration
lambda:UpdateFunctionConfiguration
lambda:InvokeFunction
```

`sts:GetCallerIdentity` is used only to verify the role and does not require an
Allow statement. Do not add wildcards, aliases, other functions, or permissions
for Lambda code/version/policy changes, API Gateway, IAM/PassRole, CloudFormation,
S3, Secrets Manager, RDS, or SQL. AWS IAM cannot constrain
`UpdateFunctionConfiguration` to particular environment-variable keys; the
dedicated identity, signed receipt, live drift checks, two-key writer logic,
and cleanup verification are therefore all mandatory.
