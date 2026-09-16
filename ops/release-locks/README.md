# ChecksOps release locks

Fail-closed repository safeguards that distinguish **merged source**, **staging proof**, and **production-locked** artifacts.

This directory does **not** deploy, apply SQL, change AWS, or mark unverified components `PRODUCTION_LOCKED`.

## Files

| Path | Role |
|---|---|
| `schema/locked-components.schema.json` | Required evidence and allowed classifications |
| `locked-components.json` | Machine-readable component manifest |
| `protected-paths.json` | Ownership groups and protected path prefixes |
| `applied-migrations.ledger.json` | Append-only SQL source/apply ledger |
| `overlap-allowlist.json` | Explicit exceptions for overlapping open PRs (empty by default) |
| `evidence-matrix.json` | Discovery snapshot used for the initial classification |
| `OPERATOR.md` | How to update, unlock, or record production evidence |

## Classifications

1. `PRODUCTION_LOCKED` — merged code, required SQL applied in production with matching hashes, exact artifact deployed, production validation completed, deployment fingerprint recorded.
2. `SOURCE_LOCKED_NOT_ACTIVE` — approved source is pinned; SQL or deploy is not proven.
3. `STAGING_LOCKED_NOT_PRODUCTION` — verified in staging only.
4. `UNVERIFIED` — evidence incomplete, conflicting, or stale.

No component is `PRODUCTION_LOCKED` on this PR. Documentation and merged PRs are not sufficient.

## Checks

```bash
node scripts/validate-release-locks.mjs
node --test ops/release-locks/tests/*.test.mjs
node scripts/production-deploy-guard.mjs
node scripts/check-pr-path-overlap.mjs --require
```

CI workflow: `.github/workflows/release-locks.yml`.

Existing AWS migration CI and tax-profile migration guards are unchanged.
