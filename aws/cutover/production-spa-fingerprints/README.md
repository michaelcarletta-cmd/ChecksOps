# Production SPA fingerprints

`node scripts/deploy-production-spa.mjs` records:

Git commit → SPA bundle hashes → Cognito pool/client → API target → timestamp

`latest.json` is written locally by that script and is gitignored.

`--apply` is **locked** after the successful 2026-09-14 cutover. See `aws/cutover/PRODUCTION_SPA_LOCK.json`.

Unlocked apply is refused (`production_spa_cutover_locked`). Rollback may restore **only** a previously validated AWS/Cognito fingerprint (`868e69387d63…` / `index-CiOVNYWh.js`) and only with `CHECKSOPS_PRODUCTION_SPA_UNLOCK=RELEASE_CUTOVER_LOCK --from-fingerprint <file>`. Supabase-mode artifacts are rejected.

Do not use `npm run build`, `vite build`, Lovable Publish, or raw `aws s3 sync` for production.
