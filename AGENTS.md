# ChecksOps agent instructions

## Deployment safeguard (always on)

This repository has a permanent deployment guard. Read and follow
`.cursor/rules/deployment-guard.mdc` and `ops/deployment-guard/README.md`.

- Use `node scripts/deployment-guard/preflight.mjs` — never deploy around it
- Never reclaim staging/production or reuse an old build
- Stop on live-state drift (`DEPLOYMENT_COLLISION`)
- Reconcile same-file Lambda changes (`SOURCE_RECONCILIATION_REQUIRED`)
- Preserve unrelated workstreams
- Do not change staging, production, database data, or AWS from a safeguard-only chat

Existing source locks remain in force: `ops/release-locks/OPERATOR.md`.
