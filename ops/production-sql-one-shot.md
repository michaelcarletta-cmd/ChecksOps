# Production SQL one-shot

`scripts/deployment-guard/production-sql-one-shot.mjs` runs one production SQL migration
on the SQL53 runner (`i-0c35557c4e5385406`) as **one** invocation. It replaces the
hand-written SSM scripts used for SQL 77–80 (see `ops/production-sql-77-79-apply.md` and
`ops/production-sql-80-apply.md`). It does not weaken any guard. It only orchestrates
the existing per-migration tools as child processes, and those tools stay the only code
that connects to the database:

| `--migration` | tool it runs |
|---|---|
| `sql29` | `scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs` (`ops/production-sql-29-30-apply.md`; before SQL 90 and SQL 94: the tool refuses with `sql90_not_applied` once SQL 90 is in place, and the one-shot also requires the inspect's `sql90_applied` to be `false`) |
| `sql30` | `scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs` (same runbook; before SQL 90, a SQL 90 predecessor, and before SQL 94, whose CHECK it refuses; independent of SQL 29, release order runs SQL 29 first) |
| `sql71` | `scripts/deployment-guard/sql71-review-amount-production-apply.mjs` (`ops/production-sql-71-apply.md`) |
| `sql77`, `sql78`, `sql79` | `scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration <key>` |
| `sql80` | `scripts/deployment-guard/sql80-checkalt-production-apply.mjs` |
| `sql81` | `scripts/deployment-guard/sql81-checkalt-production-apply.mjs` (`ops/production-sql-81-apply.md`) |
| `sql82` | `scripts/deployment-guard/sql82-homeowner-ledger-production-apply.mjs` (`ops/production-sql-82-83-apply.md`) |
| `sql83` | `scripts/deployment-guard/sql83-homeowner-signing-production-apply.mjs` (`ops/production-sql-82-83-apply.md`) |
| `sql84` | `scripts/deployment-guard/sql84-mortgage-return-to-queue-production-apply.mjs` (`ops/production-sql-84-86-apply.md`) |
| `sql85` | `scripts/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.mjs` (`ops/production-sql-84-86-apply.md`) |
| `sql86` | `scripts/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.mjs` (`ops/production-sql-84-86-apply.md`) |
| `sql87` | `scripts/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.mjs` (`ops/production-sql-87-apply.md`) |
| `sql88` | `scripts/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.mjs` (`ops/production-sql-88-apply.md`) |
| `sql89` | `scripts/deployment-guard/sql89-check-intake-column-update-production-apply.mjs` (`ops/production-sql-89-apply.md`) |
| `sql90` … `sql97` | `scripts/deployment-guard/sql90-users-only-tenant-roles-production-apply.mjs`, `sql91-moov-onboarding-…`, `sql92-signature-request-check-files-link-grant-…`, `sql93-tenant-company-info-…`, `sql94-document-library-restore-…`, `sql95-remove-freedom-claims-bridge-…`, `sql96-platform-owner-tenant-pricing-…`, `sql97-financial-stepup-log-server-writer-production-apply.mjs` (`ops/production-sql-90-97-apply.md`, which also gives their order) |
| `sql98` … `sql100` | `scripts/deployment-guard/sql98-tenant-fee-collection-production-apply.mjs`, `sql99-mortgage-desk-completion-messages-…`, `sql100-mortgage-desk-live-access-production-apply.mjs` (same runbook; SQL 100 is a strict no-op on production and its tool never runs the file there, so its pin never becomes executable and the one-shot refuses it) |
| `sql101` | `scripts/deployment-guard/sql101-invite-identity-insert-order-production-apply.mjs` (same runbook; after SQL 90, before `tenant-admin.mjs`) |
| `sql102` | `scripts/deployment-guard/sql102-platform-owner-tenant-profile-production-apply.mjs` (same runbook; after SQL 98, before `tenant-billing-handlers.mjs`) |
| `sql103` | `scripts/deployment-guard/sql103-share-library-trigger-acl-production-apply.mjs` (`ops/production-sql-103-apply.md`; immediately before SQL 29, `runs_before: ['sql29']`: SQL 29's guard refuses the trigger function's live `checksops` EXECUTE until SQL 103 ran; no predecessor, already in place after SQL 29) |

To add a migration, register its reviewed tool in `ONE_SHOT_TOOLS`
(`scripts/deployment-guard/lib/production-sql-one-shot.mjs`). An entry names only the tool,
its arguments, the pin file and the tool's `<key>_production_apply_allowed`; the file hash
(`source_sha256`) and the fingerprints are always read from the pin, so a reviewed change to
a migration file touches its pin, not the registry. An entry may add `inspect_requires`
(inspect fields that must hold an exact value, e.g. SQL 29's `sql90_applied: false`) and
`runs_before` (informational order). Tests:
`aws/tests/production-sql-one-shot.test.mjs` (in `npm run test:deployment-guard`).

## Flags

| flag | |
|---|---|
| `--migration <key>` | a registered key (`sql29`, `sql30`, `sql71`, `sql77`…`sql89`, `sql90`…`sql103`) |
| `--approval-scope <key>` | the migration the owner approved; must equal `--migration` |
| `--approval-statement "<words>"` or `--approval-statement-b64 <base64>` | the owner's exact words, recorded verbatim. Pass exactly one of the two. Use the base64 form when the words contain quotes or newlines. Must be non-empty. |
| `--commit <sha>` | the full main commit the tarball was built from |
| `--workstream-id <id>` | this workstream (`^[A-Za-z0-9._:-]{8,128}$`) |
| `--operator <login>` | required; recorded in the manifest |
| `--source-tarball <path>` | the downloaded `source-<sha>.tar.gz`, with its `.sha256` next to it |
| `--expected-tarball-sha256 <hex>` | the `TARBALL_SHA256` line printed in the transfer run's log |
| `--phase inspect\|apply` | |
| `--runner <label>` | optional, e.g. the instance id; defaults to the hostname. Either way the source is recorded in `runner_basis`. |

Every other flag is refused, including `--receipt`, `--input` and `--skip-contracts`. The
one-shot never takes a receipt, a manifest or an input file, and it never writes a
receipt itself.

It also refuses to start in any of these cases:

- any `CHECKSOPS_DEPLOYMENT_GUARD_*` variable, or `CHECKSOPS_SKIP_DEPLOYMENT_GUARD`, is
  set. There is no exception: the KMS variables are read only by the GitHub-hosted
  Lambda, SPA and staging-executor scripts, and never by `preflight.mjs` or these tools.
- a node loader variable is set (`NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`,
  `NODE_PRESERVE_SYMLINKS*`, `NODE_ICU_DATA`, `NODE_COMPILE_CACHE`, `OPENSSL_CONF`,
  `OPENSSL_MODULES`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_*`).
- node itself was started with flags.

Children get only `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `AWS_REGION`,
`AWS_DEFAULT_REGION` and `AWS_ENDPOINT_URL_SECRETS_MANAGER`. The tools read the admin
secret with the instance role in `us-east-1` and connect with the repository's RDS CA
bundle, so they need nothing else.

## What one run does

Each step must pass before the next one starts. The run prints one JSON summary and
exits 1 at the first failure (`details.stopped_at` names the step).

An unexpected exception also ends in one failure summary:
- `code` is `ONE_SHOT_EXCEPTION`;
- `stopped_at` is `<last completed step> (exception)`;
- the steps completed so far are listed;
- if the apply child had started, a `warning` says to run the read-only `--inspect`
  before anything else.

1. **Pin.** Refuses unless the pin has `execute: true`, a staging acceptance
   (`ok: true` plus a reference) and an authorization phrase. SQL 82's to 86's pins are
   `execute: true` (owner approved 2026-10-16, staging acceptance recorded, see
   `ops/production-sql-82-83-apply.md` and `ops/production-sql-84-86-apply.md`), and SQL 91's
   and SQL 92's (owner approved 2026-10-19, production pre-state and staging acceptance recorded
   in their pins, see `ops/production-sql-90-97-apply.md`), until their
   record-and-retire changes. Every other pin is `execute: false` (SQL 81's since its
   2026-10-15 record-and-retire change; SQL 87's, SQL 88's and SQL 89's since their
   2026-10-16 applies, see `ops/production-sql-87-apply.md`, `ops/production-sql-88-apply.md`
   and `ops/production-sql-89-apply.md`; SQL 103's, SQL 29's and SQL 30's since their
   2026-10-19 applies, see `ops/production-sql-103-apply.md` and `ops/production-sql-29-30-apply.md`;
   SQL 71's still pending), so a run of it refuses until an owner-merged
   change sets it to true. For a read-only inspect before that change, run the tool's own `--inspect`.
2. **Source.** All of these must hold:
   - The tarball's name is `source-<--commit>.tar.gz`.
   - The tarball is read into memory once. Its sha256 must equal both the `.sha256`
     sidecar and `--expected-tarball-sha256`, and the file index is built from those same
     bytes.
   - `SOURCE_COMMIT` in the tree is `--commit`. Tarballs built before that file existed
     must be staged again.
   - Every file of the running tree is byte-identical to the tarball, with the same
     symlinks and no extra files (`.deployment-guard/` is ignored).
   - No symlink resolves outside the tree, checked both lexically and with the kernel's
     realpath. For example, `s -> .` plus `t -> s/..` is refused, and so is a dangling
     link.
   - The migration file's sha256 equals the pin's `source_sha256`.

   The tree comparison is repeated right before preflight and right before apply. Each
   repeat compares against that cached index; the tarball file on disk is not read
   again, so swapping the tarball and the tree together is caught.
3. **Inspect (read-only).** Runs `<tool> --inspect`. It stops unless all of these hold:
   - `read_only`, `source_ok` and `pin_execute` are true, and there is no `state_error`;
   - no dependencies are missing, and the predecessors are applied;
   - the live hash equals the pin's expected hash, and `live_matches_expected` is true;
   - `already_applied` is false;
   - `precondition_failures` is `[]` and `apply_preconditions_met` is true;
   - every `inspect_requires` field of the registry entry holds its value (SQL 29:
     `sql90_applied` is `false`).
4. **Contracts.** The one-shot runs, on this tree, the test of every accepted contract in
   `ops/deployment-guard/accepted-contracts.json` that applies to a production
   `sql-apply`. Today that is `claim-ledger`, `tenant-isolation` and
   `financial-write-protections` (`aws/tests/api-write.test.mjs`).
   - Each test runs as `node --test --test-reporter=tap`. The counts come from the
     reporter's final summary.
   - The run stops unless every test passes, with none failed, cancelled, skipped or todo.
   - Each recorded result names the runner and how that runner was identified.
   - Preflight does not run tests itself. It only refuses a `sql-apply` manifest that
     lacks a passing result for each of these contracts. These are the results it reads.
   - **`--phase inspect` ends here and writes nothing.**
5. **Manifest.** Written to a fresh `0600` file in a temp directory outside the tree.
   The directory is deleted when the run ends, whether it succeeded or failed; the summary
   keeps `manifest_sha256`. The manifest holds:
   - the pin's file, ids, hashes, staging acceptance and phrase;
   - the inspect's live hash as all three fingerprints;
   - `approval`: `{ approved: true, workstream_id, approved_by: "owner", statement }`;
   - a new `one_use_id` (`<key>-prod-<uuid>`), `build_timestamp` and the contract
     results.
6. **Preflight.** Runs `preflight.mjs --acquire-lease --receipt --input <manifest>`. The
   receipt path comes only from this child's output, and it must sit under
   `.deployment-guard/receipts/`.
7. **Evaluate.** Runs `<tool> --input <manifest>`, which must report
   `member_stakeholder_production_apply_allowed` / `sql71_production_apply_allowed` /
   `sql80_production_apply_allowed` /
   `sql81_production_apply_allowed` / `sql82_production_apply_allowed` /
   `sql83_production_apply_allowed` / `sql84_production_apply_allowed` /
   `sql85_production_apply_allowed` / `sql86_production_apply_allowed` /
   `sql87_production_apply_allowed` / `sql88_production_apply_allowed` /
   `sql89_production_apply_allowed` / `sql29_production_apply_allowed` /
   `sql30_production_apply_allowed` / `sql90_production_apply_allowed` … true (the
   registry entry's `allowed_key`).
8. **Apply.** Runs `<tool> --apply --input <manifest>`.
   - This is the only child that gets `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1` and
     `CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT`.
   - The tool's own checks still decide: guard, receipt ownership, execute, phrase,
     `one_use_id`, and the re-read inside the transaction.
   - The apply must report `applied` with the pin's before and after hashes.
9. **Post-apply inspect.** It must show the intended hash and `already_applied` true.
   It also runs after a failed apply, because the COMMIT outcome can be unknown.

On success, `details.applied` is a ready-to-paste block for the pin's `applied` record.
It contains only what this run observed. Items the run cannot observe are marked:

- `one_use_id_consumed_basis`: inferred from the successful apply.
- `runner_basis`: the runner label came from `--runner` or from the hostname.
- `owner_approval_basis`: the statement and scope as passed.
- `source_commit_basis`: `SOURCE_COMMIT` and the operator-copied tarball sha256.

`details.not_observed_by_this_run` lists what the operator adds from outside: the SSM
command id and the `sql53-temporary-transfer` run id.

**Replay protection.** A second run cannot apply the same migration twice:

- the tool's inspect and its in-transaction re-read refuse a live state that is already
  the intended one (`already_applied`);
- the record-and-retire change sets the pin's `execute` back to `false`, and step 1 then
  refuses every run.

`one_use_id` does not provide this. Every run mints a fresh id, and the tool's consumed-id
registry lives in the extracted tree's `.deployment-guard/`, which is new for every
extraction.

## The transfer workflow

`.github/workflows/sql53-temporary-transfer.yml` has three jobs:

- `package` (contents read). Archives main, adds the runner dependencies (root `pg` and
  `@aws-sdk/client-secrets-manager`, plus `aws/functions/api`'s own lockfile
  dependencies, so `api-write.test.mjs` loads), writes `SOURCE_COMMIT`, tars and
  hashes, and prints `TARBALL_SHA256 <hex>`. It runs no tests.
- `contracts` (contents read, no AWS token). Re-verifies the handed-off tarball's sha256
  against the `package` job's output, extracts it into a fresh directory, and runs the
  contracts the registry requires for a production `sql-apply`. The list is built with
  command substitution, so a failing node exits the step, and an empty list fails the
  job.
- `upload` (the only job with `id-token: write`). Runs no repository or npm code. It
  re-verifies the tarball and its sidecar against the `package` job's sha256 output,
  then uploads both.

## The single SSM command

Stage the reviewed main commit with the transfer workflow first, and copy the
`TARBALL_SHA256` value from its log.

```bash
set -euo pipefail
SHA=<full main sha>
TARBALL_SHA256=<TARBALL_SHA256 from the transfer run log>
WORK=$(mktemp -d /var/tmp/sql-one-shot-XXXXXX)
cd "$WORK"
aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
echo "${TARBALL_SHA256}  source-${SHA}.tar.gz" | sha256sum -c -
mkdir src
tar -xzf "source-${SHA}.tar.gz" -C src
cd src
export AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com
node scripts/deployment-guard/production-sql-one-shot.mjs \
  --migration sql80 \
  --approval-scope sql80 \
  --commit "$SHA" \
  --workstream-id prod-sql80-<name>-<yyyymmdd> \
  --operator michaelcarletta-cmd \
  --approval-statement-b64 '<base64 of the owner'"'"'s exact words>' \
  --source-tarball "$WORK/source-${SHA}.tar.gz" \
  --expected-tarball-sha256 "$TARBALL_SHA256" \
  --runner i-0c35557c4e5385406 \
  --phase inspect          # then, for the approved run, the same command with --phase apply
```

Extract into a fresh, empty directory, because an extra file in the tree stops the run.
`--phase inspect` may come first and needs no apply approval, since it is read-only.
`--phase apply` runs only after the owner has approved that named run, and it repeats
every check. Afterwards, a reviewed change records `details.applied` in the pin and sets
`execute` back to `false`, as for SQL 77–80.

## Approval bundles

This is the owner's working agreement for running a workstream end to end without a
round trip at every step.

1. **Before work starts, the operator lists the bundle:**
   - the files to change, with the hashes they will have (SQL `source_sha256`, pinned
     expected and intended hashes);
   - the lock and plan changes (pin fields, release-lock or ledger entries);
   - the ordered staging and production steps, each with its exact command. For
     production SQL: the transfer run, this one-shot's `--phase inspect`, the named
     `--phase apply` run (migration key, workstream id, commit), and the
     record-and-retire change.
2. **The owner approves that named list once, for this workstream.** The approval names
   the workstream id and the production runs it covers. For each production apply, the
   operator passes the owner's exact words as `--approval-statement` (or `-b64`), and that
   run's migration key as `--approval-scope`.
3. **The `execute: true` pin change is never part of what the operator self-approves.**
   It is its own reviewed PR, which the owner reviews and merges. The bundle may list it
   as a step, but the operator only opens it and then waits for the owner's merge. Until
   that merge is on main and staged by the transfer workflow, step 1 of the one-shot
   refuses. A read-only `--phase inspect` may run before the apply approval; the apply
   itself runs only for a run the owner named.
4. **The operator runs the list end to end, and stops and returns to the owner on any
   of these:**
   - a hash that differs from the list (source, tarball, live pre-state, after-state);
   - a guard refusal: `DEPLOYMENT_COLLISION`, `SOURCE_RECONCILIATION_REQUIRED`,
     `SOURCE_COMPOSITION_REQUIRED`, or any other refusal code;
   - a failed check, contract or inspect condition;
   - anything that is not on the list, including a new step, a changed command or a
     different target.

   A stop is never worked around, retried with different inputs, or "fixed forward"
   without returning to the owner.

This agreement **does not change the rules in `AGENTS.md`**:

- Production still requires explicit owner approval for **this** workstream plus the
  pin's staging acceptance reference.
- An approval never carries over from an earlier workstream or bundle.
- Receipts come only from `preflight.mjs`; hand-written receipt JSON is `RECEIPT_FORGED`.
- No environment variable bypasses the guard.
- A pin with `execute: false` still refuses.
