# Guarded production Lambda overlay

`.github/workflows/guarded-production-lambda-overlay.yml` overlays one accepted
member onto `checksops-production-prep-api` per run, from
`ops/deployment-guard/production-api-overlay-plan.json`.

Each run:

- runs only from `main`, under the GitHub `production` environment (configure a
  required reviewer so every run waits for owner approval);
- refuses members outside the plan and any member whose main bytes are not the
  accepted SHA-256;
- REPLACE: refuses unless the live member is still the reconciled pre-deploy bytes
  and matches the SHA-256 from a prior inspect; ADD: refuses unless absent;
- reports `ALREADY_ACCEPTED` and refuses apply when the live member is already the
  accepted bytes;
- for apply, requires `DEPLOY <member> TO PRODUCTION`, a staging acceptance URL,
  verified SQL prerequisites, and that every module the member imports is live;
- issues a lease and a KMS-signed production receipt; the official overlay writer
  re-checks the production gate, preserves every other ZIP member, then the run
  verifies the live member equals the accepted bytes and smokes
  `https://checksops.com/prep/health` and `/db-health`.

## One-time setup (owner-approved, not done by this PR)

1. KMS key from `policies/kms-key.json` (asymmetric ECC P-256, sign/verify).
2. Role `ChecksOpsGitHubProductionLambdaOverlay` with `policies/trust-policy.json`
   and `policies/permissions-policy.json` (key id filled in), max session 1 hour.
3. GitHub environment `production`: required reviewer (you), prevent self-review
   off only if you are the sole maintainer, **deployment branches limited to
   `main`**, and variables `CHECKSOPS_PRODUCTION_DEPLOY_ROLE_ARN` and
   `CHECKSOPS_PRODUCTION_DEPLOYMENT_GUARD_KMS_KEY_ARN`.

The role trusts `environment:production` only. GitHub's OIDC subject for an
environment job does not include the branch, so the `main`-only deployment branch
rule on the environment is what stops a workflow on another branch from assuming
the role. Do not create the role before that rule is set.

## Plan order and link safety

Apply refuses a member until every earlier plan member is live on its accepted
bytes, and checks ESM links against the live ZIP in both directions (names the new
member imports must be exported live; names live modules import from it must still
be exported). A link failure would otherwise take every route down at load time.

## Rollback

Not automated. Each run's summary records the pre-apply CodeSha256 and RevisionId,
and the plan records each member's pre-deploy SHA-256 (`expected_live_sha256`).
Restoring a member to its pre-deploy bytes is a separate, owner-approved operation;
publishing a Lambda version before the first apply gives a one-step restore point.
