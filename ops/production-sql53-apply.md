# SQL53 production migration runner

## Status: BLOCKED — source-only, evaluate-only

No dedicated production in-VPC runner is prepared or authorized. Do not deploy,
invoke, or use the existing SQL53 apply CLI to connect to production. No SQL has
been executed, no AWS resource or permission has been changed, and SQL53 remains
`apply_authorized: false` and `execute: false` in
`ops/deployment-guard/sql53-production-apply.json`.

## Compatibility blockers

- The production API execution-role template trusts only
  `lambda.amazonaws.com` and grants access to the application database secret,
  not the production admin secret. It is not an authorized ECS/task migration
  role and must not be reused or modified.
- No source evidence establishes an existing task-compatible role with narrowly
  scoped access to fetch the existing admin secret, or an existing task network
  attachment/security-group path to the production RDS. The production API's
  VPC configuration does not prove that a task can use that network.
- The current apply CLI accepts a database URL from its environment. That is
  not a secure runtime secret-fetch path and is not an in-VPC runner.

Do not create or expand IAM permissions, change security groups, reuse the
production API or SQL43/44 Lambda, or supply a database URL in an environment
variable to work around these blockers. A runner can be drafted only after an
owner provides evidence that an already-authorized migration role and existing
VPC/network are compatible. It must fetch the existing admin secret at runtime
and never log, print, or persist its value.

## Preserved migration gates

Any later source-only runner must continue to use only
`aws/workflows/sql/53_claim_settlement_breakdown.sql`, migration
`53_claim_settlement_breakdown`, source SHA-256
`5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197`, and
function `public.save_claim_settlement_breakdown(uuid,uuid,jsonb)`. It must
preserve the existing create-only catalog checks, 17 settlement-column and
three ledger-trigger checks, preserved function hashes, and exclusive
production release lock.

Any future apply also requires the official production preflight, a valid
single-use receipt and active exclusive lease, fresh/immediately-before catalog
evidence, staging acceptance, and explicit production approval for that
workstream. A distinct owner authorization must separately enable execution;
this source-only change does not do so.

## Rehearsal and verification

Use the existing isolated PostgreSQL SQL53 production-apply test and SQL53
staging/e2e rehearsal tests for fail-closed validation. They do not authorize or
contact production. Do not dispatch a workflow or connect to production from
this workstream.
