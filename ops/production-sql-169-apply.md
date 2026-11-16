# Production SQL 169 (deleting a check keeps its ChecksOps charges)

| key | file | what it does |
|---|---|---|
| `sql169` | `aws/workflows/sql/169_check_billing_events_keep_charge_on_check_delete.sql` (sha256 `df8f8e35b5a7df1ae30f7330d9b0665cc08036ef92895a771ca7d03929a8970f`, authored by `70af8044a`) | Refuses without its prerequisites (`55000 sql169_prerequisite_missing`), when `check_billing_events.check_intake_item_id` is NOT NULL (`55000 sql169_column_not_nullable`) or the key on that column is not exactly the Supabase CASCADE key (`55000 sql169_unexpected_foreign_key`); then replaces `check_billing_events_check_intake_item_id_fkey` with the same key `ON DELETE SET NULL`. |

**Why.** Owner 2026-11-16: two checks could not be deleted. One was refused with "This check cannot be deleted because
it has dependent financial/provider records (check_billing_events)" (the other names `deposit_items`, a deposited check,
which stays refused). Asked what a delete of a check that has a ChecksOps charge should do, the owner chose "Delete, keep
charge (Recommended)": the check is removed and its charge stays in billing history, unlinked from the deleted check.
Today the delete-check API (`aws/functions/api/workflow-delete-check.mjs` `FINANCIAL_DELETE_BLOCKERS`,
`aws/functions/api/workflow.mjs`) refuses any check with a `check_billing_events` row, and the database could not keep the
row anyway: `check_billing_events.check_intake_item_id` references `check_intake_items(id)` `ON DELETE CASCADE` (the
inline `REFERENCES` of `supabase/migrations/20260501204336_0cf22f8b-4276-451b-a50c-69a58bbdb5a1.sql`, so the key is named
`check_billing_events_check_intake_item_id_fkey`), and deleting the check would delete its charges.

**What it does.**
- Accepted predecessor: exactly one foreign key on `check_billing_events (check_intake_item_id)`, named
  `check_billing_events_check_intake_item_id_fkey`, `FOREIGN KEY (check_intake_item_id) REFERENCES
  public.check_intake_items(id) ON DELETE CASCADE`. The column must be nullable (Supabase dropped its NOT NULL in
  `20260605163443`); a NOT NULL column refuses rather than being changed here. The key is compared on `pg_constraint`
  (referenced table and column, `confdeltype` `c`, ON UPDATE NO ACTION, MATCH SIMPLE, not deferrable, validated), not on
  `pg_get_constraintdef`'s text, whose rendering of the referenced table depends on the session's `search_path`.
- Drops that key and adds it again under the same name `ON DELETE SET NULL`. Adding it validates the existing rows, which
  the old key already held to the same rule.
- Idempotent: an already `ON DELETE SET NULL` key is left as it is (`sql169_foreign_key_already_current`).

After it, deleting a check sets `check_intake_item_id` NULL on that check's `check_billing_events` rows; every other
column (`tenant_id`, `claim_id`, `event_type`, `status`, amounts, `payment_transfer_id`, `source_kind`/`source_id`)
stays. The key's action runs as the owner of `check_billing_events`, past its RLS (the table is not FORCE ROW LEVEL
SECURITY; SQL 136's restrictive write gates do not apply to it). No CHECK constraint requires the column; the unique
indexes on it (SQL 84 `one_mortgage_ops_per_check`, SQL 98 `check_event_uidx`, SQL 153
`one_second_mortgagee_per_check`) treat NULL as distinct or are partial on `IS NOT NULL`; SQL 154's
`aws_check_billing_event_starter_package` fires on INSERT or `UPDATE OF status` only. The billing engine
(`tenant-billing-engine.mjs`) reads charges with `LEFT JOIN check_intake_items`, so an unlinked charge still counts.

**Not changed:** no other constraint, column, index, trigger, function, policy, RLS setting, grant or row. The API keeps
refusing the delete of a charged check until its own later step (a Lambda overlay of the delete-check code that drops
`check_billing_events` from the blockers and records the check's charges in `check_deletion_log`), which ships only after
this pin is applied in production. No API, Lambda or SPA change is part of this pin. Deposits, CheckAlt deposits,
disbursements, payments and payment directions keep blocking a delete.

**Status:** applied in staging (wave 61, 2026-11-16, apply run 43923431127); staging acceptance: the staging apply under the owner's run approval ("apply SQL 169 in staging"; no separate acceptance statement); applied to production (2026-11-16); the production pin is retired (`execute: false`). Deleting a charged check in the app is not part of this record: the delete-check API still lists `check_billing_events` as a blocker until its own later step (a guarded Lambda overlay of `workflow-delete-check.mjs`).

**Staging read-live (2026-11-16).** Run 43919046029 (main `294055a93`, after executor inspect run 43917310640 and executor deploy
run 43917926456 (executor CodeSha256 `aU0HiKBL…` -> `DA2QdHRx…`)), under the owner's words "apply SQL 169 in staging":
`already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`; the ON DELETE CASCADE key. Live
`f7530ea5e4b9ff3d8dc74911ffeadfe9b38dd6fd867ca3edacbc9ec65c8c4a40`, equal to the derived pre-state; intended `30fc8ed4…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 61). The staging apply is a separate run after this pin is merged
and the executor is redeployed carrying it, on the owner's words for that run. The production pin stays pending.

**Staging executor refreshed and staging apply (2026-11-16).** The staging pin for SQL 169 (wave 61, PR #1948, owner's words
"merge the SQL 169 staging pin PR") merged as `96981921a14678e8c7dfe5ec56c29e09f8972e55`. Executor inspect run 43921911783 read `DA2QdHRx…` (not current);
deploy run 43922432721 updated the staging guarded SQL executor (CodeSha256 `DA2QdHRx…` -> `8i2ZsahmH…`; inspect run 43922950607
`EXECUTOR_CURRENT` true). Apply run 43923431127 (main `96981921a`) under the owner's words "apply SQL 169 in staging": `before_hash`
`f7530ea5e4b9ff3d8dc74911ffeadfe9b38dd6fd867ca3edacbc9ec65c8c4a40`, `after_hash` `30fc8ed4927c599b9f320ec07a2e535eaa07f86b55b5180a937c1d405dc19969` (the intended hash), `result` applied. Read-live run 43923909951:
`already_applied` true, `precondition_failures` `[]`. The owner gave the run approval "apply SQL 169 in staging"; no separate staging
acceptance statement was given. There is no separate staging record PR for SQL 169: these staging runs are recorded here and in the
production pin's `staging_acceptance` by the production pin PR.

**Production inspect (2026-11-16).** Read-only `--inspect` through SSM `29ddf3f2-9ca8-467d-8877-a84e95294f14` on
`i-0c35557c4e5385406` (under the owner's words "run the SQL 169 production inspect"; runner started from stopped with no SSM
command in progress, command 18:03:22Z to 18:03:29Z, AWS-RunShellScript, Success, runner stopped again afterwards, all by
`user/claude-code`), main `96981921a` (tarball sha256 `d6a952e92abb572f1de5af8cb34926b0a282ade76d16b05e634e36e995340ac5`, checked by `sha256sum -c` on the
runner, `SOURCE_COMMIT` matched, staged by `sql53-temporary-transfer.yml` run 43924507724; sha256 of the printed sql169 output,
computed on the runner, `90d36f6e036643aeb2f71b1c2f39a7290ca94d8022f432dd35a998bef0368352`, 1814 bytes), exit 0, `ok` true, `read_only` true, `source_ok` true,
`current_user` `checksops_admin`, `predecessors_applied` true: live `f7530ea5e4b9ff3d8dc74911ffeadfe9b38dd6fd867ca3edacbc9ec65c8c4a40` (the ON DELETE CASCADE key:
the derived pre-state, equal to staging's before its apply), no predecessor, `prerequisites_missing` `[]`, `successors_applied` `[]`,
`already_applied` false, `precondition_failures` `[]`, `apply_preconditions_met` false (no pre-state recorded yet). Production's
pre-state equals staging's (read-live run 43919046029 and the staging apply's `before_hash`), so the staging apply took the path
production will. Recorded in the production pin with the staging apply (run 43923431127) as its staging acceptance and
`execute: true` under the owner's words "open the SQL 169 production pin PR". The owner merges the pin change; the apply runs only
after that merge is on main and staged, under the owner's words for that run (phrase `KEEP_CHARGES_WHEN_CHECK_IS_DELETED`).

**Not verified by the inspect** (it fingerprints only the foreign key): whether `public.check_billing_events.check_intake_item_id`
is nullable on production (the file refuses with `sql169_column_not_nullable` at apply time if it is NOT NULL, applying nothing)
and whether `checksops_admin` owns `check_billing_events` (the apply engine refuses if it does not).

**Production apply (2026-11-16).** After the pin change (#1949, merged to main as `6641007ab` on the owner's words "merge the SQL 169
production pin PR"), transfer run 43930251982 (`sql53-temporary-transfer.yml`) staged main `6641007ab` (tarball sha256
`20b86c779cb709b2a6c7b09a2cd17c0ebbd00897b0c55c5330f57e29530107bd`, checked by `sha256sum -c` on the runner; `SOURCE_COMMIT`
matched). Three AWS-managed SSM commands were listed InProgress on the stopped runner, queued at 18:03Z during the
production inspect `29ddf3f2`: `23a4d3b2` AmazonInspector2-ConfigureInspectorSsmPluginLinux (Success), `4eb94d50` AmazonInspector2-ConfigureInspectorSsmPlugin (Success), `3effe72b` AWS-ConfigureAWSPackage (Success); as for SQL 166 and SQL 167, the runner was started and no SQL
command was sent until nothing was in progress (20 s). Under the owner's words "apply SQL 169 in production KEEP_CHARGES_WHEN_CHECK_IS_DELETED" (passed verbatim to
this run), on `i-0c35557c4e5385406` (root volume 39% used): one-shot `--phase inspect`
(SSM `40b64605-6154-413e-abbd-78cdc6643f51`, Success, exit 0, steps pin, source, inspect and contracts ok, nothing written) read live
`f7530ea5…` (`live_matches_expected` true, `already_applied` false, `precondition_failures` `[]`); the apply command
was sent only after that. Then `--phase apply` (SSM `9c92cb54-fc92-47b0-9fa1-cb7764b2f992`, Success, exit 0, run
`d64ba504-e0e3-42ea-92d4-57ae4af26008`, workstream `prod-sql169-keep-charge-on-delete-20261116`, one_use_id
`sql169-prod-91223610-db3b-4249-b7b3-59502f378d5d`): contracts 4/4, 6/6 and 43/43; all 11 steps ok; manifest
`863032d4…`; receipt `f7530ea5…` → `30fc8ed4927c599b9f320ec07a2e535eaa07f86b55b5180a937c1d405dc19969` (intended), result `applied`,
unrelated catalog `9f8eca61…`; post-apply inspect `already_applied` true, `precondition_failures` `[]`,
`check_billing_events_check_intake_item_id_fkey` `intended` (ON DELETE SET NULL). The run's whole output arrived (17372 bytes, sha256
`9705f1c56c96e5b973ac1d81e203b62efc3abca5fa1399d3bcc35ed537ff581a`; read back in compact form and re-serialized to that same size and
sha256; the copy on the runner was removed afterwards). The two points the production inspect did not verify are inferred from the successful apply, not read
separately: the file's NOT NULL guard did not refuse, so the column is nullable, and the engine's owner check did not refuse. A process check after the apply found no one-shot running and the runner
was stopped afterwards. Recorded in the pin's `applied` and `production_evidence`; `execute` is false again. Production
acceptance had not been reported by the owner when this record was written; this record does not claim it. Deleting a charged
check in the app needs the later delete-check API step; it is not part of this record.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql169` in
`release-sql-specs.mjs`). Intended `30fc8ed4927c599b9f320ec07a2e535eaa07f86b55b5180a937c1d405dc19969`:

```
release sql169 v1
constraint public.check_billing_events check_billing_events_check_intake_item_id_fkey: d6523e17cdce05714035bb7536a75e35c7d2956c5aaecda43e36da9aa69578ac validated=true
```

**Expected pre-state (both environments).** The Supabase CASCADE key, validated:

```
release sql169 v1
constraint public.check_billing_events check_billing_events_check_intake_item_id_fkey: 180134c8a31665696a73bbcb0955d0a2701769cd88c391c619a67cb501210add validated=true
```

That is `f7530ea5e4b9ff3d8dc74911ffeadfe9b38dd6fd867ca3edacbc9ec65c8c4a40` (`releaseStateHash('sql169', …)` of that
key). Each pin records its own environment's read; neither value is written into a pin before a run reads it. A
pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`check_billing_events`, `check_intake_items`, `check_billing_events.check_intake_item_id`,
`check_intake_items.id`); `altered_relations_owned_by_login` on `check_billing_events` (the table that holds the key).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 169 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql169-check-billing-events-keep-charge-on-check-delete`.
   Expected `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, live `f7530ea5…`.
   Otherwise stop. Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved
   `authorization`, `execute: true`, wave 61) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql169 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql169
   --approval-scope sql169 … --phase apply` with the owner's words (authorization phrase
   `KEEP_CHARGES_WHEN_CHECK_IS_DELETED`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API: the delete-check change (staging overlay, then production with the owner's words), its own PRs.

Rollback (not part of this pin; a reviewed step of its own if ever needed): replace the key with the CASCADE one again.
Charges already unlinked by deletes stay unlinked.
