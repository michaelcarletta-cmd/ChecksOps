# ChecksOps deployment guard

Permanent repository-level safeguard so independent Cursor chats, agents,
branches, and workstreams cannot overwrite, restore, regress, or silently
replace each other's staging or production work.

This workstream is **source only**. It does not deploy, change staging,
change production, change database data, or change AWS/IAM.

## Phase 1 analysis (read-only)

### A. Existing deployment scripts

There is no single official overlay/promote CLI. Live updates have been
done by one-off apply/inspect scripts (see `bypass-inventory.json`).

### B. Existing release locks / safeguards

`ops/release-locks/` plus `scripts/production-deploy-guard.mjs` lock
**source trees, SQL ledgers, PR path overlap, and recorded production SPA
fingerprints**. They do not:

- overlay a live Lambda ZIP
- compare RevisionId / CodeSha256 immediately before write
- lease a shared environment
- detect same-file Lambda member conflicts
- reject stale `/tmp` packages or reused `dist/`
- run an accepted-feature contract registry at deploy time

This guard is complementary. It does not replace release-locks.

### C. Protected-path mechanisms

`ops/release-locks/protected-paths.json` + `scripts/check-pr-path-overlap.mjs`.
Reused for control-plane ownership of this guard.

### D. Accepted-contract mechanisms

None as a registry. Closest: production SPA baseline and scattered AWS tests.
This folder adds `accepted-contracts.json`.

### E. Direct AWS deployment bypasses

Inventoried in `bypass-inventory.json`. Legacy apply scripts are **not
deleted**. They must later call `scripts/deployment-guard/require-guard.mjs`
or fail.

### F. Shared targets

| Environment | Kind | Name |
|---|---|---|
| staging | Lambda | `checksops-staging-api` |
| staging | Lambda | `checksops-staging-rehearsal-oneshot` |
| staging | Lambda | `checksops-staging-partner-integrity-3bce` |
| staging | SPA | `https://staging.checksops.com` (bucket/id unverified here) |
| production | Lambda | `checksops-production-prep-api` |
| production | SPA | `checksops.com` / CloudFront `E1B0ZWWO5559U5` / bucket `checksops-production-frontend-806168576068` |

### G. Reused

- `scripts/lib/release-locks.mjs` hashes / fail-closed style
- `scripts/lib/production-spa-baseline.mjs`
- `scripts/production-deploy-guard.mjs`

### H. Architecture

```
ops/deployment-guard/          config + inventory (this directory)
scripts/deployment-guard/      plan-only enforcement
aws/tests/deployment-guard.test.mjs
.cursor/rules/deployment-guard.mdc
```

Every live I/O port is injected. The default AWS adapter refuses reads and
writes. Apply functions exist only to fail closed.

### I. Files added / changed

See the pull request. Control-plane wiring updates `production-release`
protected paths and tree hash only.

### J. Migration plan for existing scripts

1. Keep the script.
2. `import { mustClearGuard } from '../../scripts/deployment-guard/require-guard.mjs'`.
3. Run `node scripts/deployment-guard/preflight.mjs` with a workstream
   manifest and pass the receipt into `mustClearGuard`.
4. Overlay only declared Lambda members onto a **freshly downloaded** live
   ZIP. Re-read CodeSha256 + RevisionId immediately before
   `UpdateFunctionCode`. Use RevisionId CAS.
5. If live state drifted: **STOP**. Never reclaim.

## Commands future Cursor chats must use

```bash
# Always start here. Never call AWS directly when this tooling exists.
node scripts/deployment-guard/preflight.mjs --dry-run

# Workstream identity (no anonymous deploy)
node scripts/deployment-guard/manifest.mjs \
  --workstream-id cursor/my-work \
  --target-environment staging \
  --deployment-type lambda-overlay \
  --owned-components staging-api

# Short-lived deployment lease (source work may continue without a lease)
node scripts/deployment-guard/lease.mjs acquire \
  --workstream-id cursor/my-work \
  --environment staging \
  --component checksops-staging-api \
  --commit <40-char-sha>

node scripts/deployment-guard/lease.mjs release \
  --workstream-id cursor/my-work \
  --environment staging \
  --component checksops-staging-api

# Plan-only helpers (no AWS)
node scripts/deployment-guard/lambda-overlay.mjs
node scripts/deployment-guard/spa-promote.mjs
node scripts/deployment-guard/sql-apply.mjs
node scripts/deployment-guard/verify-live.mjs
```

Production still also requires:

```bash
node scripts/production-deploy-guard.mjs --candidate path/to/fingerprint.json
```

## Core rule

If live state changed after a workstream's preflight: **STOP**.

Never restore, reclaim, redeploy the old baseline, put an old `dist`
back, reuse an old Lambda ZIP, or overwrite newer live state.
