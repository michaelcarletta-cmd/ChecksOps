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

See `.cursor/rules/deployment-guard.mdc` and `ops/deployment-guard/README.md`.

## Migrations and pins are append-only

- Never edit a migration in `aws/workflows/sql/` that already exists on main. Applied or
  pinned bytes are history. A fix (a missing GRANT, a policy, a column) is a **new numbered
  migration** taken through the guarded staging and production path, as SQL 103 was for
  SQL 29 and SQL 104 is for SQL 91.
- Never change the recorded evidence of an applied pin (`applied`, `production_evidence`,
  `source_sha256`, the expected/intended hashes, `staging_acceptance`, `production_inspect`).
  A record-and-retire change only adds the `applied` record and sets `execute: false`.
- Never apply SQL to staging or production by hand (psql, the console, a one-off script).

## When CI fails

- Find the root cause. Never edit expected hashes, fingerprints or recorded evidence to make
  a test pass: those checks exist to catch the change you just made.
- Hashes come from the code (`releaseIntendedHash`, sha256 of the file bytes on an LF
  checkout), never from a value copied out of a failing test.
- Re-run a failed job at most once, and only when the failure is not in code this change
  touches. A second failure is real.

## Checkout

- Work on an LF checkout (`.gitattributes` enforces it; on Windows also
  `git config core.autocrlf false`). A CRLF checkout changes every pinned hash locally.
