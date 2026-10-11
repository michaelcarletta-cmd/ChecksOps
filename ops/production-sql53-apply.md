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
   - `staging_acceptance.ok=true` plus a reference
   - `approval.approved=true` for **this** workstream
   - `inspect` from step 2
   - a new `one_use_id`
4. Issue an exclusive lease and single-use receipt:

```bash
node scripts/deployment-guard/preflight.mjs \
  --acquire-lease --receipt \
  --input <sql53-production-apply-manifest.json>
```

5. Apply through the dedicated CLI only:

```bash
CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 \
CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt.json> \
CHECKSOPS_SQL53_PRODUCTION_DATABASE_URL=<existing-production-admin-url> \
node scripts/deployment-guard/sql53-production-apply.mjs \
  --apply --input <sql53-production-apply-manifest.json>
```

The database URL must already exist and bind `checksops-production` RDS.
Do not create a new secret, role, or Cursor OIDC trust.

## Rollback

If and only if inspect previously showed `exists=false` and this apply created
the function:

```sql
DROP FUNCTION IF EXISTS public.save_claim_settlement_breakdown(uuid, uuid, jsonb);
```

Do not drop tables, columns, triggers, or the other SQL53 functions.

## Remaining blocker for live execute

`execute: false` on the production apply pin. Independent execute
authorization is still required. The existing production database URL with
`CREATE FUNCTION` privilege must be supplied at that time.
