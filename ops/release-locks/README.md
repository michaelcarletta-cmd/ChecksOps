# ChecksOps release locks

Fail-closed repository safeguards that distinguish **merged source**, **staging proof**, and **production-locked** artifacts.

This directory does **not** deploy, apply SQL, change AWS, or mark unverified components `PRODUCTION_LOCKED`.

Repository validation protects the release process. It cannot independently prove live AWS truth. Live state must be gathered by a separately reviewed, read-only verification process.

`CODEOWNERS` is advisory until GitHub requires code-owner review. The `release-locks` check must become a required status check. Direct pushes and administrator bypasses must be disabled separately. Until that GitHub enforcement exists, this workstream remains **REVISION REQUIRED**. Do not treat a green PR-head workflow as merge-ready. The pre-existing `aws-migration-guards` failure is unrelated and must not be hidden or renamed.

## Files

| Path | Role |
|---|---|
| `schema/*.schema.json` | Strict schemas (unknown properties and duplicate JSON keys fail) |
| `locked-components.json` | Machine-readable component manifest |
| `protected-paths.json` | Ownership groups, control-plane mapping, unowned-file watches |
| `applied-migrations.ledger.json` | Append-only SQL source/apply ledger (genesis immutable starting point) |
| `overlap-allowlist.json` | Explicit exceptions for overlapping open PRs (empty by default) |
| `evidence-matrix.json` | Discovery snapshot used for the initial classification |
| `OPERATOR.md` | How to update, unlock, or record production evidence |

Control-plane paths: `.github/CODEOWNERS`, `.github/workflows/release-locks.yml`, `ops/release-locks/**`, `scripts/lib/release-locks.mjs`, `scripts/validate-release-locks.mjs`, `scripts/check-pr-path-overlap.mjs`, `scripts/production-deploy-guard.mjs`.

## Classifications

1. `PRODUCTION_LOCKED` — production-active artifact with immutable fingerprint, validation evidence, and (except a SPA-only frontend with recorded `spa_bundle` + `spa_sha256`) required SQL applied in production with matching hashes. `production-spa` is the live checksops.com baseline.
2. `SOURCE_LOCKED_NOT_ACTIVE` — approved source is pinned; SQL or deploy is not proven.
3. `STAGING_LOCKED_NOT_PRODUCTION` — verified in staging only.
4. `UNVERIFIED` — evidence incomplete, conflicting, or stale.

`production-spa` is `PRODUCTION_LOCKED` to the live production frontend. Other components stay unlocked. Documentation and merged PRs alone are not sufficient. `origin/main` is not the live SPA.

## Checks

```bash
node scripts/validate-release-locks.mjs
node --test ops/release-locks/tests/*.test.mjs
node scripts/production-deploy-guard.mjs
CHECKSOPS_PRODUCTION_DEPLOY=1 node scripts/production-deploy-guard.mjs
node scripts/check-pr-path-overlap.mjs --require
```

CI workflow: `.github/workflows/release-locks.yml` (pinned action SHAs, `merge_group` trigger). Existing AWS migration CI and tax-profile migration guards are unchanged.
