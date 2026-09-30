# ChecksOps agent instructions

## Deployment safeguard

This repository has a permanent cross-workstream deployment guard.

Official commands (evaluate-only unless a later reviewed apply authorization exists):

```bash
node scripts/deployment-guard/preflight.mjs --input <manifest.json>
node scripts/deployment-guard/lease.mjs acquire --workstream-id <id> --environment <env> --component <component> --commit <sha>
node scripts/deployment-guard/lambda-overlay.mjs --input <overlay.json>
node scripts/deployment-guard/spa-promote.mjs --input <spa.json>
node scripts/deployment-guard/sql-apply.mjs --input <sql.json>
node scripts/deployment-guard/verify-live.mjs --input <live.json>
node scripts/deployment-guard/manifest.mjs --input <identity.json>
node scripts/deployment-guard/preserve-builds.mjs --input <preserve.json>
node scripts/production-deploy-guard.mjs --candidate <fingerprint.json>
```

Rules:

- Never deploy directly when this tooling exists.
- Never reclaim staging or production.
- Never reuse an old build, ZIP, or dist.
- Never overwrite another workstream.
- Stop on live-state drift (`DEPLOYMENT_COLLISION`).
- Reconcile same-file Lambda changes (`SOURCE_RECONCILIATION_REQUIRED`).
- Combine frontend sources when multiple workstreams changed the SPA (`SOURCE_COMPOSITION_REQUIRED`).
- Preserve unrelated live members.
- Production requires explicit approval for **this** workstream plus a staging acceptance reference.

Inventoried `MUST_REFUSE_DIRECT` scripts fail closed with `DEPLOYMENT_GUARD_REQUIRED` unless a valid short-lived receipt exists. Issue one via `preflight.mjs --acquire-lease --receipt` or `wrap-legacy.mjs`. Hand-written receipt JSON is `RECEIPT_FORGED`. A staging receipt cannot authorize production. An environment variable cannot bypass the guard.

Independent Cursor chats must also follow `.cursor/rules/preserve-builds.mdc`:
separate branches and worktrees, preserve accepted fixes, reconcile against
current main and `ops/deployment-guard/accepted-source-composition.json`,
reject stale SPA/full Lambda packages, require exclusive locks
(`require_exclusive_lock=true` plus a lease), a complete live fingerprint
with `captured_at`, verified git-merge-base ancestry (not
`reconciled_with_main=true`), candidate content hashes for accepted
composition, run accepted regression checks, and never automatically
roll back over another workstream.

See `.cursor/rules/deployment-guard.mdc`, `.cursor/rules/preserve-builds.mdc`,
and `ops/deployment-guard/README.md`.
