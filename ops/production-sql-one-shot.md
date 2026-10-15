# Production SQL one-shot

`scripts/deployment-guard/production-sql-one-shot.mjs` runs one production SQL migration
on the SQL53 runner (`i-0c35557c4e5385406`) as **one** invocation, in place of the
hand-written SSM scripts used for SQL 77–80 (see `ops/production-sql-77-79-apply.md` and
`ops/production-sql-80-apply.md`). It does not weaken any guard. It only orchestrates
the existing per-migration tools as child processes, and those tools stay the only code
that connects to the database:

| `--migration` | tool it runs |
|---|---|
| `sql77`, `sql78`, `sql79` | `scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration <key>` |
| `sql80` | `scripts/deployment-guard/sql80-checkalt-production-apply.mjs` |

To add a migration, register its reviewed tool in `ONE_SHOT_TOOLS`
(`scripts/deployment-guard/lib/production-sql-one-shot.mjs`). Tests:
`aws/tests/production-sql-one-shot.test.mjs` (in `npm run test:deployment-guard`).

## What one run does

Each step must pass before the next one starts. The run prints one JSON summary and
exits 1 at the first failure (`details.stopped_at` names the step).

1. **Pin.** Refuses unless the pin has `execute: true`, a staging acceptance
   (`ok: true` plus a reference) and an authorization phrase. All four pins are
   `execute: false` today, so every run refuses until a reviewed change sets one to true.
   For a read-only inspect before that change, run the tool's own `--inspect`.
2. **Source.** The tarball's name must be `source-<--commit>.tar.gz`. Its sha256 must
   equal the `.sha256` sidecar. Every file of the running tree must be byte-identical to
   the tarball, with the same symlinks and no extra files (`.deployment-guard/` is
   ignored). The migration file's sha256 must equal the pin's `source_sha256`.
3. **Inspect (read-only).** Runs `<tool> --inspect`. It stops unless all of these hold:
   `read_only`, `source_ok`, `pin_execute`, no `state_error`, no missing dependencies,
   predecessors applied, the live hash equal to the pin's expected hash,
   `live_matches_expected`, `already_applied` false, `precondition_failures` `[]` and
   `apply_preconditions_met` true.
4. **Contracts.** Runs every accepted contract that `ops/deployment-guard/accepted-contracts.json`
   requires for a production `sql-apply`. That is the same set preflight enforces, today
   `claim-ledger`, `tenant-isolation` and `financial-write-protections`
   (`aws/tests/api-write.test.mjs`). Each runs as `node --test --test-reporter=tap` on
   this tree, and any failed, skipped or cancelled test stops the run.
   **`--phase inspect` ends here and writes nothing.**
5. **Manifest.** Written to a fresh `0600` file in a temp directory outside the tree.
   It holds the pin's file, ids, hashes, staging acceptance and phrase, the inspect's
   live hash as all three fingerprints, `approval`
   `{ approved: true, workstream_id, approved_by: "owner", statement: <--approval-statement> }`,
   a new `one_use_id` `<key>-prod-<uuid>`, `build_timestamp` and the contract results.
6. **Preflight.** Runs `preflight.mjs --acquire-lease --receipt --input <manifest>`. The
   receipt path comes only from this child's output, and it must sit under
   `.deployment-guard/receipts/`.
7. **Evaluate.** Runs `<tool> --input <manifest>`, which must report
   `member_stakeholder_production_apply_allowed` / `sql80_production_apply_allowed` true.
8. **Apply.** Runs `<tool> --apply --input <manifest>`. This is the only child that gets
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1` and `CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT`. The
   tool's own checks still decide: guard, receipt ownership, execute, phrase,
   `one_use_id`, and the in-transaction re-read. The apply must report `applied` with
   the pin's before and after hashes.
9. **Post-apply inspect.** It must show the intended hash and `already_applied` true.
   It also runs after a failed apply, because the COMMIT outcome can be unknown.

The one-shot never takes a receipt, manifest or input file. Any flag beyond
`--migration --commit --workstream-id --approval-statement --phase --source-tarball
[--runner] [--operator]` is refused. It also refuses to start if any
`CHECKSOPS_DEPLOYMENT_GUARD_*` or `CHECKSOPS_SKIP_DEPLOYMENT_GUARD` variable is set. It
never writes a receipt itself.

On success, `details.applied` is a ready-to-paste block for the pin's `applied` record.
It contains only what this run observed. Items it cannot observe are marked:
`one_use_id_consumed_basis` (inferred from the successful apply), `runner_basis`
(`--runner` is operator-supplied) and `owner_approval_basis` (the statement as passed).
`details.not_observed_by_this_run` lists what the operator adds from outside: the SSM
command id and the `sql53-temporary-transfer` run id.

## The single SSM command

Stage the reviewed main commit with `.github/workflows/sql53-temporary-transfer.yml`
first. The tarball now contains `aws/functions/api/node_modules` (installed from that
package's own lockfile), so `api-write.test.mjs` loads on the runner. A tarball built
before that change lacks `@aws-sdk/client-s3`, and its financial-write contract stops
the run. Re-stage it.

```bash
set -euo pipefail
SHA=<full main sha>
WORK=$(mktemp -d /var/tmp/sql-one-shot-XXXXXX)
cd "$WORK"
aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
sha256sum -c "source-${SHA}.tar.gz.sha256"
mkdir src
tar -xzf "source-${SHA}.tar.gz" -C src
cd src
export AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com
node scripts/deployment-guard/production-sql-one-shot.mjs \
  --migration sql80 \
  --commit "$SHA" \
  --workstream-id prod-sql80-<name>-<yyyymmdd> \
  --approval-statement '<the owner'"'"'s exact words>' \
  --source-tarball "$WORK/source-${SHA}.tar.gz" \
  --runner i-0c35557c4e5385406 \
  --phase inspect          # then, once approved, the same command with --phase apply
```

Extract into a fresh, empty directory: an extra file in the tree stops the run. Use
`--phase inspect` first. After the owner approves the run, send the same command with
`--phase apply`, which repeats every check. Then a reviewed change records
`details.applied` in the pin and sets `execute` back to `false`, as for SQL 77–80.

## Approval bundles

This is the owner's working agreement for running a workstream end to end without a
round trip at every step:

1. **Before work starts,** the operator lists the bundle:
   - the files to change, with the hashes they will have (SQL `source_sha256`, pinned
     expected and intended hashes);
   - the lock and plan changes (pin fields, release-lock or ledger entries);
   - the ordered staging and production steps, each with its exact command (for
     production SQL: the transfer run, then this one-shot `--phase inspect`, then
     `--phase apply`, then the record-and-retire change).
2. **The owner approves that named list once, for this workstream.** The approval names
   the workstream id and the list. The operator passes the owner's exact words as
   `--approval-statement`.
3. **The operator runs the list end to end** and **stops and returns to the owner** on
   any of these:
   - a hash that differs from the list (source, tarball, live pre-state, after-state);
   - a guard refusal: `DEPLOYMENT_COLLISION`, `SOURCE_RECONCILIATION_REQUIRED`,
     `SOURCE_COMPOSITION_REQUIRED`, or any other refusal code;
   - a failed check, contract or inspect condition;
   - anything that is not on the list, including a new step, a changed command or a
     different target.

   A stop is never worked around, retried with different inputs, or "fixed forward"
   without returning to the owner.

This agreement **does not change the rules in `AGENTS.md`**. Production still requires
explicit owner approval for **this** workstream plus the pin's staging acceptance
reference. An approval never carries over from an earlier workstream or bundle. Receipts
come only from `preflight.mjs` (hand-written receipt JSON is `RECEIPT_FORGED`). No
environment variable bypasses the guard. A pin with `execute: false` still refuses.
