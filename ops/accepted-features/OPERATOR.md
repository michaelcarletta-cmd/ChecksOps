# Operator guide: accepted-feature registry

Evaluate-only. This guide does not authorize merge blocking, deployment,
Branding repair, GitHub ruleset changes, AWS, SQL, staging, or production.

Release Locks and Deployment Guard remain authoritative and unchanged.

## What this foundation does

- Inventories known features without marking them `accepted`.
- Evaluates intended Branding invariants against current main.
- Reports findings. Exit code is always `0`.
- Rejects `{ok:true}` as evidence.

## What this foundation must not do

- Replace or edit `ops/release-locks/` hashes unless those control-plane
  files themselves change in a separately authorized lock PR.
- Acquire a deployment lease or issue a receipt.
- Call AWS or apply SQL.
- Change SPA/Lambda deploy writers.
- Add a required GitHub check or mutate a ruleset.
- Auto-update protected-path hashes.
- Auto-supersede a feature.
- Convert the GREEN/YELLOW/RED audit matrix into enforcement.

## Adding inventory

1. Add a `feature_id` with `status=inventory_only` or `missing_from_main`.
2. Set `accepted_source_authority.restore_authority=false`.
3. Leave `git_sha` null unless you are documenting a pointer. A pointer is
   still not restore authority.
4. Do not set `status=accepted` from this guide.

## Intentional change of an accepted feature

Only after a later activation PR exists:

1. Keep the old feature record.
2. Add a `supersession_history` row with old authority, new authority,
   reason (≥20 characters), approving workstream, review PR, updated
   invariant IDs, updated tests, UTC timestamp, and 40-character commit.
3. Set `to_authority.restore_authority=true` only for the new accepted SHA.
4. A boolean flag or README sentence is not supersession.

## Branding

Current main is the known failing control case. Do not “fix” Branding by
weakening the intended invariants or by marking `branding` accepted.

## Collision

New files live under `ops/accepted-features/`, `scripts/lib/accepted-features.mjs`,
`scripts/validate-accepted-features.mjs`, and
`aws/tests/accepted-features-registry.test.mjs`. Those paths are outside
Release Lock ownership groups. If a future change needs to edit
`ops/release-locks/` or other protected control-plane files, stop and use
the lock overlap process instead of weakening the lock.
