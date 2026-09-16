# Operator guide: locked components

These controls are **fail-closed**. Missing evidence is a failure, not a skip. This guide does not authorize production writes.

## What the lock actually enforces

- Protected-path hashes in `locked-components.json` must match the current tree.
- Recorded SQL `source_sha256` values must match file bytes. Editing a recorded migration without a reviewed ledger/manifest update fails CI.
- `PRODUCTION_LOCKED` is rejected unless every required evidence field is present.
- `production_active=true` is forbidden unless classification is `PRODUCTION_LOCKED`.
- A production deploy candidate fingerprint must match locked artifacts. Live AWS comparison is disabled on purpose.
- Overlapping open PRs that already touch the same protected path fail CI unless an explicit `overlap-allowlist.json` exception is reviewed.

Documentation, chat history, and “merged” status are **not** production locks.

## Intentionally updating a protected component

1. Open a **new** PR from latest `origin/main`. Do not reuse another agent’s branch.
2. Run `node scripts/check-pr-path-overlap.mjs --require` before editing. If another open PR already owns the path, stop.
3. Change the source files **and** in the same PR:
   - update `components.<id>.source.git_sha` to the parent/main SHA you started from, then to the commit that contains the change after it lands;
   - replace `source.tree_hash` with the value from `node scripts/validate-release-locks.mjs --print-hashes`;
   - if SQL bytes change, **append** a new ledger entry (never rewrite `applied=true` rows). Set `applied=false` until independent apply proof exists;
   - add missing-evidence notes or, for a real promotion, the production fingerprint fields.
4. Keep `fail_closed: true`. Do not delete CI jobs to get a green check.
5. Request review. Do not merge from this guide.

## Promoting to PRODUCTION_LOCKED

A reviewed PR may change classification only when **all** of these are attached as repo evidence (not chat):

- merged git SHA for the exact source tree
- every `required_sql` row `applied=true`, `applied_environment=production`, `applied_sha256 === source_sha256`
- artifact hash (SPA bundle SHA-256 and/or Lambda version; aliases if used)
- production validation completed, with evidence refs that are themselves in git
- `deployment_fingerprint.recorded=true`
- rollback git SHA **and** rollback artifact
- `missing_evidence` empty
- `production_active=true`

If any item is missing, the validator fails. Use `SOURCE_LOCKED_NOT_ACTIVE` or `UNVERIFIED` instead.

## Unlocking / rolling back

Unlocking means a reviewed PR that:

- sets classification to `UNVERIFIED` or `SOURCE_LOCKED_NOT_ACTIVE`
- sets `production_active=false`
- records rollback references
- does **not** delete historical ledger rows

Do not “unlock” by editing AWS, applying SQL, or force-pushing `main`.

## Production deploy guard

Operators who wrap a deploy script MUST run:

```bash
node scripts/production-deploy-guard.mjs --candidate path/to/fingerprint.json
```

`CHECKSOPS_PRODUCTION_DEPLOY=1` fails unless a candidate fingerprint is supplied **and** the targeted components are `PRODUCTION_LOCKED` with matching hashes. `--live` always fails.

## Overlap exceptions

`overlap-allowlist.json` is empty. An exception must name:

- `other_pr` (number)
- exact `path` prefix
- `reason` (≥ 20 characters)

Wildcards that swallow another workstream are forbidden.

## Out of scope (do not do from a lock PR)

- merge to main from the agent
- `sam deploy`, `aws s3 sync`, CloudFront invalidation
- `psql` / migration apply
- Cognito user/pool changes
- secret rotation
- Moov/CheckAlt/SES/financial operations
