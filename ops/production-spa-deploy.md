# Production website deploy (checksops.com)

Workflow: `.github/workflows/guarded-production-spa-upload.yml` (main only, `production`
environment, role `ChecksOpsProductionSpaDeploy` narrowed by a session policy).
Preflight: `scripts/deployment-guard/github-production-spa-upload.mjs`.
Writer: `scripts/deployment-guard/production-spa-upload.mjs` (the only thing that writes).

## Steps (each needs owner approval)

1. **Inspect** (`mode: inspect`): reads only the live `index.html`. Records its SHA-256,
   entry bundle and whether it still equals the `production-spa` release lock in
   `ops/release-locks/locked-components.json`.
2. **Apply** (`mode: apply`) with:
   - `approved_commit`: the exact main commit the run is on
   - `expected_live_index_sha256`: from step 1
   - `staging_acceptance_reference`: a ChecksOps run or PR URL recording staging acceptance
   - `approval_phrase`: `DEPLOY WEBSITE TO PRODUCTION`

   Apply refuses unless live still equals the release lock and the lock's source commit is
   an ancestor of the approved commit (so nothing live is dropped). It builds a fresh
   `vite build --mode aws` with the production Cognito pool and same-origin `/prep`, runs
   every accepted contract, takes the `production-spa` lease and issues a receipt. The
   writer then re-reads live before the first write and before the `index.html` switch,
   uploads assets first and `index.html` last (no sync, no delete), invalidates `/*`,
   and verifies `checksops.com` serves the new bundle.
3. **Advance the release lock** in a reviewed PR: record the new bundle, its SHA-256,
   `index.html` SHA-256, S3 version and source commit for `production-spa`, with the
   previous lock as rollback. Until then, the next deploy refuses because live no longer
   equals the lock.

## Rollback

The bucket is versioned. Re-upload the previous `index.html` version (the old assets are
never deleted) as a separate owner-approved operation, then invalidate `/*`.
