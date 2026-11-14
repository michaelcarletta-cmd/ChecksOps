# Production SQL 166 (the Mortgage Desk agent switches the loss draft between Monitored and Not Monitored)

| key | file | what it does |
|---|---|---|
| `sql166` | `aws/workflows/sql/166_mortgage_desk_set_monitoring.sql` (sha256 `632a258a90742fc6f30c206533624e72b295c5d0d87ad8d85d1a5a920d3e71d5`, authored by `864d41dc6`) | Refuses without its prerequisites (`55000 sql166_prerequisite_missing`) or unless the applying login can reach `check_messages`, `loss_draft_audit_log`, `loss_draft_tracking` and `mortgage_handling_requests` past RLS (`55000 sql166_definer_cannot_reach`); then one new SECURITY DEFINER function, EXECUTE `checksops` and the owner only. |

**Why.** Owner 2026-11-14: "Mortgage agent needs to be able to change the claim from monitor to not monitored, so the
tenants see that type of update." Owner answers the same day: only while the request is in progress; switching to Not
Monitored when escrow or draws are recorded is allowed with a warning (the function must not refuse it, it returns a
flag so the Desk page can warn); the tenant sees a check-thread message; a check with no loss-draft file is refused.

- `loss_draft_tracking.monitoring_type` (`monitored` / `not_monitored`, default `monitored`; one row per check through
  the unique `idx_loss_draft_check_id`) is the field. Tenants set it with `loss_draft_action set_monitoring_type`
  (`aws/functions/api/workflow-rpc.mjs`), which also writes a `loss_draft_audit_log` row.
- A mortgage agent cannot: the write policy `aws_write_loss_draft_tracking` is `aws_can_write_check` (tenant members
  only; `aws/rls/sql/24_complete_write_policies.sql`), and `check_messages` and `loss_draft_audit_log` are member-scoped
  too. As in SQL 122, no policy or table grant changes; a SECURITY DEFINER function checks the caller itself.

**What it does.** `public.aws_mortgage_desk_set_monitoring(_request_id uuid, _monitoring_type text) RETURNS jsonb`,
plpgsql, VOLATILE, SECURITY DEFINER, `SET search_path = public, pg_temp` (no `row_security` setting, as SQL 122):
- the gate is SQL 122's `aws_mortgage_desk_working_request(_request_id, ARRAY['in_progress'])` (the assigned mortgage
  agent holding `mortgage_agent`, or the platform owner; the request `in_progress` with a check, locked FOR UPDATE;
  `42501 not_authorized` / `not_assigned_to_you` / `request_not_in_status` or `22023 request_has_no_check` otherwise);
- the type is `monitored` or `not_monitored` (trimmed, lower-cased), else `22023 invalid_monitoring_type`;
- the check is the request's `check_intake_item_id`; its `loss_draft_tracking` row is locked FOR UPDATE; none:
  `22023 request_has_no_loss_draft`; `escrow_status` `endorsing` or `final_release_complete` (the closed statuses,
  `CLOSED_LOSS_DRAFT_STATUSES` in `workflow-rpc.mjs`): `42501 loss_draft_closed`;
- `escrow_or_draws_recorded`: `total_escrowed`, `draw_amount_requested`, `draw_amount_released` or `holdback_amount`
  above 0, `draw_stage` above 0, or `escrow_status` `escrowed`, `first_draw_requested` or `partial_release` (what
  `mark_escrowed`, `request_draw`, `record_release` and `record_holdback` write). It never refuses the switch;
- unchanged type: nothing written; `{ok: true, changed: false, monitoring_type, request_id, loss_draft_id,
  escrow_or_draws_recorded}`;
- otherwise `monitoring_type` and `updated_at = now()`; one `loss_draft_audit_log` row (action `set_monitoring_type`,
  actor the caller, no amount, notes the message, old and new `{escrow_status, monitoring_type, total_escrowed,
  draw_amount_released, holdback_amount}` with the amounts as text, the shape `loss_draft_action` writes); one
  `check_messages` row on the check from the caller (the columns SQL 122's `aws_mortgage_desk_post_message` writes):
  "ChecksOps Mortgage Desk changed this loss draft to Not Monitored." or "ChecksOps Mortgage Desk changed this loss
  draft to Monitored."; returns `{ok: true, changed: true, monitoring_type, previous_monitoring_type, request_id,
  loss_draft_id, message_id, escrow_or_draws_recorded}`.

Not changed: no existing function is replaced (SQL 122's gate keeps its body and ACL); no table, column, policy, table
grant, trigger or row is changed by the apply. The db-readonly-validate trigger count is not affected. The tenant's own
`set_monitoring_type` and every escrow and draw action are unchanged. No API, Lambda or SPA change is part of this pin:
the Desk API action and the Desk page's switch and warning ship afterwards through their own guarded paths.

**Status:** applied in staging (wave 58, 2026-11-14, apply run 43627727453); staging acceptance: the staging apply under the owner's run approval ("apply SQL 166 and SQL 167 in staging"; no separate acceptance statement); applied to production (2026-11-14); the production pin is retired (`execute: false`).

**Staging read-live (2026-11-14).** Run 43623201872 (main `3239508c`, after executor inspect run 43622613027 and executor deploy
run 43622915623 (executor CodeSha256 `BGu9krtX…` -> `4gH9sgaz…`)), under the owner's words "apply SQL 166 and SQL 167 in
staging": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`; the function absent. Live
`11a10b33e6a5a46ea98934487cd9e941ddfe6b232ca6c7d4debad8c2f033f608`, equal to the derived pre-state; intended `5c8e030f…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 58). The staging apply is a separate run after this pin is merged and
the executor is redeployed carrying it, on the owner's words for that run. The production pin stays pending.

**Staging executor refreshed and staging apply (2026-11-14).** The staging pins for SQL 166 and SQL 167 (waves 58 and 59, PR
#1908, owner's words "merge #1908") merged as `84dd7e5492e911aee336282a6262888965fd6659`. Deploy run 43626936092 updated the staging guarded SQL executor
(CodeSha256 `4gH9sgaz…` -> `0KNPXGrb…`); a fresh read-live, run 43627497816, read `11a10b33…`. Apply run 43627727453 (main
`84dd7e5`) under the owner's words "apply SQL 166 and SQL 167 in staging": `before_hash` `11a10b33e6a5a46ea98934487cd9e941ddfe6b232ca6c7d4debad8c2f033f608`, `after_hash`
`5c8e030f32fdfbaf892a7496a5b5c71c02aca0b6494cf04b9e62ab71e3534e9e` (the intended hash). Read-live run 43627956591: `already_applied` true. The owner gave the run
approval "apply SQL 166 and SQL 167 in staging"; no separate staging acceptance statement was given. There is no separate
staging record PR for SQL 166: these staging runs are recorded here and in the production pin's `staging_acceptance` by the
production pin PR.

**Production inspect (2026-11-14).** Read-only `--inspect` through SSM `6b4e6de5-3548-4477-927c-bcbda4a11391` on
`i-0c35557c4e5385406` (under the owner's words "run the SQL 166 and SQL 167 production inspect"; runner started from stopped
with no SSM command in progress, command 18:54:51Z to 18:55:02Z, AWS-RunShellScript, Success, runner stopped again afterwards,
all by `user/claude-code`; the same command ran SQL 167's `--inspect`, recorded in `ops/production-sql-167-apply.md`), main
`84dd7e549` (tarball sha256 `f7965818d5b9d95284f125c9fded2fde1c50f3702d24a036e03e5aac68767c03`, checked by `sha256sum -c` on the runner, `SOURCE_COMMIT` matched, staged by
`sql53-temporary-transfer.yml` run 43629060749; sha256 of the printed sql166 output, computed on the runner,
`02226b4e6a40e408c328669916d22e43ca0827f453feaff929bdfabbeb52e56d`, 2222 bytes), exit 0, `ok` true, `read_only` true, `current_user` `checksops_admin`,
`missing_dependencies` `[]`: live `11a10b33e6a5a46ea98934487cd9e941ddfe6b232ca6c7d4debad8c2f033f608` (the function absent: the derived pre-state, equal to staging's
before its apply), no predecessor, `prerequisites_missing` `[]`, `successors_applied` `[]`, `definer_writes` ok on
`check_messages`, `loss_draft_audit_log`, `loss_draft_tracking` and `mortgage_handling_requests`, `already_applied` false,
`precondition_failures` `[]`, `apply_preconditions_met` false (no pre-state recorded yet). Production's pre-state equals
staging's (read-live runs 43623201872 and 43627497816), so the staging apply took the path production will. Recorded in the
production pin with the staging apply (run 43627727453) as its staging acceptance and `execute: true` under the owner's "Yes"
to "Shall I open the pin PR?". The owner merges the pin change; the apply runs only after that merge is on main and staged,
under the owner's words for that run (phrase `LET_MORTGAGE_DESK_SWITCH_LOSS_DRAFT_MONITORING`).

Production authorization phrase (pin `authorization_phrase`): `LET_MORTGAGE_DESK_SWITCH_LOSS_DRAFT_MONITORING`.

**Production apply (2026-11-14).** After the pin change (#1909, merged to main as `d8da56bac`), transfer run 43632903546
(`sql53-temporary-transfer.yml`) staged main `d8da56bac` (tarball sha256
`b2d3cadcfea1a2c9681de708d4546f5bc3e7506a72395b3c1f3516617c149774`, checked by `sha256sum -c` on the runner; `SOURCE_COMMIT`
matched). Three AWS-managed SSM commands were listed InProgress on the stopped runner, queued at 18:55Z during the
production inspect `6b4e6de5`: `d1da09c7` AmazonInspector2-ConfigureInspectorSsmPlugin (Success), `007bb4e8` AWS-ConfigureAWSPackage (Success), `36b774e3` AmazonInspector2-ConfigureInspectorSsmPluginLinux (Failed); on the owner's words "Let them finish first" the runner was started and no SQL
command was sent until nothing was in progress (60 s). Under the owner's words "apply SQL 166 and SQL 167 in production" (passed verbatim to
this run and to SQL 167's, in the same runner session), on `i-0c35557c4e5385406` (root volume 39% used): one-shot `--phase inspect`
(SSM `d82a9d0b-4f11-48cc-b4eb-f46417374112`, Success, exit 0, steps pin, source, inspect and contracts ok, nothing written) read live
`11a10b33…` (`live_matches_expected` true, `already_applied` false, `precondition_failures` `[]`); the apply command
was sent only after that. Then `--phase apply` (SSM `a4f2aed0-51ce-4444-8387-1fff041fd4ef`, Success, exit 0, run
`cca3fb1a-8d24-45b5-838d-5ec0e2e73bfd`, workstream `prod-sql166-desk-set-monitoring-20261114`, one_use_id
`sql166-prod-9a437e99-306b-46b6-968e-2a0cb7cca1ec`): contracts 4/4, 6/6 and 43/43; all 11 steps ok; manifest
`3cd2a81b…`; receipt `11a10b33…` → `5c8e030f32fdfbaf892a7496a5b5c71c02aca0b6494cf04b9e62ab71e3534e9e` (intended), result `applied`,
unrelated catalog `35637555…`; post-apply inspect `already_applied` true, `precondition_failures` `[]`,
`aws_mortgage_desk_set_monitoring(uuid, text)` `intended` with EXECUTE `[checksops EXECUTE, owner EXECUTE]`. The run's whole output arrived (20538 bytes, sha256
`1f002c3ec60407388070921661f03920bbb48795dfac5a4051e4529768d43d83`; read back in compact form and re-serialized to that same size and
sha256; the copy on the runner was removed afterwards). A process check after each apply found no one-shot running and the runner
was stopped afterwards. Recorded in the pin's `applied` and `production_evidence`; `execute` is false again. Production
acceptance (a Mortgage Desk user switching loss-draft monitoring) had not been reported by the owner when this record was written; this record does not claim it.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql166` in
`release-sql-specs.mjs`). Intended `5c8e030f32fdfbaf892a7496a5b5c71c02aca0b6494cf04b9e62ab71e3534e9e`:

```
release sql166 v1
function public.aws_mortgage_desk_set_monitoring(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=d30abdb6fc8b72300e57ec227d976ab6127ab3632f68a57402b8575ca05fa52b acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The function absent:

```
release sql166 v1
function public.aws_mortgage_desk_set_monitoring(uuid, text): absent
```

That is `11a10b33e6a5a46ea98934487cd9e941ddfe6b232ca6c7d4debad8c2f033f608` (`releaseStateHash('sql166', {})`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `function_acl_replaceable`, `functions_owned_by_login` and `function_results_match` (where
present); `definer_can_write_relations` on `check_messages`, `loss_draft_audit_log`, `loss_draft_tracking` and
`mortgage_handling_requests` (the DEFINER function must reach them past RLS as their owner; filtered by RLS it would
find no loss draft and write nothing).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps (each its own reviewed PR or owner-approved run)

1. Staging read-live (`guarded-staging-sql-executor.yml`, choice `sql166-mortgage-desk-set-monitoring`), then the staging pin PR and the staging apply.
2. Production read-only inspect: `production-sql-one-shot.mjs --migration sql166 --phase inspect` (`ops/production-sql-one-shot.md`).
3. Production pin PR: record `production_inspect` and `staging_acceptance`, set `execute: true`; the owner merges it.
4. Production apply: `--phase apply` with the owner's exact words.
5. Record PR: the `applied` block, `execute: false`.
