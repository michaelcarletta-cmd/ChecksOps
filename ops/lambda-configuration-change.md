# API Lambda environment-variable change (staging, then production)

Workflows: `.github/workflows/guarded-staging-lambda-config.yml` (staging environment, role
`ChecksOpsGitHubStagingLambdaOverlay`) and `.github/workflows/guarded-production-lambda-config.yml`
(production environment, role `ChecksOpsGitHubProductionLambdaOverlay`). Both run only from main.
Preflight: `scripts/deployment-guard/github-lambda-config.mjs`. Writer (the only thing that writes):
`scripts/deployment-guard/lambda-config-apply.mjs`. Plan: `ops/deployment-guard/lambda-config-plan.json`.

The overlay and rebuild paths never touch configuration. This path changes `Environment.Variables`
and nothing else: not code, not the role, runtime, handler, memory, timeout or VPC. It exists so a
reviewed flag such as `AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED` can move from `"false"` to `"true"`
without a stack deploy, with the same receipt, lease, RevisionId CAS and production gate as the
other guarded writers.

## IAM prerequisite (owner)

The checked-in overlay role policy (`aws/production-lambda-overlay/policies/permissions-policy.json`)
allowed only `lambda:GetFunction`, `lambda:GetFunctionConfiguration` and `lambda:UpdateFunctionCode`.
This change adds `lambda:UpdateFunctionConfiguration` on the exact function ARN. Until the live role
policy carries that statement (and the staging role the same for `checksops-staging-api`), inspect
works and apply fails with `AccessDeniedException` before anything changes. Applying the policy is
an owner action outside this repository.

## What the plan records

One section per environment. `set` lists keys to write with the exact live value (`from`, `null`
when the key is absent) and the intended value (`to`). `unset` lists keys to remove with their
exact live value. Keys not listed are carried over untouched. Credential-like keys (`SECRET`,
`PASSWORD`, `TOKEN`, `KEY`, `CREDENTIAL`) are refused: those stay in NoEcho template parameters.

## Steps (each needs owner approval)

1. **Staging inspect** (`mode: inspect`). With an empty section the run reports `PENDING_PLAN` and
   the live variable names (never values) in the summary and the `config-diff-staging-<run>`
   artifact.
2. **Plan PR**: fill the staging section (each entry is a reviewed decision). Merge. A second
   inspect reports `READY` when every listed key holds its recorded live value, `BLOCKED` when one
   drifted, `ALREADY_ACCEPTED` when the change is already live.
3. **Staging apply** (`mode: apply`) with `approved_commit` = main, `expected_live_revision_id`
   from the inspect, `approval_phrase` exactly `APPLY API CONFIGURATION TO STAGING`. The job takes
   the `checksops-staging-api` lease, issues a KMS-signed receipt owning the plan change's SHA-256,
   writes the variables with RevisionId CAS, re-reads the configuration and requires the variables
   to equal the intended map with every other field unchanged, then smokes the public endpoints.
4. **Production inspect**, **plan PR** for the production section, then **production apply** with
   `staging_acceptance_reference` = the green staging apply run URL (or the reviewed plan PR when
   staging needs no change) and `approval_phrase` exactly `APPLY API CONFIGURATION TO PRODUCTION`.
   The production environment reviewer must approve the job.
5. **Record PR**: record the apply (run, before/after RevisionId and configuration SHA-256) and
   empty the section so the next change starts from a fresh inspect. The template's static value
   for the key is a separate, ordinary code change.

## What the writer never does

- Never sends anything but `FunctionName`, `Environment.Variables` and `RevisionId`; the live
  adapter refuses any other field, and refuses `UpdateFunctionConfiguration` entirely unless the
  config writer opened it.
- Never writes a key the receipt's plan change does not own; a hand-built plan is re-validated and
  hashed before the receipt is compared.
- Never restores, never retries after a failed update, never runs without
  `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1` plus a valid, unconsumed receipt; an overlay or rebuild
  receipt cannot authorize a configuration change and a staging receipt cannot authorize production.

## Rollback

A reviewed plan section with `from` and `to` swapped, taken through the same steps.
