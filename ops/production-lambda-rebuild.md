# Full-package API Lambda rebuild (staging, then production)

Workflows: `.github/workflows/guarded-staging-lambda-rebuild.yml` (staging environment, role
`ChecksOpsGitHubStagingLambdaOverlay`) and `.github/workflows/guarded-production-lambda-rebuild.yml`
(production environment, role `ChecksOpsGitHubProductionLambdaOverlay`). Both run only from main.
Preflight: `scripts/deployment-guard/github-lambda-rebuild.mjs`. Writer (the only thing that writes):
`scripts/deployment-guard/lambda-rebuild-apply.mjs`. Plan: `ops/deployment-guard/lambda-rebuild-plan.json`.

The overlay workflows replace one reviewed member inside the live ZIP. A rebuild replaces the whole
package with a fresh build of main: every file under `aws/functions/api` plus `node_modules` from
`npm ci --omit=dev --ignore-scripts` on the API lockfile, zipped deterministically (sorted members,
no timestamps). It exists so production can receive dependencies the overlay cannot carry
(`@aws-sdk/client-kms` for Moov onboarding) and the modules that only reach production with a
rebuild (`invoice-actions.mjs`, `invoice-provider.mjs`, `public-invoice.mjs`).

## Why apply cannot drop anything silently

The rebuild is allowed only when every difference between the live package and the candidate is
listed in the plan section for that environment:

- `members`: source files whose bytes change, with the exact live and accepted SHA-256;
- `added`: files absent from the live package, with their accepted SHA-256;
- `removed`: live files the build drops, with their live SHA-256;
- `dependencies`: `node_modules` packages added, removed or re-versioned, keyed by package path.

Node modules are compared by package path and version, not byte for byte: the install is
reproducible from the lockfile, but the live package was built by other tooling. An unlisted
difference leaves inspect `BLOCKED` and refuses apply. A listed member whose live bytes no longer
match the plan is `DEPLOYMENT_COLLISION`.

## Steps (each needs owner approval)

1. **Staging inspect** (`mode: inspect`). Reads the live staging package, builds the candidate, and
   reports the difference in the run summary and the `rebuild-diff-staging-<run>` artifact
   (hashes only, never code). State `BLOCKED` with a problem list is expected the first time.
2. **Plan PR**: copy the inspect's problems into the staging section of the plan (each one is a
   reviewed decision: a changed, added or removed file, or a dependency delta). Merge.
3. **Staging apply** (`mode: apply`) with `approved_commit` = main, `expected_live_code_sha256` from
   the inspect, `approval_phrase` exactly `DEPLOY FULL API PACKAGE TO STAGING`. The job builds the
   candidate before AWS credentials exist, takes the `checksops-staging-api` lease, issues a
   KMS-signed receipt owning the candidate ZIP's SHA-256, uploads it with RevisionId CAS, downloads
   the live package again and requires it to equal the candidate member for member, then smokes
   `/health`, `/db-health` and `/db-readonly-validate`.
4. **Production inspect**, **plan PR** for the production section, then **production apply** with
   `staging_acceptance_reference` = the green staging apply run URL and `approval_phrase` exactly
   `DEPLOY FULL API PACKAGE TO PRODUCTION`. The production environment reviewer must approve the job.
5. After a verified production rebuild: the overlay plan's live values are stale for every member
   the rebuild changed; the next overlay cycle starts with a whole-package read-only inspect and a
   plan reconcile PR, as before. `AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED` stays `false` until the
   owner turns it on through a separate guarded configuration change.

## What the writer never does

- Never uploads a ZIP the receipt does not own (the receipt's only owned component is
  `full-package@sha256:<candidate>`), never reads a candidate outside `.deployment-guard/`.
- Never restores an old ZIP, never changes configuration, never retries after a failed update.
- Never runs without `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1` plus a valid, unconsumed receipt; an
  overlay receipt cannot authorize a rebuild and a staging receipt cannot authorize production.

## Rollback

There is none in the writer by design. The previous package is the one the overlay plan records;
restoring it is a separate owner-approved operation through the guarded path, never an old ZIP.
